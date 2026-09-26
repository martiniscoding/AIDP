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

import re

from dataclasses import dataclass, replace

from psycopg.types.json import Jsonb

from .. import (
    advice,
    coverage,
    db,
    decisions,
    lifecycle,
    logs,
    progress,
    queue,
    retrieval,
    usage,
    whole_document,
)
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

# How sure a "covered" resting only on diagram descriptions has to be to stand.
# Below it the figure is put in front of a reviewer. Confidence alone is a weak
# signal — a model reports it about itself — so it is one of two conditions, not
# the whole test: see `_figure_corroborates`.
FIGURE_COVERED_CONFIDENCE = 0.80

# How many words of the clause a diagram has to actually use before its
# description counts as answering that clause rather than merely being nearby.
FIGURE_KEYWORD_HITS = 2

# How many separate diagrams saying the same thing stand in for those words. Two
# figures independently describing the arrangement is corroboration of a
# different kind, and it is what a reviewer would accept.
FIGURE_CORROBORATING_COUNT = 2

# The shortest word that can carry subject matter. Below this they are almost
# all function words, and "of" appearing in a caption proves nothing.
KEYWORD_MIN_CHARS = 4

# Four-letter-plus words common enough in standards prose to match any diagram.
# Matching one of these is not evidence a figure is about the clause.
#
# The second and third groups were measured, not guessed. Against the sample
# corpus one ordinary context diagram — "governed data flow through the
# integration platform" — corroborated 44 of 54 clauses, including the
# encryption clause it says nothing about, on words like "data", "through" and
# "rather". Those words are what architecture prose is made of; they appear in
# every clause and every diagram, so matching them measures nothing. Removing
# them takes that 44 down to 7 while a diagram genuinely about a clause still
# matches. If this list is trimmed, re-run the sweep before trusting it.
_STOPWORDS = frozenset(
    """
    that this with from they them have been will must should shall each other than
    when where which what while whose into onto upon over under about above below
    such same both more most some many much very also only just then than there
    these those their your ours theirn used using uses make makes made take taken
    does done being were was are for the and but not any all can may via per
    system systems design designs document documents solution solutions service
    services provide provides provided ensure ensures ensured include includes
    including requirement requirements standard standards clause clauses section
    sections shall_not appropriate relevant necessary applicable

    data through rather directly between flow flows across within around
    context enterprise platform platforms component components interface
    interfaces process processes manage managed management support supported
    operate operated record records control controls access user users
    application applications information business technical

    related associated specific general various different additional further
    following above below other others where whether during before after
    because however therefore given based upon able need needs needed
    required requires
    """.split()
)


def _keywords(text: str) -> set[str]:
    """The words of a clause that could identify a diagram as being about it."""
    return {
        word
        for word in re.findall(r"[a-z0-9]+", (text or "").lower())
        if len(word) >= KEYWORD_MIN_CHARS and word not in _STOPWORDS
    }


def _figure_corroborates(
    clause_text: str, figure_text: str, figure_count: int
) -> bool:
    """Whether diagrams alone are enough to say a clause is covered.

    Confidence says how sure the model is; this says whether the diagram is
    even on the subject. A description that shares no substantive word with the
    clause is a picture of something else, and a confident "covered" on top of
    it is the failure the figure guard exists to catch — so either the diagram
    uses the clause's own words, or two separate diagrams say it.
    """
    if figure_count >= FIGURE_CORROBORATING_COUNT:
        return True
    shared = _keywords(clause_text) & _keywords(figure_text)
    return len(shared) >= FIGURE_KEYWORD_HITS

# How many passages the judge sees per clause. Wide enough that a requirement
# split across two sections is still visible; narrow enough that the model is
# not asked to read the whole document for every clause.
CANDIDATES = 8

# How many absent clauses one confirmation call carries. The document is sent
# once however many there are; what grows is the reply, and a reply cut off at
# the output limit would lose the clauses at the end of the batch.
CONFIRM_BATCH = 25

