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

from psycopg.types.json import Jsonb

from .. import db, decisions, logs, queue, retrieval, techstack
from ..ai import llm
from ..config import get_config
from ..queue import Job

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

    cfg = get_config()
    if not llm.available():
        raise RuntimeError(
            "no model API key configured — assessment needs one to reach a verdict"
        )

    with db.connection() as conn:
        run = db.one(conn, 'SELECT * FROM "assessment_run" WHERE "id" = %s', (run_id,))
        if run is None:
            raise RuntimeError(f"assessment run {run_id} no longer exists")
        clauses = _framework_clauses(conn, run["frameworkId"])
        # Once per run: the same string for every clause, so fetching it inside
        # the loop would be a hundred round trips for one row.
        technology = techstack.for_organisation(conn, run["organisationId"])
        done = {
            r["clauseId"]
            for r in db.query(
                conn, 'SELECT "clauseId" FROM "finding" WHERE "runId" = %s', (run_id,)
            )
        }

    if not clauses:
        _fail(run_id, "The framework contains no clauses. Ingest a reference document first.")
        raise RuntimeError("framework has no clauses")

    pending = [c for c in clauses if c["id"] not in done]
    _start(run_id, total=len(clauses), completed=len(done), model=cfg.gemini_model)
    logs.info(
        log,
        "assessment started",
        runId=run_id,
        clauses=len(clauses),
        resuming=len(done),
        pending=len(pending),
    )

    if technology:
        logs.info(log, "technology reference in scope", runId=run_id, chars=len(technology))

    for index, clause in enumerate(pending, start=1):
        _assess_one(run, clause, technology)
        heartbeat()
        # Every clause, not every fifth. A clause takes around fifteen seconds,
        # so batching the write held the progress bar still for over a minute at
        # a time — long enough that a run in perfect health reads as a hung one,
        # which is what a progress bar exists to rule out. The cost is one small
        # UPDATE per clause against a row already in cache, spaced fifteen
        # seconds apart; the model call beside it dwarfs it.
        _progress(run_id, len(done) + index)

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


def _assess_one(run: dict, clause: dict, technology: str = "") -> None:
    """Retrieve, judge, guard, commit — one clause, one transaction."""
    query = retrieval.clause_query(
        clause["statement"], clause["requirements"] or [], clause["title"]
    )
    reference = f"{clause['documentTitle']} — {clause['headingPath']}"

    # One embedding for the clause, shared by both lookups below. They search
    # different tables with the same question, and paying for it twice would
    # double the embedding bill of every run.
    vector = retrieval.embed_query(query)

    with db.connection() as conn:
        candidates = retrieval.search_document(
            conn,
            organisation_id=run["organisationId"],
            document_id=run["documentId"],
            query=query,
            limit=CANDIDATES,
            vector=vector,
        )
        # What this organisation has already settled about this clause. Looked
        # up in the same connection as the passages, because a run that can
        # read one and not the other would silently drop the memory.
        precedents = decisions.for_clause(
            conn,
            organisation_id=run["organisationId"],
            clause_ref=str(clause["numberText"] or clause["headingPath"] or ""),
            query=query,
            limit=PRECEDENTS,
            vector=vector,
        )

    best = candidates[0].score if candidates else 0.0

    if not candidates:
        # Nothing in the submitted document at all. Only reachable when it has
        # no chunks, which the caller should have prevented.
        _write(
            run["id"],
            clause,
            verdict="needs_review",
            confidence=0.0,
            rationale="No content was retrieved from the submitted document.",
            evidence=[],
            retrieval_score=0.0,
            applied=[],
        )
        return

    try:
        raw = llm.judge(
            reference=reference,
            clause=_render_clause(clause),
            extracts=_render_extracts(candidates),
            precedents=decisions.render(precedents),
            technology=techstack.render(technology),
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
            retrieval_score=best,
            applied=[],
        )
        return

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

    # Only decisions that were actually in the prompt count. A model naming an
    # id it was never given has invented a precedent, which is worse than
    # having none: a fabricated policy citation in a compliance report.
    offered = {d.id: d for d in precedents}
    applied = [
        {"id": d.id, "title": d.title, "effect": d.effect}
        for cid in claimed
        if (d := offered.get(cid))
    ]
    fabricated = [cid for cid in claimed if cid not in offered]

    verdict, rationale = _guard(
        verdict, confidence, evidence, best, rationale, cited_generated=set(cited) & generated,
        cited_total=len([c for c in cited if c in by_id]),
        fabricated=fabricated,
        conflicted=decisions.conflicting(precedents),
    )

    _write(
        run["id"],
        clause,
        verdict=verdict,
        confidence=confidence,
        rationale=rationale,
        evidence=evidence,
        retrieval_score=best,
        applied=applied,
    )


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


def _start(run_id: str, *, total: int, completed: int, model: str) -> None:
    with db.connection() as conn:
        db.execute(
            conn,
            """
            UPDATE "assessment_run"
               SET "state" = 'running', "totalClauses" = %s, "completedClauses" = %s,
                   "model" = %s, "failureReason" = NULL
             WHERE "id" = %s
            """,
            (total, completed, model, run_id),
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

