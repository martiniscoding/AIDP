"""Analyse stage — the product.

Retrieval runs backwards from the usual shape. The reference clause is the
query, not the user: for each of the ~120 clauses in a customer's framework this
searches the submitted design and classifies what it finds. Nobody types a
question.

Two properties the rest of the pipeline does not need:

**Resumable.** A run is a hundred-odd model calls and takes minutes. Findings
are committed one at a time, so a worker that dies mid-run is requeued by the
reaper and picks up at the clause after the last one written, rather than
starting again and paying for it twice.

**Guarded against false certainty.** The model's verdict is not taken at face
value. A "covered" that cites no evidence, or an "absent" reached on top of weak
retrieval, is demoted to `needs_review` — because in a compliance tool a wrong
"absent" sends someone to fix what already exists, and a wrong "covered" ships a
gap into production.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from psycopg.types.json import Jsonb

from .. import db, decisions, logs, queue, retrieval, usage, whole_document
from ..ai import llm
from ..config import get_config
from ..queue import Job
from . import embed as embed_stage

log = logs.get(__name__)

VERDICTS = ("covered", "partial", "absent", "contradicts", "needs_review")

# Verdicts that assert something about the submitted document, and so must point
# at a passage in it.
CITING_VERDICTS = ("covered", "partial", "contradicts")

# Verdicts that close a question. These are the ones a diagram description must
# not reach on its own.
DECISIVE_VERDICTS = ("covered", "contradicts")

# How many standing decisions reach the prompt. This runs once per clause over a
# hundred-odd clauses, so an uncapped register would land on every run's bill.
PRECEDENTS = 3

# Below this fused RRF score the best candidate is not meaningfully related to
# the clause, and any confident verdict on top of it is guesswork. Two ranked
# lists agreeing at rank ~1 score around 1/(60+1) * 2 ≈ 0.033; a single list at
# rank 8 scores ≈ 0.015.
WEAK_RETRIEVAL = 0.018

# An "absent" this uncertain is a question, not an answer.
MIN_ABSENT_CONFIDENCE = 0.55

# How many passages the judge sees per clause. Wide enough that a requirement
# split across two sections is still visible; narrow enough that the model is
# not asked to read the whole document for every clause.
CANDIDATES = 8


def handle(job: Job, heartbeat) -> None:
    run_id = job.payload.get("runId")
    if not run_id:
        raise RuntimeError("analyse job has no runId in its payload")

    if not llm.available():
        raise RuntimeError(
            "no model API key configured — assessment needs one to reach a verdict"
        )

    with db.connection() as conn:
        run = db.one(conn, 'SELECT * FROM "assessment_run" WHERE "id" = %s', (run_id,))
        if run is None:
            raise RuntimeError(f"assessment run {run_id} no longer exists")
        clauses = _framework_clauses(conn, run["frameworkId"])
        # What the submitted document is, read once per run. The same string
        # for every clause, so fetching it inside the loop would be a hundred
        # round trips for one column.
        submission = db.one(
            conn, 'SELECT "summary" FROM "document" WHERE "id" = %s', (run["documentId"],)
        )
        document_context = (submission or {}).get("summary") or ""
        done = {
            r["clauseId"]
            for r in db.query(
                conn, 'SELECT "clauseId" FROM "finding" WHERE "runId" = %s', (run_id,)
            )
        }

    if not clauses:
        _fail(run_id, "The framework contains no clauses. Ingest a reference document first.")
        raise RuntimeError("framework has no clauses")

    # Before any retrieval. A document embedded under an earlier embedding model
    # has no vectors that search can see, and a clause judged on an empty
    # search reads as absent. See `embed.embed_missing`.
    healed = embed_stage.embed_missing(run["documentId"], heartbeat)
    if healed:
        logs.info(log, "embedded missing chunks before assessing", runId=run_id, chunks=healed)

    mode, note, whole = _resolve_mode(run)

    pending = [c for c in clauses if c["id"] not in done]
    _start(
        run_id,
        total=len(clauses),
        completed=len(done),
        model=llm.model_name()[1],
        mode=mode,
        note=note,
    )
    logs.info(
        log,
        "assessment started",
        runId=run_id,
        mode=mode,
        clauses=len(clauses),
        resuming=len(done),
        pending=len(pending),
    )
    if note:
        logs.warn(log, "whole-document assessment fell back to search", runId=run_id, reason=note)

    if whole is not None:
        logs.info(log, "reading the whole document", runId=run_id, tokens=whole.tokens)
    elif document_context:
        logs.info(log, "submission context in scope", runId=run_id, chars=len(document_context))
    else:
        logs.warn(log, "no submission summary — verdicts reached without document context")

    for index, clause in enumerate(pending, start=1):
        if whole is not None:
            _assess_document_one(run, clause, whole, document_context)
        else:
            _assess_one(run, clause, document_context)
        heartbeat()
        # Every clause, not every fifth. A clause takes around fifteen seconds,
        # so batching the write held the progress bar still for over a minute at
        # a time — long enough that a run in perfect health reads as a hung one,
        # which is what a progress bar exists to rule out. The cost is one small
        # UPDATE per clause against a row already in cache, spaced fifteen
        # seconds apart; the model call beside it dwarfs it.
        _progress(run_id, len(done) + index)

    # "Compare both": this run is done, and the other mode's run is opened in
    # the same transaction and carried on by this same job. See
    # `_complete_and_follow` for why they cannot both be queued up front.
    follow = job.payload.get("then")
    if follow in MODES:
        next_id = _complete_and_follow(job, run, len(clauses), follow)
        attribution = usage.current()
        if attribution is not None:
            usage.bind(replace(attribution, run_id=next_id))
        handle(replace(job, payload={"runId": next_id}), heartbeat)
        return

    _complete(job, run_id)


def _framework_clauses(conn, framework_id: str) -> list[dict]:
    """Every clause in the framework, in document then reading order.

    Reads through the join rather than by document id so that adding a document
    to a framework is the only thing needed to bring its clauses into scope.
    """
    return db.query(
        conn,
        """
        SELECT cl."id", cl."title", cl."statement", cl."rationale",
               cl."requirements", cl."guidance",
               s."headingPath", s."numberText", s."pageStart",
               d."title" AS "documentTitle", f."isBaseline"
          FROM "framework_document" fd
          JOIN "framework" f  ON f."id" = fd."frameworkId"
          JOIN "document" d   ON d."id" = fd."documentId"
          JOIN "document_section" s ON s."documentId" = d."id"
          JOIN "clause" cl    ON cl."sectionId" = s."id"
         WHERE fd."frameworkId" = %s
         ORDER BY fd."sortOrder", d."title", s."ordinal", cl."ordinal"
        """,
        (framework_id,),
    )


@dataclass
class _Judged:
    """A verdict after its guards, not yet written."""

    verdict: str
    confidence: float
    rationale: str
    evidence: list[dict]
    applied: list[dict]
    best: float


def _assess_one(run: dict, clause: dict, document: str = "") -> None:
    """Retrieve, judge, guard, commit — one clause, one transaction."""
    query = retrieval.clause_query(
        clause["statement"], clause["requirements"] or [], clause["title"]
    )

    # One embedding for the clause, shared by both lookups below. They search
    # different tables with the same question, and paying for it twice would
    # double the embedding bill of every run.
    vector = retrieval.embed_query(query)
    precedents = _precedents(run, clause, query, vector)
    judged = _judge_by_search(
        run, clause, query=query, vector=vector, precedents=precedents, document=document
    )
    _write(
        run["id"],
        clause,
        verdict=judged.verdict,
        confidence=judged.confidence,
        rationale=judged.rationale,
        evidence=judged.evidence,
        retrieval_score=judged.best,
        applied=judged.applied,
    )


def _precedents(run: dict, clause: dict, query: str, vector: str) -> list:
    """What this organisation has already settled about this clause."""
    with db.connection() as conn:
        return decisions.for_clause(
            conn,
            organisation_id=run["organisationId"],
            clause_ref=str(clause["numberText"] or clause["headingPath"] or ""),
            query=query,
            limit=PRECEDENTS,
            vector=vector,
        )


def _applied(precedents: list, claimed: list[str]) -> tuple[list[dict], list[str]]:
    """(decisions the model applied that it was given, ids it invented).

    Only decisions that were actually in the prompt count. A model naming an id
    it was never given has invented a precedent, which is worse than having
    none: a fabricated policy citation in a compliance report.
    """
    offered = {d.id: d for d in precedents}
    applied = [
        {"id": d.id, "title": d.title, "effect": d.effect}
        for cid in claimed
        if (d := offered.get(cid))
    ]
    return applied, [cid for cid in claimed if cid not in offered]


def _judge_by_search(
    run: dict,
    clause: dict,
    *,
    query: str,
    vector: str,
    precedents: list,
    document: str = "",
) -> _Judged:
    """The passages a search finds for the clause, judged and guarded.

    The whole of a retrieval-mode assessment, and the second opinion a
    whole-document assessment asks for before it will call anything absent.
    """
    reference = f"{clause['documentTitle']} — {clause['headingPath']}"
    with db.connection() as conn:
        candidates = retrieval.search_document(
            conn,
            organisation_id=run["organisationId"],
            document_id=run["documentId"],
            query=query,
            limit=CANDIDATES,
            vector=vector,
        )

    best = candidates[0].score if candidates else 0.0

    if not candidates:
        # Nothing in the submitted document at all. Only reachable when it has
        # no chunks, which the caller should have prevented.
        return _Judged(
            "needs_review", 0.0, "No content was retrieved from the submitted document.",
            [], [], 0.0,
        )

    try:
        raw = llm.judge(
            reference=reference,
            clause=_render_clause(clause),
            extracts=_render_extracts(candidates),
            precedents=decisions.render(precedents),
            document=document,
        )
    except Exception as exc:  # noqa: BLE001 — one clause must not sink the run
        logs.warn(log, "judge failed for clause", clauseId=clause["id"], error=str(exc)[:200])
        return _Judged(
            "needs_review",
            0.0,
            f"The model could not be reached for this clause: {str(exc)[:160]}",
            [],
            [],
            best,
        )

    verdict, confidence, rationale, cited, claimed = _normalise(raw)
    by_id = {c.chunk_id: c for c in candidates}
    generated = {c.chunk_id for c in candidates if c.is_generated}
    evidence = [
        {
            "chunkId": c.chunk_id,
            "headingPath": c.heading_path,
            "page": c.page_start,
            "excerpt": c.excerpt,
            # Carried so a reviewer can see what a claim actually rests on. A
            # figure-derived passage renders with the diagram beside it; a
            # quotation from the page does not need one.
            "sourceKind": c.source_kind,
            "figureId": c.source_id if c.is_generated else None,
        }
        for cid in cited
        if (c := by_id.get(cid))
    ]

    applied, fabricated = _applied(precedents, claimed)

    verdict, rationale = _guard(
        verdict, confidence, evidence, best, rationale, cited_generated=set(cited) & generated,
        cited_total=len([c for c in cited if c in by_id]),
        fabricated=fabricated,
        conflicted=decisions.conflicting(precedents),
    )
    return _Judged(verdict, confidence, rationale, evidence, applied, best)


# ---------------------------------------------------------------------------
# Whole-document mode
# ---------------------------------------------------------------------------

MODES = ("retrieval", "document")

# Quotes checked per verdict. A reply quoting more than this is padding, and
# every quote is a search through the whole document.
MAX_QUOTES = 8


def _resolve_mode(run: dict) -> tuple[str, str | None, whole_document.WholeDocument | None]:
    """(mode this run can use, why it is not the one asked for, the document).

    A whole-document run that cannot read the whole document says so and falls
    back to search rather than failing — a report by the older method is worth
    more than none, as long as nobody mistakes which method produced it.
    """
    if (run.get("mode") or "retrieval") != "document":
        return "retrieval", None, None
    with db.connection() as conn:
        row = db.one(conn, 'SELECT "title" FROM "document" WHERE "id" = %s', (run["documentId"],))
        whole = whole_document.load(conn, run["documentId"], (row or {}).get("title") or "")
    if whole is None:
        return (
            "retrieval",
            "Assessed by search, not by reading the whole document: this document was "
            "processed before its pages were stored. Reprocess it, then run the "
            "whole-document assessment again.",
            None,
        )
    limit = get_config().whole_document_max_tokens
    if whole.tokens > limit:
        return (
            "retrieval",
            f"Assessed by search, not by reading the whole document: it is about "
            f"{whole.tokens:,} tokens, more than the {limit:,} a whole-document "
            "assessment reads at once.",
            None,
        )
    return "document", None, whole


def _assess_document_one(
    run: dict,
    clause: dict,
    whole: whole_document.WholeDocument,
    document_context: str = "",
) -> None:
    """Read the whole document, judge, check every quote, commit — one clause.

    Search is not gone from this path; it changes job. It no longer decides what
    the judge sees. It is the second opinion on "absent", the one verdict a
    reading of the whole document can still get wrong without quoting anything.
    That second opinion is given the document summary exactly as a search-mode
    run is, so the two modes' search verdicts on a clause are the same question.
    """
    query = retrieval.clause_query(
        clause["statement"], clause["requirements"] or [], clause["title"]
    )
    reference = f"{clause['documentTitle']} — {clause['headingPath']}"
    vector = retrieval.embed_query(query)
    precedents = _precedents(run, clause, query, vector)

    try:
        raw = llm.judge_document(
            document=whole.text,
            reference=reference,
            clause=_render_clause(clause),
            precedents=decisions.render(precedents),
        )
    except Exception as exc:  # noqa: BLE001 — one clause must not sink the run
        logs.warn(log, "judge failed for clause", clauseId=clause["id"], error=str(exc)[:200])
        _write(
            run["id"],
            clause,
            verdict="needs_review",
            confidence=0.0,
            rationale=f"The model could not be reached for this clause: {str(exc)[:160]}",
            evidence=[],
            retrieval_score=0.0,
            applied=[],
        )
        return

    verdict, confidence, rationale, _, claimed = _normalise(raw)
    evidence, unverified = _checked_quotes(raw, whole)
    applied, fabricated = _applied(precedents, claimed)
    verdict, rationale = _guard_document(
        verdict,
        confidence,
        rationale,
        evidence=evidence,
        unverified=unverified,
        fabricated=fabricated,
        conflicted=decisions.conflicting(precedents),
    )

    score = 0.0
    if verdict == "absent":
        second = _judge_by_search(
            run,
            clause,
            query=query,
            vector=vector,
            precedents=precedents,
            document=document_context,
        )
        score = second.best
        if second.verdict in CITING_VERDICTS and second.evidence:
            verdict = "needs_review"
            rationale = (
                "Reading the whole document found nothing on this clause, but a search of "
                f"the same document found passages judged to address it ({second.verdict}: "
                f"{second.rationale}) One of the two readings missed something — check the "
                f"passages below. Whole-document reading: {rationale}"
            )
            evidence = second.evidence

    _write(
        run["id"],
        clause,
        verdict=verdict,
        confidence=confidence,
        rationale=rationale,
        evidence=evidence,
        retrieval_score=score,
        applied=applied,
    )


def _page_number(value) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _checked_quotes(
    raw: dict, whole: whole_document.WholeDocument
) -> tuple[list[dict], list[tuple[str, str]]]:
    """(evidence from verified quotes, [(quote, why not)] for the rest).

    A verified quote is stored in the same shape as a retrieved passage, so a
    finding renders the same way whichever mode reached it — with the page it
    was actually found on, which is not always the page the model named.
    """
    items = raw.get("evidence") or []
    if not isinstance(items, list):
        items = [items]
    evidence: list[dict] = []
    unverified: list[tuple[str, str]] = []
    for item in items[:MAX_QUOTES]:
        if isinstance(item, dict):
            quote = " ".join(str(item.get("quote") or "").split())
            page = _page_number(item.get("page"))
        else:
            quote, page = " ".join(str(item or "").split()), None
        if not quote:
            continue
        check = whole.verify(quote, page)
        if check.verified:
            pieces = [(quote, check)]
        else:
            # A model sometimes joins two real sentences that are not next to
            # each other into one quote. When every sentence is the document's
            # own, each is kept as its own piece of evidence — never as one
            # passage, which would claim they sit together. One invented
            # sentence refuses the lot.
            split = [(part, whole.verify(part, page)) for part in whole.sentences(quote)]
            pieces = split if len(split) > 1 and all(c.verified for _, c in split) else []
        if not pieces:
            # Logged in full: the finding keeps only the first words, and a
            # quote refused wrongly is a verification bug worth finding.
            logs.warn(
                log,
                "quote not found in the document",
                reason=check.reason,
                page=page,
                quote=quote[:600],
            )
            unverified.append((quote, check.reason))
            continue
        for text, found in pieces:
            evidence.append(
                {
                    "chunkId": f"quote-{len(evidence) + 1}",
                    "headingPath": "",
                    "page": found.page,
                    "excerpt": text[:1500],
                    "sourceKind": "quote",
                    "figureId": None,
                    "claimedPage": page,
                }
            )
    return evidence, unverified


def _guard_document(
    verdict: str,
    confidence: float,
    rationale: str,
    *,
    evidence: list[dict],
    unverified: list[tuple[str, str]],
    fabricated: list[str],
    conflicted: bool,
) -> tuple[str, str]:
    """The same standard of proof as `_guard`, where the proof is a quote.

    A chunk id can only point at a passage the search really returned; a quote
    can say anything at all. So a quote counts only once it has been found in
    the document word for word, and a verdict that needs evidence and has none
    that checks out is not a verdict.
    """
    if verdict in CITING_VERDICTS and not evidence:
        if unverified:
            quote, reason = unverified[0]
            return (
                "needs_review",
                f"Reported as '{verdict}', but the passage it quoted could not be found in "
                f"the document ({reason}: “{quote[:140]}”), so the claim could not be "
                "checked. " + rationale,
            )
        return (
            "needs_review",
            f"Reported as '{verdict}' but quoted nothing from the document, so the claim "
            "could not be grounded. " + rationale,
        )

    # Everything else `_guard` checks applies unchanged. Retrieval strength does
    # not: nothing was retrieved, so it is passed as strong.
    verdict, rationale = _guard(
        verdict,
        confidence,
        evidence,
        1.0,
        rationale,
        fabricated=fabricated,
        conflicted=conflicted,
    )

    if unverified and evidence and verdict != "needs_review":
        count = len(unverified)
        rationale = (
            f"{rationale} ({count} further quoted passage{'s' if count != 1 else ''} could "
            f"not be found in the document and {'were' if count != 1 else 'was'} set aside.)"
        )
    return verdict, rationale


def _complete_and_follow(job: Job, run: dict, total: int, follow: str) -> str:
    """Finish this run and open its comparison run, in one transaction.

    A document can have only one live run, so the two modes of a comparison
    cannot both be queued up front. The second is created the moment the first
    completes, and the job's payload is moved onto it in the same transaction:
    a worker that dies after this resumes the second run, never the first.
    """
    next_id = db.new_id()
    with db.transaction() as conn:
        db.execute(
            conn,
            """
            UPDATE "assessment_run"
               SET "state" = 'complete', "completedClauses" = "totalClauses",
                   "completedAt" = now()
             WHERE "id" = %s
            """,
            (run["id"],),
        )
        db.execute(
            conn,
            """
            INSERT INTO "assessment_run"
                ("id","organisationId","documentId","frameworkId","state","totalClauses",
                 "mode","comparedWithId")
            VALUES (%s,%s,%s,%s,'queued',%s,%s,%s)
            """,
            (
                next_id,
                run["organisationId"],
                run["documentId"],
                run["frameworkId"],
                total,
                follow,
                run["id"],
            ),
        )
        db.execute(
            conn,
            'UPDATE "job" SET "payload" = %s, "updatedAt" = now() WHERE "id" = %s',
            (Jsonb({"runId": next_id}), job.id),
        )
    logs.info(log, "assessment complete, comparison run opened", runId=run["id"], next=next_id)
    return next_id


def _guard(
    verdict: str,
    confidence: float,
    evidence: list[dict],
    best_score: float,
    rationale: str,
    *,
    cited_generated: set[str] | None = None,
    cited_total: int = 0,
    fabricated: list[str] | None = None,
    conflicted: bool = False,
) -> tuple[str, str]:
    """Demote verdicts the evidence does not support.

    These are the checks that make the difference between a tool a reviewer can
    trust and one that is confidently wrong at scale. Each demotion says why, so
    the reviewer sees the machine's reasoning rather than an unexplained shrug.
    """
    if verdict in CITING_VERDICTS and not evidence:
        return (
            "needs_review",
            f"Reported as '{verdict}' but cited nothing in the submitted document, "
            "so the claim could not be grounded. " + rationale,
        )

    # A figure description may corroborate a verdict; it may not be the whole
    # basis for a confident one. It is generated text, and a wrong reading of a
    # diagram would otherwise convict a design of something it never said.
    if (
        verdict in DECISIVE_VERDICTS
        and cited_total > 0
        and cited_generated is not None
        and len(cited_generated) == cited_total
    ):
        return (
            "needs_review",
            f"Reported as '{verdict}' on the strength of a diagram description alone. "
            "That description is a model's reading of an image, not text from the "
            "document, so it cannot carry a verdict by itself — check the figure. "
            + rationale,
        )

    # A verdict resting on a decision nobody made is the register's version of
    # citing a passage that is not in the document, and gets the same treatment.
    if fabricated:
        return (
            "needs_review",
            f"Reported as '{verdict}' citing a standing decision that was not on "
            "record. The verdict rests on a ruling this organisation has not "
            "made. " + rationale,
        )

    # Two rulings pulling opposite ways, and deliberately not resolved by taking
    # the newer one — that would hide a contradiction the customer needs to fix.
    if conflicted and verdict in DECISIVE_VERDICTS:
        return (
            "needs_review",
            "Two standing decisions on this clause disagree — one accepts the "
            "arrangement and another rejects it. Resolve the register before "
            "this clause can be settled. " + rationale,
        )

    if verdict == "absent" and best_score < WEAK_RETRIEVAL:
        return (
            "needs_review",
            "Nothing relevant was retrieved, which is not the same as the "
            "requirement being unaddressed — the search may simply have missed "
            "it. " + rationale,
        )

    if verdict == "absent" and confidence < MIN_ABSENT_CONFIDENCE:
        return (
            "needs_review",
            f"Reported as absent with low confidence ({confidence:.0%}). " + rationale,
        )

    return verdict, rationale


def _normalise(raw: dict) -> tuple[str, float, str, list[str], list[str]]:
    verdict = str(raw.get("verdict", "")).strip().lower()
    if verdict not in VERDICTS:
        verdict = "needs_review"

    try:
        confidence = max(0.0, min(1.0, float(raw.get("confidence", 0))))
    except (TypeError, ValueError):
        confidence = 0.0

    rationale = " ".join(str(raw.get("rationale", "")).split())[:1200]

    cited = raw.get("evidence") or []
    if isinstance(cited, str):
        cited = [cited]

    applied = raw.get("appliedDecisions") or []
    if isinstance(applied, str):
        applied = [applied]

    return (
        verdict,
        confidence,
        rationale,
        [str(c) for c in cited if c],
        [str(a) for a in applied if a],
    )


def _render_clause(clause: dict) -> str:
    parts = []
    if clause["title"]:
        parts.append(f"Title: {clause['title']}")
    if clause["statement"]:
        parts.append(f"Statement: {clause['statement']}")
    if clause["requirements"]:
        parts.append("Requirements:\n" + "\n".join(f"- {r}" for r in clause["requirements"]))
    # Rationale and guidance are deliberately withheld: they explain why the
    # rule exists and how to implement it, and including them tempts the model
    # to mark a design down for not following advice the clause never required.
    return "\n".join(parts)


def _render_extracts(candidates: list[retrieval.Candidate]) -> str:
    """Extracts, with generated ones labelled as such.

    A figure extract is a vision model's reading of a diagram, not a quotation
    from the document. Unlabelled it is indistinguishable from one — which is
    precisely how a hallucinated system name becomes cited evidence in a
    compliance finding.
    """
    out = []
    for c in candidates:
        page = f" page={c.page_start}" if c.page_start else ""
        origin = ' origin="model-description-of-a-diagram"' if c.is_generated else ""
        out.append(
            f'<extract id="{c.chunk_id}" location="{c.heading_path}"{page}{origin}>\n'
            f"{c.excerpt}\n</extract>"
        )
    return "\n\n".join(out)


def _write(
    run_id: str,
    clause: dict,
    *,
    verdict: str,
    confidence: float,
    rationale: str,
    evidence: list[dict],
    retrieval_score: float,
    applied: list[dict],
) -> None:
    """One finding, committed on its own so a crash costs at most one clause."""
    reference = clause["numberText"] or clause["headingPath"]
    with db.transaction() as conn:
        db.execute(
            conn,
            """
            INSERT INTO "finding"
                ("id","runId","clauseId","clauseRef","clauseTitle","clauseStatement",
                 "verdict","confidence","rationale","evidence","retrievalScore",
                 "appliedDecisions")
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT ("runId","clauseId") DO UPDATE SET
                "verdict"    = EXCLUDED."verdict",
                "confidence" = EXCLUDED."confidence",
                "rationale"  = EXCLUDED."rationale",
                "evidence"   = EXCLUDED."evidence",
                "retrievalScore" = EXCLUDED."retrievalScore",
                "appliedDecisions" = EXCLUDED."appliedDecisions"
            """,
            (
                db.new_id(),
                run_id,
                clause["id"],
                str(reference)[:300],
                (clause["title"] or "")[:500],
                (clause["statement"] or "")[:2000],
                verdict,
                confidence,
                rationale,
                Jsonb(evidence),
                retrieval_score,
                Jsonb(applied),
            ),
        )


def _start(
    run_id: str,
    *,
    total: int,
    completed: int,
    model: str,
    mode: str = "retrieval",
    note: str | None = None,
) -> None:
    # `mode` is the mode actually used, which a whole-document run that fell
    # back to search is not — so the results never claim a method that did not
    # produce them, and `note` says why.
    with db.connection() as conn:
        db.execute(
            conn,
            """
            UPDATE "assessment_run"
               SET "state" = 'running', "totalClauses" = %s, "completedClauses" = %s,
                   "model" = %s, "failureReason" = NULL, "mode" = %s, "note" = %s
             WHERE "id" = %s
            """,
            (total, completed, model, mode, note, run_id),
        )


def _progress(run_id: str, completed: int) -> None:
    with db.connection() as conn:
        db.execute(
            conn,
            'UPDATE "assessment_run" SET "completedClauses" = %s WHERE "id" = %s',
            (completed, run_id),
        )


def _fail(run_id: str, reason: str) -> None:
    with db.connection() as conn:
        db.execute(
            conn,
            """
            UPDATE "assessment_run"
               SET "state" = 'failed', "failureReason" = %s, "completedAt" = now()
             WHERE "id" = %s
            """,
            (reason[:1000], run_id),
        )


def _complete(job: Job, run_id: str) -> None:
    with db.transaction() as conn:
        counts = db.query(
            conn,
            'SELECT "verdict", count(*)::int AS n FROM "finding" WHERE "runId" = %s GROUP BY 1',
            (run_id,),
        )
        db.execute(
            conn,
            """
            UPDATE "assessment_run"
               SET "state" = 'complete',
                   "completedClauses" = "totalClauses",
                   "completedAt" = now()
             WHERE "id" = %s
            """,
            (run_id,),
        )
        queue.complete(conn, job)

    logs.info(
        log,
        "assessment complete",
        runId=run_id,
        **{c["verdict"]: c["n"] for c in counts},
    )


def mark_failed(run_id: str, reason: str) -> None:
    """Called from the worker loop when the job is dead-lettered."""
    _fail(run_id, reason)