# An absent at or above this needs no second opinion: the model was sure, and
# `_guard` has already refused everything below its own floor. Between the two
# sits the band the re-read exists for, and those are the ones marked unchecked
# when it cannot run.
CONFIRM_REQUIRED_CONFIDENCE = 0.85

# What such a finding says instead. Short, because `_demoted` prepends it to the
# model's own sentence and the pair has to stay inside one row of the report.
UNCONFIRMED_ABSENT = "Absent confirmation unavailable; verify manually."

# The confidence recorded for a verdict the re-read produced. Deliberately not
# the model's own: this is a second opinion on a clause the search had already
# given up on, and it carries a checked quote rather than certainty.
CONFIRM_CONFIDENCE = 0.7

# The longest rationale kept. A finding's reason is shown in the collapsed row,
# before anything is expanded, and a guard demotion prepends its own sentence to
# it — so a model that writes four sentences pushed the clause title off the row
# and buried the reason the verdict changed.
MAX_RATIONALE = 280

# A guard's own sentence, which is prepended to the model's. Kept short for the
# same reason: the two together have to stay readable in one row.
MAX_GUARD_REASON = 200


def _shorten(text: str, limit: int) -> str:
    """One or two whole sentences, within `limit` characters.

    Clipped at a sentence end where there is one inside the limit, so a
    rationale reads as a finished thought rather than a severed clause.
    """
    collapsed = " ".join(str(text or "").split())
    if len(collapsed) <= limit:
        return collapsed
    window = collapsed[:limit]
    cut = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
    if cut >= limit // 3:
        return window[: cut + 1]
    if window.endswith("."):
        return window
    return window[: limit - 1].rstrip() + "…"


def handle(job: Job, heartbeat) -> None:
    run_id = job.payload.get("runId")
    if not run_id:
        raise RuntimeError("analyse job has no runId in its payload")

    if not llm.available():
        raise RuntimeError(
            "no model API key configured — assessment needs one to reach a verdict"
        )

    # "Fresh suggestions" on a finished report: the last step again, and nothing
    # else. The verdicts stand and the run keeps its state; see `_suggest_again`.
    if job.payload.get("adviceOnly"):
        _suggest_again(job, run_id, heartbeat)
        return

    # The run row only turns "running" once everything below is ready, which can
    # take a while on a large design; these steps are what the page shows
    # meanwhile. See progress.py.
    progress.step("Loading the standards and the design")
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

    # Stopped, or failed elsewhere, before a worker reached it. Its job is closed
    # rather than retried: there is nothing left to advance.
    if run["state"] not in ("queued", "running"):
        logs.info(log, "run is not live, nothing to do", runId=run_id, state=run["state"])
        with db.transaction() as conn:
            queue.complete(conn, job, chain=False)
        return

    if not clauses:
        _fail(run_id, "The framework contains no clauses. Ingest a reference document first.")
        raise RuntimeError("framework has no clauses")

    # Before any retrieval. A document embedded under an earlier embedding model
    # has no vectors that search can see, and a clause judged on an empty
    # search reads as absent. See `embed.embed_missing`.
    progress.step("Checking the search index")
    healed = embed_stage.embed_missing(run["documentId"], heartbeat)
    if healed:
        logs.info(log, "embedded missing chunks before assessing", runId=run_id, chunks=healed)

    progress.step("Preparing the assessment")
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

    step_label = (
        "Assessing clauses, reading the whole document"
        if whole is not None
        else "Assessing clauses by search"
    )
    for index, clause in enumerate(pending, start=1):
        progress.step(step_label, done=len(done) + index - 1, total=len(clauses))
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
        if _progress(run_id, len(done) + index) == 0:
            logs.info(
                log,
                "run is no longer running, abandoning it",
                runId=run_id,
                clausesDone=len(done) + index,
            )
            with db.transaction() as conn:
                queue.complete(conn, job, chain=False)
            return

    # Search shows the judge eight passages, so "absent" is the one verdict it
    # cannot really reach: a claim about everywhere it did not look. Every clause
    # that came back absent is read again against the whole document — one call
    # for the lot, not one per clause — and a verdict changes only on a quote
    # found in the document word for word. A whole-document run has already read
    # everything, so this is for search runs alone. Never fails the run.
    if whole is None:
        progress.step("Re-reading what looked absent")
        heartbeat()
        _confirm_absents(run, clauses)

    # The reverse question: what the design does that no clause governs, and the
    # standards that would. After the clauses, so a passage a clause has already
    # judged is never reported as ungoverned. Never fails the run; see coverage.py.
    progress.step("Finding parts of the design no standard covers")
    heartbeat()
    coverage.record(run, clauses)

    # What an experienced reviewer would still ask of the design, beyond the
    # standards. Last, and in its own call, so it can draw on every finding above
    # and can never soften one. Never fails the run; see advice.py.
    progress.step("Suggesting improvements to the design")
    heartbeat()
    advice.record(run, fresh=bool(job.payload.get("freshAdvice")))

    # Whether the products the design builds on are still supported, from public
    # lifecycle data — facts beside the findings, never a verdict. Only product
    # ids are looked up. Never fails the run; see lifecycle.py.
    progress.step("Checking the technologies' support dates")
    heartbeat()
    lifecycle.record(run)

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


def _suggest_again(job: Job, run_id: str, heartbeat) -> None:
    """Work out a finished run's suggested improvements again, and nothing else.

    Queued from the report by a reviewer who wants a new set rather than the
    one reused for an unchanged design. Only the advice column is written: the
    findings, the coverage and the run's state are the assessment's, and asking
    for new advice is not re-assessing. `freshAdvice` on the payload is what
    skips the stored reply; without it this would hand back the same set.
    """
    progress.step("Suggesting improvements to the design")
    with db.connection() as conn:
        run = db.one(conn, 'SELECT * FROM "assessment_run" WHERE "id" = %s', (run_id,))
    if run is None:
        raise RuntimeError(f"assessment run {run_id} no longer exists")

    heartbeat()
    fresh = bool(job.payload.get("freshAdvice"))
    result = advice.record(run, fresh=fresh)
    with db.transaction() as conn:
        queue.complete(conn, job)
    logs.info(
        log,
        "suggestions worked out again",
        runId=run_id,
        fresh=fresh,
        state=result.get("state"),
        suggestions=len(result.get("suggestions") or []),
    )


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

    cited_figures = set(cited) & generated
    verdict, rationale = _guard(
        verdict, confidence, evidence, best, rationale, cited_generated=cited_figures,
        cited_total=len([c for c in cited if c in by_id]),
        fabricated=fabricated,
        conflicted=decisions.conflicting(precedents),
        clause_text=_render_clause(clause),
        figure_text=" ".join(
            c.excerpt for cid in cited_figures if (c := by_id.get(cid)) is not None
        ),
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
        clause_text=_render_clause(clause),
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


def _confirm_absents(run: dict, clauses: list[dict]) -> None:
    """Re-read the whole document for every clause the search found nothing for.

    Never raises: a run's verdicts have to reach the report even when the re-read
    cannot run. But they do not reach it unchanged. Turning a wrong "absent" into
    the verdict the document supports is the most expensive mistake this stage can
    fix — it is what stops somebody being sent to build what already exists — so
    when the re-read fails, every absent that was relying on it is marked as
    unchecked rather than presented as settled.

    Only the ones relying on it. An absent the model was near-certain of stands on
    its own; `_guard` has already refused the ones below its own floor. What is
    left in between is exactly what the second opinion existed to catch.
    """
    try:
        _confirm(run, clauses)
    except Exception as exc:  # noqa: BLE001 — the clause verdicts stand without it
        logs.warn(
            log, "absent clauses could not be re-read", runId=run["id"], error=str(exc)[:300]
        )
        _demote_unconfirmed(run, clauses, str(exc))


def _demote_unconfirmed(run: dict, clauses: list[dict], why: str) -> int:
    """Mark absents that the failed re-read would have checked as needing a person.

    Silence here was the bug: a confirmation pass that never ran left every
    "absent" looking exactly like one the whole document had confirmed, and the
    report has no other way to tell them apart.
    """
    by_id = {clause["id"]: clause for clause in clauses}
    try:
        with db.connection() as conn:
            rows = db.query(
                conn,
                'SELECT "clauseId", "confidence", "rationale" FROM "finding" '
                'WHERE "runId" = %s AND "verdict" = %s AND "confidence" < %s',
                (run["id"], "absent", CONFIRM_REQUIRED_CONFIDENCE),
            )
    except Exception as exc:  # noqa: BLE001 — nothing more can be done for this run
        logs.warn(
            log, "unconfirmed absents could not be marked", runId=run["id"], error=str(exc)[:300]
        )
        return 0

    demoted = 0
    for row in rows:
        clause = by_id.get(row["clauseId"])
        if clause is None:
            continue
        verdict, rationale = _demoted(UNCONFIRMED_ABSENT, str(row.get("rationale") or ""))
        try:
            _write(
                run["id"],
                clause,
                verdict=verdict,
                confidence=float(row.get("confidence") or 0.0),
                rationale=rationale,
                evidence=[],
                retrieval_score=0.0,
                applied=[],
            )
        except Exception as exc:  # noqa: BLE001 — one clause must not sink the rest
            logs.warn(
                log, "could not mark an absent unconfirmed", clauseId=clause["id"],
                error=str(exc)[:200],
            )
            continue
        demoted += 1

    logs.warn(
        log,
        "absents left unchecked by a failed re-read",
        runId=run["id"],
        demoted=demoted,
        of=len(rows),
        error=why[:200],
    )
    return demoted


def _confirm(run: dict, clauses: list[dict]) -> None:
    with db.connection() as conn:
        absent_ids = db.query(
            conn,
            'SELECT "clauseId" FROM "finding" WHERE "runId" = %s AND "verdict" = %s',
            (run["id"], "absent"),
        )
        if not absent_ids:
            return
        row = db.one(
            conn, 'SELECT "title" FROM "document" WHERE "id" = %s', (run["documentId"],)
        )
        whole = whole_document.load(conn, run["documentId"], (row or {}).get("title") or "")

    # Both of these leave the search's verdicts exactly as they are, which is the
    # behaviour this stage had before the pass existed.
    if whole is None:
        logs.info(
            log,
            "no stored pages: absent verdicts stand as the search left them",
            runId=run["id"],
        )
        return
    limit = get_config().whole_document_max_tokens
    if whole.tokens > limit:
        logs.info(
            log,
            "document too large to re-read for absent clauses",
            runId=run["id"],
            tokens=whole.tokens,
            limit=limit,
        )
        return

    by_id = {clause["id"]: clause for clause in clauses}
    absent = [by_id[row["clauseId"]] for row in absent_ids if row["clauseId"] in by_id]
    changed = 0
    for start in range(0, len(absent), CONFIRM_BATCH):
        batch = absent[start : start + CONFIRM_BATCH]
        raw = llm.confirm_absent(document=whole.text, clauses=_render_absent(batch))
        changed += _adopt_confirmations(run, batch, raw, whole)

    logs.info(
        log,
        "absent clauses re-read against the whole document",
        runId=run["id"],
        clauses=len(absent),
        changed=changed,
    )


def _render_absent(clauses: list[dict]) -> str:
    """The batch, numbered. The reply answers by number, never in the clause's words."""
    return "\n\n".join(
        f"[{index}] {clause['documentTitle']} — {clause['headingPath']}\n{_render_clause(clause)}"
        for index, clause in enumerate(clauses, start=1)
    )


def _adopt_confirmations(
    run: dict, batch: list[dict], raw: dict, whole: whole_document.WholeDocument
) -> int:
    """Rewrite the findings the re-read overturned, and only those.

    A verdict moves off "absent" on one condition: the reply quotes the document,
    and the quote is in the document word for word. Anything else — a clause
    number that is not in this batch, a verdict that is not one of ours, a quote
    nowhere in the text — leaves the finding as the search left it.
    """
    items = raw.get("clauses") if isinstance(raw.get("clauses"), list) else []
    changed = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        number = _page_number(item.get("clause"))
        if number is None or not 1 <= number <= len(batch):
            continue
        verdict = str(item.get("verdict", "")).strip().lower()
        if verdict == "absent" or verdict not in VERDICTS:
            continue

        quote = " ".join(str(item.get("quote") or "").split())
        check = whole.verify(quote, _page_number(item.get("page")))
        if not check.verified:
            logs.warn(
                log,
                "absent stands: the quoted words are not in the document",
                reason=check.reason,
                quote=quote[:300],
            )
            continue

        clause = batch[number - 1]
        rationale = " ".join(str(item.get("rationale") or "").split())[:900]
        _write(
            run["id"],
            clause,
            verdict=verdict,
            confidence=CONFIRM_CONFIDENCE,
            rationale=(
                "A search of this design found nothing for this clause, so the whole "
                f"document was read again — and it does address it. {rationale}"
            ),
            evidence=[
                {
                    "chunkId": f"confirm-{clause['id']}",
                    "headingPath": "",
                    "page": check.page,
                    "excerpt": quote[:1500],
                    "sourceKind": "quote",
                    "figureId": None,
                }
            ],
            retrieval_score=0.0,
            applied=[],
        )
        changed += 1
    return changed


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
                    # A quote found only in a diagram description is labelled as
                    # one, so it renders with the figure beside it and `_guard`
                    # can refuse to let it carry a verdict alone.
                    "sourceKind": found.source_kind if found.source_kind == "figure" else "quote",
                    "figureId": found.figure_id,
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
    clause_text: str = "",
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
            return _demoted(
                f"Reported '{verdict}', but its quote is not in the document "
                f"({reason}: “{quote[:60]}”).",
                rationale,
            )
        return _demoted(f"Reported '{verdict}' but quoted nothing from the document.", rationale)

    # Everything else `_guard` checks applies unchanged, including the two
    # absent checks. Retrieval strength is the one input that does not exist
    # here — nothing was retrieved — so it is passed as strong, which stands
    # down the weak-retrieval check while leaving the confidence floor to do its
    # work. Passing this whole guard by was how a whole-document run reported a
    # coin-flip "absent" as settled.
    figures = [item for item in evidence if item.get("sourceKind") == "figure"]
    verdict, rationale = _guard(
        verdict,
        confidence,
        evidence,
        1.0,
        rationale,
        cited_generated={item["chunkId"] for item in figures},
        cited_total=len(evidence),
        fabricated=fabricated,
        conflicted=conflicted,
        clause_text=clause_text,
        figure_text=" ".join(str(item.get("excerpt") or "") for item in figures),
    )

    if unverified and evidence and verdict != "needs_review":
        count = len(unverified)
        note = f"({count} further quote{'s' if count != 1 else ''} not found, set aside.)"
        rationale = f"{_shorten(rationale, MAX_RATIONALE - len(note) - 1)} {note}".strip()
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
    clause_text: str = "",
    figure_text: str = "",
) -> tuple[str, str]:
    """Demote verdicts the evidence does not support.

    These are the checks that make the difference between a tool a reviewer can
    trust and one that is confidently wrong at scale. Each demotion says why, so
    the reviewer sees the machine's reasoning rather than an unexplained shrug.
    """
    if verdict in CITING_VERDICTS and not evidence:
        return _demoted(f"Reported '{verdict}' but cited nothing in the document.", rationale)

    # A figure description may corroborate a verdict; it may not be the whole
    # basis for a shaky one. It is generated text, and a wrong reading of a
    # diagram would otherwise convict a design of something it never said.
    #
    # Asymmetric on purpose. "contradicts" is always demoted: accusing a design
    # of breaching a clause on the strength of a model's reading of a picture is
    # the more expensive mistake, and a reviewer must look at the figure. A
    # confident "covered" is not, because designs really do state a component
    # only in their architecture diagram — an API gateway drawn on page 14 and
    # named in no paragraph — and demoting every one of those filled the review
    # queue with clauses the design had plainly answered.
    if (
        verdict in DECISIVE_VERDICTS
        and cited_total > 0
        and cited_generated is not None
        and len(cited_generated) == cited_total
    ):
        stands = (
            verdict == "covered"
            and confidence >= FIGURE_COVERED_CONFIDENCE
            and _figure_corroborates(clause_text, figure_text, len(cited_generated))
        )
        if not stands:
            return _demoted(
                f"Reported '{verdict}' on a diagram description alone — check the figure.",
                rationale,
            )

    # A verdict resting on a decision nobody made is the register's version of
    # citing a passage that is not in the document, and gets the same treatment.
    if fabricated:
        return _demoted(
            f"Reported '{verdict}' citing a standing decision that is not on record.",
            rationale,
        )

    # Two rulings pulling opposite ways, and deliberately not resolved by taking
    # the newer one — that would hide a contradiction the customer needs to fix.
    if conflicted and verdict in DECISIVE_VERDICTS:
        return _demoted(
            "Two standing decisions on this clause disagree; resolve the register.",
            rationale,
        )

    if verdict == "absent" and best_score < WEAK_RETRIEVAL:
        return _demoted(
            "Nothing relevant was retrieved, so the search may have missed it.", rationale
        )

    if verdict == "absent" and confidence < MIN_ABSENT_CONFIDENCE:
        return _demoted(f"Reported absent with low confidence ({confidence:.0%}).", rationale)

    return verdict, rationale


def _demoted(reason: str, rationale: str) -> tuple[str, str]:
    """A demotion to `needs_review`: the guard's sentence, then the model's.

    Both are bounded. The guard's reason is why the verdict changed and is kept
    whole; the model's is context and is shortened to fit beside it, so the two
    together stay inside one row of the report.
    """
    reason = _shorten(reason, MAX_GUARD_REASON)
    room = MAX_RATIONALE - len(reason) - 1
    tail = _shorten(rationale, room) if room >= 40 else ""
    return "needs_review", f"{reason} {tail}".strip()


def _normalise(raw: dict) -> tuple[str, float, str, list[str], list[str]]:
    verdict = str(raw.get("verdict", "")).strip().lower()
    if verdict not in VERDICTS:
        verdict = "needs_review"

    try:
        confidence = max(0.0, min(1.0, float(raw.get("confidence", 0))))
    except (TypeError, ValueError):
        confidence = 0.0

    rationale = _shorten(str(raw.get("rationale", "")), MAX_RATIONALE)

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


def _progress(run_id: str, completed: int) -> int:
    """Record a clause, and report whether the run is still one to work on.

    0 means the row is no longer running — somebody stopped it (see
    `cancelAssessment` in the app's actions.ts) or it was failed elsewhere. The
    caller stops there rather than spending a model call per remaining clause on
    a report nobody is waiting for.
    """
    with db.connection() as conn:
        return db.execute(
            conn,
            'UPDATE "assessment_run" SET "completedClauses" = %s '
            "WHERE \"id\" = %s AND \"state\" = 'running'",
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
             WHERE "id" = %s AND "state" IN ('queued', 'running')
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


def mark_advice_failed(run_id: str) -> None:
    """A dead-lettered request for fresh suggestions on a finished run.

    `mark_failed` is for an assessment, and would turn a finished run into a
    failed one over what is only advice. This clears the in-progress mark the
    report keeps checking on and says the request failed; the suggestions
    already on the report stay.
    """
    with db.connection() as conn:
        db.execute(
            conn,
            """
            UPDATE "assessment_run"
               SET "advice" = COALESCE("advice", '{}'::jsonb)
                              || jsonb_build_object('refreshing', false, 'refreshError', %s::text)
             WHERE "id" = %s
            """,
            ("A new set could not be worked out: the request kept failing.", run_id),
        )

