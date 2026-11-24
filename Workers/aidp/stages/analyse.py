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

import hashlib
import contextvars
import re
from collections import Counter
from concurrent import futures
from dataclasses import dataclass, field, replace

from psycopg.types.json import Jsonb

from .. import (
    advice,
    coverage,
    credentials,
    db,
    decisions,
    designs,
    fidelity,
    lifecycle,
    logs,
    notify,
    obligations,
    progress,
    queue,
    request_intake,
    retrieval,
    rootcause,
    stack,
    standards,
    usage,
    whole_document,
)
from ..ai import llm
from ..config import get_config
from ..queue import Job
from . import embed as embed_stage

log = logs.get(__name__)

VERDICTS = (
    "covered",
    "partial",
    "absent",
    "contradicts",
    "needs_review",
    # The design is on the subject and the evidence needed to judge it is not in
    # the document — a named cloud service with no approval record, a network
    # diagram with no firewall policy. Not a breach, and never Critical.
    #
    # Without it, the only answer for "the document does not say" was "absent",
    # which a confirmed absent turned into a Critical gap. So a missing page of
    # paperwork reached a report beside a real breach and read the same, which
    # is the engine's worst habit and the one this verdict exists to break.
    "not_assessable",
    # The clause does not govern this architecture at all. The most dangerous
    # verdict here, because it removes a clause from the report rather than
    # answering it, so it is held to the strictest proof: it must cite the
    # passage establishing what the design is, and it may not rest on a reading
    # of a diagram.
    "not_applicable",
)

# Verdicts that assert something about the submitted document, and so must point
# at a passage in it.
#
# "not_assessable" is here because it is what separates it from "absent": the
# design being *on the subject* is a claim about the document, and a
# not-assessable citing nothing is indistinguishable from a clause the design
# never mentions. "not_applicable" is here because a clause waved away with no
# basis is the cheapest possible way to manufacture a clean report.
CITING_VERDICTS = ("covered", "partial", "contradicts", "not_assessable", "not_applicable")

# Verdicts that close a question. These are the ones a diagram description must
# not reach on its own.
DECISIVE_VERDICTS = ("covered", "contradicts", "not_applicable")

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

# The least a clause could plausibly cost, in whatever currency the provider
# reports a balance in.
#
# A floor, deliberately not an estimate. Real cost swings with how much of the
# design goes into each prompt, and whole-document mode puts the whole design
# in every one: one 170-clause run over an eleven-page design billed 4.4M input
# tokens and about $0.012 a clause. This sits an order of magnitude under that,
# because the two errors are not symmetrical — refusing a run that would have
# finished is worse than letting a cheap one through, while the case this has
# to catch is not subtle. A key with $0.11 on it was asked for $2 of work, and
# "has credit" was true right up until clause nine.
MIN_CREDIT_PER_CLAUSE = 0.002

# The longest rationale kept.
#
# This was 280, and 280 was the cause of the worst output this engine produced.
# The judge is asked for three things — the gap, what it costs, and the fix —
# and three sentences of real English do not fit in 280 characters. So the model
# did what the budget forced and compressed its grammar instead of its content,
# which is where "retain GCP only with a documented trigger" came from: a
# telegraphic fragment that survives a character count and tells a reader
# nothing. A reviewer reading that cannot act on it, and a CTO reading it in a
# report does not believe the tool wrote it on purpose.
#
# 600 is three unhurried sentences — roughly 200 characters each, which is a
# normal written sentence naming a component, a page and a mechanism. The
# original reason for the cap was that the whole rationale sat in the collapsed
# row, where a fourth sentence pushed the clause title off the line; that is no
# longer true. The row shows the first sentence alone (see `rationaleParts` in
# the report), and the rest is read in the dialog, which has room for it.
#
# Still capped, because an unbounded rationale is a model writing an essay into
# a column, and because the guards below prepend their own sentence to it.
MAX_RATIONALE = 600

# A guard's own sentence, which is prepended to the model's. Kept short for the
# same reason: the two together have to stay readable in one row.
MAX_GUARD_REASON = 200


# A rationale that states a breach outright, whatever verdict the model then
# chose. Deliberately narrow: each alternative names the design doing something,
# not merely lacking it, because "no dead-letter queue is mentioned" is a gap
# and "messages are dropped" is a decision. Widening this to the vocabulary of
# absence would turn ordinary "partial" findings into contradictions, which is
# the expensive direction to be wrong in.
_BREACH = re.compile(
    r"\b("
    # The bare form belongs here with the inflected ones. A plural subject takes
    # it - "shared vendor accounts violate least-privilege", "these bypasses
    # breach the clause" - and the rationale is the model's own sentence, not a
    # style guide, so both conjugations turn up. DAT-019 sat at "partial" with
    # "violate" in its gap sentence and nothing to promote it.
    r"violat(?:e|es|ing|ed)"
    r"|breach(?:|es|ing|ed)"
    r"|conflicts?\s+with"
    r"|directly\s+contradicts?"
    r"|(?:messages?|events?|data|packets?|records?)\s+(?:are|is)\s+"
    r"(?:dropped|discarded|deleted)"
    r")\b",
    re.IGNORECASE,
)


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


def _purpose(conn, scope: designs.Scope) -> str:
    """Why this project exists, in the words of whoever opened it.

    A reviewer uploading two architectures to choose between them is doing
    something the clause-by-clause reading cannot see. The engine graded each
    design as though it were the system being built, so it reported the losing
    option's gaps as the project's own defects, and a reader comparing two
    candidates got two verdicts and no comparison.

    The description is the one place that intent is written down (`Project.description`,
    collected by NewProject.tsx and until now read by nothing). It is the
    customer's own prose, so it is labelled as stated intent rather than as
    fact, and nothing is inferred from it: the clause is still judged on what
    the designs say. What it changes is which question the judge thinks it is
    answering.

    Empty for a design outside any project, and for a project whose description
    was left blank — both give exactly the prompt this stage used before.
    """
    if not scope.project_id:
        return ""
    row = db.one(
        conn,
        'SELECT "name", "description" FROM "project" WHERE "id" = %s',
        (scope.project_id,),
    )
    if row is None:
        return ""
    description = (row["description"] or "").strip()
    if not description:
        return ""
    name = (row["name"] or "").strip()
    titled = f'"{name}"' if name else "this project"
    # Capped. A description is a short brief in practice, but it is free text a
    # customer types, and an essay pasted in here would push the design itself
    # out of the window — the thing the clause is actually judged on.
    if len(description) > 1200:
        description = description[:1200].rstrip() + "…"
    return (
        f"<what_this_project_is_for>\n"
        f"The reviewer opened {titled} with this purpose, in their own words:\n\n"
        f"{description}\n\n"
        "Read it as the stated intent behind the work, not as a fact about the "
        "architecture, and never as evidence: every verdict still rests only on what "
        "the designs themselves say. The project owner explicitly selected whether "
        "the designs are components of one solution or alternative candidates; follow "
        "that assessment scope and do not infer it from this description.\n"
        "</what_this_project_is_for>"
    )


def _stack_block(conn, rows: stack.Stack, scope: designs.Scope) -> str:
    """What the technology stack says, for the designs in this scope.

    Empty whenever the organisation has no stack indexed, which is the ordinary
    case and leaves every clause reading exactly as it did before this existed.
    """
    if not rows or not scope.designs:
        return ""
    text = stack.design_text(conn, scope.document_ids)
    if not text:
        return ""
    hits = stack.names_in(rows, text)
    return stack.render(rows, hits, _unmatched(rows, text))


# Names a design uses, by the design's own text, so a run that is assessed again
# (or a second design with the same text) does not pay for the extraction twice.
_NAMED: dict[str, list[str]] = {}


def _unmatched(rows: stack.Stack, text: str) -> list[stack.Hit]:
    """Technologies the design names that the stack has no entry for.

    One small model call per design, remembered for as long as the worker lives,
    then checked entirely in code (see `stack.unlisted`). Off unless
    `STACK_UNLISTED` is set, because it changes what the judge is told and so
    belongs behind a measurement. Any failure leaves the block as it was.
    """
    if not get_config().stack_unlisted:
        return []
    key = hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()
    if key not in _NAMED:
        try:
            answer = llm.find_named_technologies(design=text)
            names = answer.get("names") if isinstance(answer, dict) else None
            _NAMED[key] = [str(name) for name in names or []]
        except llm.QuotaExhausted:
            raise
        except Exception as exc:  # noqa: BLE001 — a missing extra fact must not fail a run
            logs.warn(log, "technology names could not be read", error=str(exc)[:200])
            return []
    return stack.unlisted(rows, text, _NAMED[key])


def _context(conn, scope: designs.Scope) -> str:
    """What the work under assessment is for, in the judge's words.

    One design gives its own summary, exactly as it did before projects existed.
    Several give one labelled block each: the judge is told it is reading a set
    of designs for one solution, because the alternative — three summaries run
    together — reads as three unrelated systems and invites a verdict about the
    wrong one.

    The project's own stated purpose goes first, where there is one. It is the
    frame the summaries are read inside: two designs under "choose between these
    two" are not two halves of one system, and nothing else in the prompt could
    tell the judge which it is looking at.
    """
    if not scope.designs:
        return ""
    purpose = _purpose(conn, scope)
    rows = db.query(
        conn,
        'SELECT "id", "summary" FROM "document" WHERE "id" = ANY(%s)',
        (scope.document_ids,),
    )
    summaries = {r["id"]: (r["summary"] or "").strip() for r in rows}

    def framed(body: str) -> str:
        return f"{purpose}\n\n{body}" if purpose and body else (purpose or body)

    if len(scope.designs) == 1:
        body = summaries.get(scope.designs[0].document_id, "")
        if scope.alternatives:
            body = (
                "This assessment covers this one alternative candidate only. Evidence "
                "from other candidates is outside this finding's scope. A weakness in "
                "this candidate is not a defect in the other candidates.\n\n" + body
            ).rstrip()
        return framed(body)

    blocks = [
        f'=== design: "{design.title}" ===\n{summaries[design.document_id]}'
        for design in scope.designs
        if summaries.get(design.document_id)
    ]
    if not blocks:
        return framed("")
    if scope.alternatives:
        # Alternative candidates are assessed separately; this branch is retained
        # for callers that build project context outside the per-design loop.
        intro = "These are alternative candidates and must not share evidence."
    else:
        intro = (
            "These designs describe one solution between them. Judge the clause against all "
            "of them together: what one leaves out another may answer."
        )
    return framed(intro + "\n\n" + "\n\n".join(blocks))


def _not_adopted(conn, framework_id: str) -> int:
    """How many live clauses this organisation has suspended.

    Kept under its old name because the run note that reads it is phrased
    around "how much of the library was left out", which is the same question.
    """
    row = db.one(
        conn,
        """
        SELECT count(*) AS n
          FROM "framework_document" fd
          JOIN "document_section" s ON s."documentId" = fd."documentId"
          JOIN "clause" cl          ON cl."sectionId" = s."id"
         WHERE fd."frameworkId" = %s
           AND cl."supersededById" IS NULL
           AND cl."status" = 'suspended'
        """,
        (framework_id,),
    )
    return int(row["n"]) if row else 0


def _with_not_adopted(note: str | None, skipped: int) -> str | None:
    """The run's note, saying how much of the library it was told to leave out.

    Without this a run over 150 of 170 clauses looks like a run that lost
    twenty, and the first question about the report is one the report cannot
    answer. The same reasoning as `_with_unready`: a partial scope is fine, a
    silent one is not.
    """
    if skipped <= 0:
        return note
    said = (
        f"{skipped} clause{'s' if skipped != 1 else ''} not assessed: rejected in "
        "your standards library."
    )
    return f"{note} {said}" if note else said


def _with_unready(note: str | None, scope: designs.Scope) -> str | None:
    """The run's note, saying which designs it could not read.

    A project report that silently covers four of five designs is worse than one
    that covers four and says so — the fifth one's gaps would read as the
    project's.
    """
    if not scope.unready:
        return note
    missing = ", ".join(f'"{title}"' for title in scope.unready)
    said = (
        f"Not included: {missing} — still being processed. Assess the project again "
        "once they finish."
    )
    return f"{note} {said}" if note else said


def handle(job: Job, heartbeat) -> None:
    if not llm.available():
        raise RuntimeError(
            "no model API key configured — assessment needs one to reach a verdict"
        )

    # Sharpening one clause from one confirmed `partial`. Not an assessment at
    # all: no run advances, no finding changes, and the only row written is the
    # draft a reviewer is waiting on. Handled here rather than in a stage of its
    # own because it is one model call that wants the analyse worker's key and
    # its lease, and a fifth container for it would idle.
    draft_id = job.payload.get("draftId")
    if draft_id:
        _draft_standard(job, draft_id)
        return

    # Reading a request's attached designs for the intake form's structured
    # questions. Not an assessment either: no run, no findings, and the only row
    # written is the proposal sheet a requestor is waiting on. Here for the
    # reason the clause draft above is here — one model call that wants this
    # worker's key and its lease, and a fifth container for it would idle.
    request_id = job.payload.get("requestId")
    if request_id:
        _read_intake(job, request_id)
        return

    run_id = job.payload.get("runId")
    if not run_id:
        raise RuntimeError("analyse job has no runId in its payload")

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
        # Counted inside the same connection as the clauses themselves, so the
        # number on the report and the clauses judged describe one library.
        not_adopted = _not_adopted(conn, run["frameworkId"])
        # One design, or every finished design in a project. Everything below
        # reads this rather than run["documentId"], which is null on a project
        # run. See designs.py.
        scope = designs.for_run(conn, run)
        # What the submitted work is, read once per run. The same string for
        # every clause, so fetching it inside the loop would be a hundred round
        # trips for one column.
        document_context = _context(conn, scope)
        per_design = bool(run.get("projectId") and scope.alternatives)
        # What the organisation's technology stack says about the technologies
        # these designs name. Read once per run: the block is identical for
        # every clause, and only the clauses that are about the stack are shown
        # it at all — see stack.concerns_technology.
        #
        # Split per design wherever the contexts are, and for the same reason
        # advice._worked_out gives: a design judged against alternatives must
        # never be shown another design's technologies, or the judge reports
        # one design for using what a different one chose.
        stack_rows = stack.load(conn, run["organisationId"])
        stack_block = _stack_block(conn, stack_rows, scope)
        stack_blocks = (
            {
                design.document_id: _stack_block(
                    conn, stack_rows, designs.only(scope, design.document_id)
                )
                for design in scope.designs
            }
            if per_design
            else {}
        )
        tasks = (
            [
                (clause, design.document_id)
                for design in scope.designs
                for clause in clauses
            ]
            if per_design
            else [
                (clause, scope.designs[0].document_id if not run.get("projectId") else None)
                for clause in clauses
            ]
        )
        done = {
            (r["clauseId"], r["designKey"])
            for r in db.query(
                conn,
                'SELECT "clauseId", "designKey" FROM "finding" WHERE "runId" = %s',
                (run_id,),
            )
        }
        task_contexts = (
            {
                design.document_id: _context(conn, designs.only(scope, design.document_id))
                for design in scope.designs
            }
            if per_design
            else {}
        )

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

    if not scope.designs:
        _fail(
            run_id,
            "There is no finished design to assess. A project is assessed once at least one "
            "of its designs has been processed."
            if run.get("projectId")
            else "The design this assessment was opened for no longer exists.",
        )
        raise RuntimeError(f"run {run_id} has no designs in scope")

    # Before any retrieval. A document embedded under an earlier embedding model
    # has no vectors that search can see, and a clause judged on an empty
    # search reads as absent. See `embed.embed_missing`.
    progress.step("Checking the search index")
    healed = sum(
        embed_stage.embed_missing(design.document_id, heartbeat) for design in scope.designs
    )
    if healed:
        logs.info(
            log,
            "embedded missing chunks before assessing",
            runId=run_id,
            chunks=healed,
            designs=len(scope.designs),
        )

    progress.step("Preparing the assessment")
    mode, note, whole = _resolve_mode(run, scope)
    note = _with_unready(note, scope)
    note = _with_not_adopted(note, not_adopted)

    pending = [
        (clause, design_id)
        for clause, design_id in tasks
        if (clause["id"], design_id or "") not in done
    ]
    completed = len(tasks) - len(pending)
    # Before the first clause, not after the fifty-fifth.
    _refuse_without_credit(len(pending))
    _start(
        run_id,
        total=len(tasks),
        completed=completed,
        model=llm.model_name()[1],
        mode=mode,
        note=note,
    )
    logs.info(
        log,
        "assessment started",
        runId=run_id,
        mode=mode,
        designs=designs.describe(scope),
        clauses=len(clauses),
        designAssessments=len(tasks),
        resuming=completed,
        pending=len(pending),
        readings=get_config().judge_readings,
        concurrency=min(get_config().assess_concurrency, max(1, len(pending))),
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
    refused = 0
    # Clauses judged at once. Each is an independent question committed in its
    # own transaction, so nothing about the work was ever sequential — the loop
    # simply was, and at roughly fifteen seconds a clause that made a
    # hundred-and-twenty-clause framework half an hour of waiting and a
    # three-design project an hour and a half. The work is all provider latency;
    # the ceiling is the key's rate limit, not this machine.
    workers = max(1, min(get_config().assess_concurrency, len(pending)))

    def judge_task(clause: dict, design_id: str | None) -> bool:
        """One clause, start to committed finding. Runs on a pool thread.

        Returns whether the clause was refused, for the `refused` tally below.
        """
        unit_scope = designs.only(scope, design_id) if design_id else scope
        unit_context = task_contexts.get(design_id, document_context)
        unit_stack = stack_blocks.get(design_id, stack_block)
        if whole is not None:
            return _assess_document_one(
                run, clause, whole, unit_scope, unit_context, stack_block=unit_stack
            )
        return _assess_one(
            run,
            clause,
            unit_scope,
            unit_context,
            design_id=design_id,
            stack_block=unit_stack,
        )

    progress.step(step_label, done=completed, total=len(tasks))
    quota: llm.QuotaExhausted | None = None
    stopped = False
    finished = 0

    with futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix="judge") as pool:
        # `copy_context().run` per task, and the copy is taken here on the
        # worker's own thread rather than inside the pool. The credential this
        # job's model calls are made with, the attribution its spend is booked
        # to and the progress tracker are all ContextVars bound once per job in
        # __main__ — and a thread started by a pool does not inherit them. Left
        # to itself, every clause on a pool thread would have looked for an API
        # key that was not there. A fresh copy per task because a Context cannot
        # be entered twice at once, which is exactly what concurrency means
        # here.
        running = {
            pool.submit(contextvars.copy_context().run, judge_task, clause, design_id): (
                clause,
                design_id,
            )
            for clause, design_id in pending
        }
        for future in futures.as_completed(running):
            clause, design_id = running[future]
            try:
                # True where every reading of the clause failed. That path
                # commits a `needs_review` instead of raising, so without this
                # it never reached `refused` and the run reported total
                # coverage — see the `readings=0` note in `_read_and_vote`.
                if future.result():
                    refused += 1
            except futures.CancelledError:
                continue
            except llm.QuotaExhausted as exc:
                # Not this clause's problem and not survivable: every clause
                # after it would fail the same way, and the run is worth
                # retrying once the customer's credit is back. Stop handing out
                # work, let what is in flight finish, and raise below so the
                # job layer backs off.
                quota = exc
                for other in running:
                    other.cancel()
                break
            except Exception as exc:  # noqa: BLE001 — one clause must not cost the other ninety-nine
                # A clause that cannot be judged is recorded as needing a
                # person, and the run goes on.
                #
                # Before this, anything raised here — a model returning JSON
                # that does not parse, a provider 500, one unreadable figure —
                # aborted the whole run. The clauses already committed stayed
                # (each is its own transaction), the rest were never attempted,
                # and the report opened showing however few had landed before
                # the failure, with a dead-lettered job as the only trace.
                #
                # `needs_review` rather than a silent skip: the clause was in
                # scope and was not judged, and the one thing the report must
                # not do is imply it passed.
                refused += 1
                logs.warn(
                    log,
                    "clause could not be judged, continuing",
                    runId=run_id,
                    clauseId=clause["id"],
                    clauseRef=clause.get("numberText") or clause["id"],
                    error=f"{type(exc).__name__}: {exc}"[:300],
                )
                try:
                    _write(
                        run_id,
                        clause,
                        verdict="needs_review",
                        confidence=0.0,
                        rationale=(
                            "This clause could not be assessed: the model did not return a "
                            "usable answer for it. Nothing is implied about the design. Run "
                            "the assessment again to retry this clause."
                        ),
                        evidence=[],
                        retrieval_score=0.0,
                        applied=[],
                        design_id=design_id,
                    )
                except Exception as write_exc:  # noqa: BLE001 — the database is the one thing worth stopping for
                    logs.warn(
                        log,
                        "clause failure could not be recorded",
                        runId=run_id,
                        clauseId=clause["id"],
                        error=str(write_exc)[:200],
                    )

            finished += 1
            heartbeat()
            progress.step(step_label, done=completed + finished, total=len(tasks))
            # Every clause, not every fifth. Batching the write held the
            # progress bar still long enough that a run in perfect health read
            # as a hung one, which is what a progress bar exists to rule out.
            # The cost is one small UPDATE against a row already in cache; the
            # model calls beside it dwarf it.
            if _progress(run_id, completed + finished) == 0:
                logs.info(
                    log,
                    "run is no longer running, abandoning it",
                    runId=run_id,
                    clausesDone=completed + finished,
                )
                for other in running:
                    other.cancel()
                stopped = True
                break
    # The pool is shut down by here, so nothing is still writing findings for a
    # run that is being abandoned or a key that is spent.
    if quota is not None:
        raise quota
    if stopped:
        with db.transaction() as conn:
            queue.complete(conn, job, chain=False)
        return
    # Said once, at the end, rather than only per clause: a run where the model
    # failed on a third of the framework is still a complete run, and whoever
    # reads the log should see that in one line instead of counting warnings.
    if refused:
        logs.warn(
            log,
            "clauses that could not be judged",
            runId=run_id,
            refused=refused,
            clauses=len(clauses),
        )

    # Search shows the judge eight passages, so "absent" is the one verdict it
    # cannot really reach: a claim about everywhere it did not look. Every clause
    # that came back absent is read again against the whole document — one call
    # for the lot, not one per clause — and a verdict changes only on a quote
    # found in the document word for word. A whole-document run has already read
    # everything, so this is for search runs alone. Never fails the run.
    if whole is None:
        progress.step("Re-reading what looked absent")
        heartbeat()
        _confirm_absents(run, clauses, scope)

    # And the same doubt pointed the other way. The pass above exists because a
    # search cannot see everywhere it did not look; this one exists because
    # every guard in this module is demote-only and fires on a verdict with no
    # verified quote, so a "covered" that quotes the design correctly and draws
    # the wrong conclusion from it passed all of them untouched.
    #
    # Run in both modes, unlike the absent re-read. Reading the whole document
    # does not protect against this one — on the run that found it, the
    # whole-document judge had the breaching sentence in its own cited evidence
    # and called the clause covered anyway. Never fails the run.
    progress.step("Re-reading what looked covered")
    heartbeat()
    _review_covered(run, clauses)

    # The reverse question: what the design does that no clause governs, and the
    # standards that would. After the clauses, so a passage a clause has already
    # judged is never reported as ungoverned. Never fails the run; see coverage.py.
    progress.step("Finding parts of the design no standard covers")
    heartbeat()
    coverage.record(run, clauses, scope.designs)

    # Whether the products the design builds on are still supported, from public
    # lifecycle data — facts beside the findings, never a verdict. Only product
    # ids are looked up. Never fails the run; see lifecycle.py.
    #
    # Before the suggestions, not after. This is the only stage that reads
    # today's dates from outside, and the suggestions stage is forbidden to
    # claim a version is out of support from its own training (rule 9 in
    # llm._ADVICE_SYSTEM). Run the other way round, as it was, a reviewer got
    # the support dates in one part of the report and "confirm the support
    # status" in the other, because the model with the advice in it was the one
    # kept in the dark. Now the established facts go into that call, so a
    # suggestion can name the version to move to.
    progress.step("Checking the technologies' support dates")
    heartbeat()
    support = lifecycle.record(run, scope.designs)

    # What an experienced reviewer would still ask of the design, beyond the
    # standards. Last, and in its own call, so it can draw on every finding above
    # and can never soften one. Never fails the run; see advice.py.
    progress.step("Suggesting improvements to the design")
    heartbeat()
    advice.record(
        run,
        scope.designs,
        fresh=bool(job.payload.get("freshAdvice")),
        # Empty whenever the check was skipped, unreachable or found everything
        # supported, which is the ordinary case and asks the question this stage
        # asked before. A failed lookup never costs the run its suggestions.
        lifecycle=lifecycle.for_advice(
            support, scope.designs, document_id=run.get("documentId")
        ),
    )

    # Which of the findings come from one fact about the design. Last, because
    # it reads the findings against each other and every one of them has to be
    # settled first — including the ones the absent re-read changed.
    #
    # It groups and never merges: each finding keeps its clause, its verdict and
    # its own review decision, so a breached clause stays answerable as that
    # clause. Never fails the run; see rootcause.py.
    progress.step("Grouping findings that share a cause")
    heartbeat()
    rootcause.record(run)

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

    # Carries the clauses that could not be judged, so the run can say its
    # coverage was not total rather than reporting a clean completion.
    _complete(job, run_id, refused)


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
        scope = designs.for_run(conn, run)

    heartbeat()
    fresh = bool(job.payload.get("freshAdvice"))
    # The support facts this run already established, read back off the run
    # rather than looked up again: a new set of suggestions should rest on the
    # same dates the report beside it states, and re-reading endoflife.date here
    # would let the two disagree. A run from before the column existed, or whose
    # check did not complete, gives an empty mapping and the question this path
    # asked before.
    stored = run.get("lifecycle")
    result = advice.record(
        run,
        scope.designs,
        fresh=fresh,
        lifecycle=lifecycle.for_advice(
            stored if isinstance(stored, dict) else {},
            scope.designs,
            document_id=run.get("documentId"),
        ),
    )
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


def _read_intake(job: Job, request_id: str) -> None:
    """Fill in what the attached designs already answer, and nothing else.

    Queued from the intake wizard by a requestor who would rather not retype
    their own design. The request's answers are untouched: this writes
    proposals, and a person accepts them — see Workers/aidp/request_intake.py
    for the checks every proposal passes first.

    The questions come down on the payload rather than being listed in Python,
    so the catalogue has one definition (src/lib/ingest/reading-vocabulary.ts)
    instead of two that drift.
    """
    progress.step("Reading the attached designs for the answers")
    questions = job.payload.get("questions")
    result = request_intake.record(
        request_id, questions if isinstance(questions, list) else []
    )
    with db.transaction() as conn:
        queue.complete(conn, job)
    logs.info(
        log,
        "intake reading finished",
        jobId=job.id,
        requestId=request_id,
        state=result.get("state"),
        proposed=result.get("proposed"),
    )


def _draft_standard(job: Job, draft_id: str) -> None:
    """Write the requirement lines one clause was missing, and nothing else.

    Queued from a report by a reviewer who has confirmed a `partial`. The
    verdicts, the run and the findings are untouched: this proposes an addition
    to the standards library, which a person then approves or throws away. See
    Workers/aidp/standards.py for the checks every line passes first.
    """
    progress.step("Writing the requirement lines this clause was missing")
    result = standards.record(draft_id)
    with db.transaction() as conn:
        queue.complete(conn, job)
    logs.info(
        log,
        "clause sharpening finished",
        draftId=draft_id,
        state=result.get("state"),
        requirements=len(result.get("requirements") or []),
    )


def _framework_clauses(conn, framework_id: str) -> list[dict]:
    """Every clause in the framework, in document then reading order.

    Reads through the join rather than by document id so that adding a document
    to a framework is the only thing needed to bring its clauses into scope.
    """
    return db.query(
        conn,
        """
        SELECT cl."id", cl."ordinal", cl."title", cl."statement", cl."rationale",
               (SELECT count(*) FROM "clause" sib
                 WHERE sib."sectionId" = cl."sectionId"
                   AND sib."supersededById" IS NULL) AS "siblings",
               cl."requirements", cl."guidance", cl."sourceRefs",
               s."headingPath", s."numberText", s."pageStart",
               d."title" AS "documentTitle", f."isBaseline"
          FROM "framework_document" fd
          JOIN "framework" f  ON f."id" = fd."frameworkId"
          JOIN "document" d   ON d."id" = fd."documentId"
          JOIN "document_section" s ON s."documentId" = d."id"
          JOIN "clause" cl    ON cl."sectionId" = s."id"
         WHERE fd."frameworkId" = %s
           -- The live version only. A sharpened clause keeps its ordinal and
           -- its retired version keeps the text it was judged against, so
           -- without this every sharpened clause would be judged twice and the
           -- report would show two of it.
           AND cl."supersededById" IS NULL
           -- And only what this organisation still requires. A design cannot
           -- breach a rule its owner has set aside, and reporting one as a gap
           -- would be the engine arguing with the customer about their own
           -- standards.
           --
           -- Written as "not suspended" rather than "is active" on purpose:
           -- only an explicit suspension takes a clause out of scope, so an
           -- unexpected value still gets judged. The alternative fails silent,
           -- and a clause that stops being assessed without saying so is the
           -- worst way for this column to go wrong. Matches `readClauseStatus`,
           -- which reads anything it does not recognise as active.
           AND cl."status" <> 'suspended'
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
    # How strongly the judge read the clause as binding, before this engine's own
    # reading of it gets the last word. Carried rather than resolved here so
    # `_write` applies one rule for every path — see `obligations.resolve`.
    obligation: str = ""
    # How many independent readings of this clause were taken, and how many of
    # them reached the verdict above. Recorded on the finding, because "three of
    # three readings agreed" and "two of three" are different claims and a
    # reviewer deciding what to look at first is entitled to know which this is.
    readings: int = 1
    agreed: int = 1
    # What the readings that disagreed said: [{verdict, rationale}].
    #
    # Kept rather than discarded, for the reason `reviewerVerdict` sits beside
    # `verdict` rather than over it — the disagreement is the evaluation data.
    # A minority reading of "contradicts" under a majority "covered" is the
    # single most useful line in the report for whoever has to sign it off, and
    # throwing it away would leave the vote asserting a confidence it does not
    # have.
    dissent: list[dict] = field(default_factory=list)
    # What the model answered, before `_normalise` and the guards touched any of
    # it: (verdict, confidence, rationale). Carried from the reading that won
    # the vote, so a replay reads the answer the finding was actually built on.
    #
    # Empty on the two paths that reach a verdict without asking a model — a
    # clause every reading failed on, and a design with nothing retrieved —
    # where there is no model answer to keep and `_write` falls back to the
    # finding's own.
    raw: tuple[str, float, str] | None = None
    # What a reading would have been had the opening words of its quote counted:
    # (verdict, rationale, evidence), set only when `_guard_document` demoted it
    # for a quote that did not verify whole while the first words of that quote
    # do sit in the document. A reading never uses this on its own; `_rescue`
    # does, and only when most readings agree. See there.
    held: tuple[str, str, list[dict]] | None = None


# What a dissenting reading's rationale is cut to. It is context beside the
# verdict that won, not the finding itself.
MAX_DISSENT = 240


def _settled(taken: list[_Judged], readings: int) -> bool:
    """Whether the readings still to come could change which verdict leads.

    The early stop, and it stops on the one condition that makes stopping free:
    the leader cannot be caught. Taking another reading when the answer is
    already decided buys nothing, and the extra readings are the whole cost of
    reading a clause more than once.

    With three readings that means two agreeing ends it — a third cannot
    overturn a 2-0 lead — so an uncontested clause costs two and only a
    contested one costs three. That is exactly a best-of-three, reached in
    fewer calls: for a clause the model favours with probability p, this yields
    its favourite with probability p² + 2p(1-p)·p, which is p³ + 3p²(1-p). The
    same number. The early stop is an implementation of the vote, not an
    approximation of it.

    It has to be read against `readings` rather than against the constant 2,
    which is the bug this replaces. Stopping at any two agreeing made
    JUDGE_READINGS=5 behave as 3 — the fourth and fifth readings were only ever
    reached on a three-way split — so the setting looked like it was doing
    something while changing almost nothing, and two measurements of the same
    algorithm got read as a trend.
    """
    if len(taken) < 2:
        return False
    ranked = Counter(judged.verdict for judged in taken).most_common()
    leader = ranked[0][1]
    runner_up = ranked[1][1] if len(ranked) > 1 else 0
    remaining = max(0, readings - len(taken))
    return leader > runner_up + remaining


# The fewest words of a quote that may stand in for the whole of it. Shorter
# than this is a phrase that could sit anywhere in a design.
MIN_PREFIX_WORDS = 8

# Verdicts a partly verified quote may carry. `not_applicable` and
# `not_assessable` are held to the strictest proof and are never rescued.
_RESCUABLE = ("covered", "partial", "contradicts")


def _prefix_evidence(unverified: list[tuple[str, str]], whole) -> list[dict]:
    """Evidence from the longest opening stretch of each refused quote that is
    the document's own words.

    A model copying a table row tends to start on a real row and then splice
    cells or lose a separator, so the quote as a whole is not a subsequence of
    the page while its first words plainly are. Only the words that were found
    are kept as the excerpt, never the model's full quote, so the finding does
    not claim a sentence the document does not contain.
    """
    out: list[dict] = []
    for quote, _reason in unverified[:MAX_QUOTES]:
        words = quote.split()
        if len(words) <= MIN_PREFIX_WORDS:
            continue
        for size in range(len(words) - 1, MIN_PREFIX_WORDS - 1, -1):
            head = " ".join(words[:size])
            check = whole.verify(head, None)
            if check.verified and check.source_kind != "figure":
                out.append(
                    {
                        "chunkId": f"quote-{len(out) + 1}",
                        "headingPath": "",
                        "page": check.page,
                        "excerpt": head[:1500],
                        "sourceKind": "quote",
                        "figureId": None,
                        "claimedPage": None,
                        "partial": True,
                    }
                )
                break
    return out


# One entry of the stack block `stack.render` prints beside a technology clause:
# the stack's record of a technology, then the design's own words naming it.
_STACK_ENTRY = re.compile(r"^- (?P<head>[^\n]+)\n  Design says: (?P<says>[^\n]+)$", re.M)
# The opening of the block that lists those entries.
_STACK_LIST = "Technologies this design names"
# Letters and digits a quote must share with a snippet's text to be taken as a
# copy of it: about eight words, so a common phrase cannot claim an entry.
MIN_SNIPPET_MATCH = 40


def _flat(text: str) -> str:
    """Letters and digits only: a stack line survives a mangled dash this way."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _unclipped(snippet: str) -> str:
    """A `stack._around` snippet without the part-words its cut left at each end."""
    words = snippet.split()
    if snippet.startswith("…") and len(words) > 1:
        words = words[1:]
    if snippet.endswith("…") and len(words) > 1:
        words = words[:-1]
    return " ".join(words).strip("…").strip()


# Where `stack.design_text` joins what the document prints apart: table cells
# ("column 3:"), a heading trail ("›"), a figure's bullets ("•"), cell ends
# (".."), and a row's label from its value (" — " where the page prints "|").
_SNIPPET_SEAMS = re.compile(r"\s*(?:\.\.+|column \d+:|›|•|\|)\s*|\s+—\s+|(?<=[.!?])\s+")


def _design_words(says: str, name: str, whole):
    """The stretch of a stack snippet that is in the document, as (text, check).

    The snippet comes from the stack module's flattened copy of the design, in
    which a table row reads "column 2: … column 3: S3, Glue, Redshift" and runs
    on across a heading. Whole, that is often not the document's wording. Each
    piece between those seams may be, and the longest one that still names the
    technology is taken: a piece that does not name it is no evidence of it.
    Nothing that fails `verify` is ever returned.
    """
    text = _unclipped(says.strip())
    if not text:
        return None
    check = whole.verify(text, None)
    if check.verified:
        return text, check
    # Named the way the stack module found it in the first place, so
    # "Amazon Redshift" is named by a piece that says "Redshift".
    patterns = [found for found, _ in stack._searchable(stack.Row(name, ""))] if name else []
    pieces = [p.strip(" .,;:—") for p in _SNIPPET_SEAMS.split(text)]
    pieces = [
        p
        for p in pieces
        if len(p.split()) >= whole_document.MIN_QUOTE_WORDS
        and (not name or any(found.search(p) for found in patterns))
    ]
    for piece in sorted(pieces, key=len, reverse=True):
        check = whole.verify(piece, None)
        if check.verified:
            return piece, check
    return None


def _copied(quote: str, named: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """The entries whose "Design says" snippet this quote is a copy of.

    Matched on the quote's opening, cell labels dropped, so a copy that starts
    where the snippet does is found whatever the punctuation became. Each keeps
    its technology's name, so what stands in for the copy must still name it.
    """
    unlabelled = lambda text: _flat(re.sub(r"column \d+:", "", text))  # noqa: E731
    opening = unlabelled(_unclipped(quote.strip()))[:MIN_SNIPPET_MATCH]
    if len(opening) < MIN_SNIPPET_MATCH:
        return []
    return [(name, says) for name, says in named if opening in unlabelled(says)]


def _stack_quotes(
    unverified: list[tuple[str, str]], stack_block: str, whole
) -> tuple[list[dict], list[tuple[str, str]]]:
    """Answer a quote of the stack record with the design's words it was built from.

    A judge reading a technology clause has the organisation's stack printed
    under it, and it often quotes that — "Amazon Redshift — recorded as Hold,
    approved versions: RA3 / Serverless" — as its evidence. Those words are ours,
    not the design's, so the quote guard refuses them. On Meridian that sent
    readings of EA-007 (Redshift and Oracle on Hold) and EA-008 (Mirth Connect
    not in the stack), both breaches the readings had found, to needs_review.

    Every entry in the block carries the design's own words naming the
    technology ("Design says: …"). Those words are what the stack line stands
    for, so they are the evidence: checked against the document like any quote,
    and kept only if found there. A quote is taken as a stack line when it
    names an entry and its recorded position, when it is the list's heading
    (which stands for every entry), or when it copies an entry's snippet. The
    record itself is never evidence, and any other quote is left as refused.
    """
    if not stack_block or not unverified:
        return [], unverified
    entries = [(m["head"], m["says"]) for m in _STACK_ENTRY.finditer(stack_block)]
    if not entries:
        return [], unverified

    found: list[dict] = []
    seen: set[str] = set()
    remaining: list[tuple[str, str]] = []
    for quote, reason in unverified:
        flat = _flat(quote)
        named = [(head.split(" — ")[0], says) for head, says in entries]
        if "design says:" in quote.lower():
            # A snippet quoted with its label: the snippet is what it stands for.
            sayings = _copied(quote[quote.lower().rindex("design says:") + len("design says:") :], named)
        elif _flat(_STACK_LIST) in flat:
            sayings = named
        else:
            sayings = [
                (name, says)
                for (name, says), (head, _) in zip(named, entries)
                if _flat(name) and _flat(name) in flat and ("recordedas" in flat or flat in _flat(head))
            ] or _copied(quote, named)
        kept = 0
        for name, says in sayings:
            if len(found) >= MAX_QUOTES:
                break
            located = _design_words(says, name, whole)
            if not located or located[0] in seen:
                continue
            text, check = located
            seen.add(text)
            kept += 1
            found.append(
                {
                    "chunkId": f"stack-{len(found) + 1}",
                    "headingPath": "",
                    "page": check.page,
                    "excerpt": text[:1500],
                    # As `_checked_quotes` labels them: words found only in a
                    # diagram description go to the guards as a figure.
                    "sourceKind": check.source_kind if check.source_kind == "figure" else "quote",
                    "figureId": check.figure_id,
                    "claimedPage": None,
                }
            )
        if not kept:
            remaining.append((quote, reason))
    return found, remaining


def _rescue(taken: list[_Judged]) -> list[_Judged]:
    """Give back a verdict the quote guard took from readings that agreed.

    `_guard_document` demotes a reading whose quote does not verify, and it
    cannot tell an invented quote from a real row copied badly. On the Meridian
    run that cost INT-002 and three other clauses the key marks covered: every
    reading said covered and every quote opened on a real row.

    A wrong "covered" is the expensive error, so the standard is not lowered for
    one reading. It is lowered only where at least two readings independently
    reached the same verdict, each with a quote whose opening words are the
    document's own, and where that verdict leads every other final answer. The
    readings concerned are given the verdict and the located words as their
    evidence, and the rationale says plainly that the quote was only partly
    verified. A lone reading, a split, or a reading whose opening words are not
    in the document is left demoted, exactly as before.
    """
    held = Counter(judged.held[0] for judged in taken if judged.held)
    if not held:
        return taken
    verdict, count = held.most_common(1)[0]
    if count < 2:
        return taken
    others = Counter(judged.verdict for judged in taken if not judged.held)
    if others and max(others.values()) >= count:
        return taken
    note = (
        "(The quote was only partly verified: its opening words are in the document, "
        f"the rest could not be matched. {count} of {len(taken)} readings reached this verdict.)"
    )
    rescued: list[_Judged] = []
    for judged in taken:
        if judged.held and judged.held[0] == verdict:
            _, rationale = _noted(verdict, note, judged.held[1])
            rescued.append(
                replace(judged, verdict=verdict, rationale=rationale, evidence=judged.held[2], held=None)
            )
        else:
            rescued.append(judged)
    return rescued


def _vote(taken: list[_Judged]) -> _Judged:
    """One verdict out of several readings of one clause: what most of them said.

    The same discipline as `coverage.agree`, applied to the thing the product
    is. A model asked the same question twice does not answer it the same way
    twice — two runs over one design came back 9 absent and 4 needing review,
    then 7 and 7 — and an assessment that moves between Tuesday and Thursday is
    not one an architecture board can be shown. Reading each clause more than
    once and keeping what most readings said is what makes a run repeatable.

    Voting happens *after* the guards, on final answers, not on the model's raw
    replies. A reading the guards demoted votes for the demotion, which is
    right: it is this engine's answer for that reading, and the whole point of
    the guards is that they are part of the verdict rather than a filter over it.

    No majority is not a verdict. Where the readings split with nothing ahead —
    three readings, three answers — the clause goes to a person, with every
    reading's answer attached. That is the honest result, and it is a better
    finding than any one of the three: the engine knows the clause is contested,
    and says so, rather than picking a winner by arrival order.
    """
    if len(taken) == 1:
        return taken[0]

    taken = _rescue(taken)
    ranked = Counter(judged.verdict for judged in taken).most_common()
    leader, votes = ranked[0]
    split = len(ranked) > 1 and ranked[1][1] == votes

    # Among the readings that agree, the one that was surest of itself carries
    # the rationale and the evidence. They reached the same verdict, so this
    # chooses between wordings rather than between answers.
    chosen = max(
        (judged for judged in taken if judged.verdict == leader),
        key=lambda judged: judged.confidence,
    )
    dissent = [
        {"verdict": judged.verdict, "rationale": _shorten(judged.rationale, MAX_DISSENT)}
        for judged in taken
        if judged.verdict != leader
    ]

    if split:
        others = ", ".join(f"{verdict} x{count}" for verdict, count in ranked)
        verdict, rationale = _demoted(
            f"Read {len(taken)} times with no answer in the majority ({others}).",
            chosen.rationale,
        )
        return replace(
            chosen,
            verdict=verdict,
            rationale=rationale,
            readings=len(taken),
            agreed=votes,
            dissent=dissent,
        )

    return replace(chosen, readings=len(taken), agreed=votes, dissent=dissent)


def _read_and_vote(
    judge_once,
    readings: int,
    *,
    best: float,
    clause: dict,
) -> _Judged:
    """Judge one clause `readings` times, stopping early on agreement, and vote.

    A reading that fails is not a reading that voted. It is logged and skipped,
    and the next one is taken — one provider hiccup out of three should not put
    a clause in front of a person. Only a clause where *every* reading failed
    comes back unjudged, which is the single-reading behaviour and says so.

    `QuotaExhausted` is the exception to all of this and is re-raised. It is not
    this clause's problem: every clause after it would fail the same way, and a
    run that swallowed it would write a hundred "could not be judged" findings
    and then report itself complete — which is how a spent key reached a
    customer's report looking like a hundred unanswerable clauses.
    """
    taken: list[_Judged] = []
    failure = ""
    failure_kind = ""
    for reading in range(max(1, readings)):
        try:
            taken.append(judge_once(reading))
        except llm.QuotaExhausted:
            raise
        except Exception as exc:  # noqa: BLE001 — one reading must not cost the clause
            failure = f"{type(exc).__name__}: {exc}"
            failure_kind = type(exc).__name__
            logs.warn(
                log,
                "one reading of a clause failed, continuing",
                clauseId=clause["id"],
                reading=reading,
                error=failure[:200],
            )
        if _settled(taken, readings):
            break

    if not taken:
        return _Judged(
            "needs_review",
            0.0,
            # The provider's own error body must never reach this string. This is
            # the customer-facing rationale, printed into a compliance report —
            # and interpolating `failure` here put a raw
            # {"error":{"message":...,"metadata":{"raw":...}}} payload into 596
            # stored findings, a quarter of every finding in the database. The
            # exception type is as much as a reader can act on; the full failure
            # is on the warn above, which is where a diagnostic belongs.
            "This clause was not judged: the model's answer could not be read. "
            "Run the assessment again."
            + (f" ({failure_kind})" if failure_kind else ""),
            [],
            [],
            best,
            # Nought readings, not one. The defaults on `_Judged` are
            # `readings=1, agreed=1`, which here would claim a single reading
            # that agreed with itself — about a clause where every reading
            # failed.
            #
            # It also has to be counted. `refused` in `handle` increments only
            # in the pool's `except` arm, and this path does not raise: it
            # returns a finding, deliberately, so the clause reaches the report
            # as a question rather than vanishing. The run-level note in
            # `_complete` ("N of M clauses could not be assessed") therefore
            # never fired for the one failure it most needs to describe — a
            # provider degrading across a whole run rather than one clause
            # tripping. `readings == 0` is what the callers test to count it.
            readings=0,
            agreed=0,
        )
    return _vote(taken)


def _assess_one(
    run: dict,
    clause: dict,
    scope: designs.Scope,
    document: str = "",
    *,
    design_id: str | None = None,
    stack_block: str = "",
) -> bool:
    """Retrieve, judge, guard, commit — one clause, one transaction.

    Returns whether the clause was refused: every reading of it failed and what
    was committed is a `needs_review` standing in for an answer. The caller adds
    that to the run's `refused` tally, which decides whether `_complete` says
    the assessment was partial. See the `readings=0` note in `_read_and_vote`.
    """
    query = retrieval.clause_query(
        clause["statement"], clause["requirements"] or [], clause["title"]
    )

    # One embedding for the clause, shared by both lookups below. They search
    # different tables with the same question, and paying for it twice would
    # double the embedding bill of every run.
    vector = retrieval.embed_query(query)
    precedents = _precedents(run, clause, query, vector, scope)
    judged = _judge_by_search(
        run,
        clause,
        scope=scope,
        query=query,
        vector=vector,
        precedents=precedents,
        document=document,
        readings=get_config().judge_readings,
        stack_block=stack_block,
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
        judged_obligation=judged.obligation,
        design_id=design_id,
        readings=judged.readings,
        agreed=judged.agreed,
        dissent=judged.dissent,
        raw=judged.raw,
    )
    return judged.readings == 0


def _precedents(
    run: dict, clause: dict, query: str, vector: str, scope: designs.Scope
) -> list:
    """What this organisation has already settled about this clause.

    Scoped as well as retrieved: a ruling the board granted to one project is
    weighed on that project's assessments and on no others, so the scope is
    passed rather than looked up again. See Workers/aidp/decisions.py.
    """
    with db.connection() as conn:
        return decisions.for_clause(
            conn,
            organisation_id=run["organisationId"],
            clause_ref=str(clause["numberText"] or clause["headingPath"] or ""),
            query=query,
            limit=PRECEDENTS,
            vector=vector,
            project_id=scope.project_id,
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
    scope: designs.Scope,
    query: str,
    vector: str,
    precedents: list,
    document: str = "",
    readings: int = 1,
    stack_block: str = "",
) -> _Judged:
    """The passages a search finds for the clause, judged and guarded.

    The whole of a retrieval-mode assessment, and the second opinion a
    whole-document assessment asks for before it will call anything absent.

    The search runs once however many readings are taken. It is deterministic —
    the same clause makes the same query, which makes the same vector and the
    same lexical match — so repeating it would buy nothing and would bill the
    embedding provider once per reading. What varies between readings is the
    judgement, which is the part that varies in the first place.
    """
    reference = f"{clause['documentTitle']} — {clause['headingPath']}"
    with db.connection() as conn:
        candidates = retrieval.search(
            conn,
            organisation_id=run["organisationId"],
            document_ids=scope.document_ids,
            titles=scope.titles,
            query=query,
            limit=CANDIDATES,
            vector=vector,
        )

    best = candidates[0].score if candidates else 0.0

    if not candidates:
        # Nothing in the submitted document at all. Only reachable when it has
        # no chunks, which the caller should have prevented.
        return _Judged(
            "needs_review",
            0.0,
            "No content was retrieved from the submitted design."
            if len(scope.designs) == 1
            else "No content was retrieved from any of the project's designs.",
            [],
            [],
            0.0,
        )

    def once(reading: int) -> _Judged:
        raw = llm.judge(
            reference=reference,
            clause=_render_clause(clause, stack_block=stack_block),
            extracts=_render_extracts(
                candidates, named=len(scope.designs) > 1 or scope.alternatives
            ),
            # How the clause is to be read: one design, several that describe
            # one solution between them, or several that are rival candidates.
            # See llm._SCOPE_RULE and llm._ALTERNATIVES_RULE.
            #
            # The third case is why this is not just a count. A reviewer
            # comparing two candidate solutions was getting one verdict over
            # both, so a control in candidate A covered its absence in B and the
            # report could not say which candidate was better on anything — and
            # the prompt was contradicting itself, since `_purpose` already told
            # the judge the designs were alternatives while the scope rule told
            # it a requirement met in any one of them was met.
            designs=len(scope.designs),
            # Read from the project's own `designRelationship`, which the owner
            # sets on the project form — not inferred from the description.
            # Inference was the first attempt here and it is the weaker answer:
            # a reviewer who writes "comparing our options for the portal" in a
            # one-solution project would have had every clause judged as a
            # contest between its own documents.
            alternatives=scope.alternatives,
            precedents=decisions.render(precedents),
            document=document,
            # Which reading this is. Reading zero is deterministic; the ones
            # after it are sampled on their own seed, or three readings would
            # be one opinion billed three times. See `llm.judge_sampling`.
            reading=reading,
        )
        return _judged_from(raw, clause, candidates, precedents, best)

    return _read_and_vote(once, readings, best=best, clause=clause)


def _judged_from(
    raw: dict,
    clause: dict,
    candidates: list[retrieval.Candidate],
    precedents: list,
    best: float,
) -> _Judged:
    """One reply from the judge, normalised, checked against the extracts, guarded.

    Split out of `_judge_by_search` so that every reading of a clause goes
    through exactly the same checks before it is allowed to vote. A reading the
    guards demoted votes for the demotion — see `_vote`.
    """
    verdict, confidence, rationale, cited, claimed = _normalise(raw, clause)
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
            # Which design it came from. On a project run "page 12" is not an
            # address on its own, and the reviewer has to know which file to
            # open. Empty on findings from before projects existed.
            "documentId": c.document_id,
            "documentTitle": c.document_title,
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
        offered=len(precedents),
        conflicted=decisions.conflicting(precedents),
        # Without the obligation line or the stack: see `_render_clause`.
        clause_text=_render_clause(clause, with_force=False),
        figure_text=" ".join(
            c.excerpt for cid in cited_figures if (c := by_id.get(cid)) is not None
        ),
    )
    # After the guard, not before: the guard can demote a contradiction to
    # needs_review, and a quote presented as the breach on a verdict that is
    # no longer a breach would be the UI asserting something nothing stands
    # behind any more.
    if verdict == "contradicts":
        _mark_breach(evidence, raw.get("breach"), by_id)

    return _Judged(
        verdict, confidence, rationale, evidence, applied, best,
        obligation=str(raw.get("obligation") or ""),
        raw=_raw_answer(raw),
    )


# ---------------------------------------------------------------------------
# Whole-document mode
# ---------------------------------------------------------------------------

#: What a run can be asked for. "auto" is the default and is not a third way of
#: reading a design — it is the engine choosing between the two, which it is
#: better placed to do than the person pressing the button: whether a design
#: fits a whole-document read is a question about its token count.
MODES = ("retrieval", "document")
AUTO = "auto"

# Quotes checked per verdict. A reply quoting more than this is padding, and
# every quote is a search through the whole document.
MAX_QUOTES = 8


def _resolve_mode(
    run: dict, scope: designs.Scope
) -> tuple[str, str | None, whole_document.WholeDocument | None]:
    """(mode this run can use, why it is not the one asked for, the document).

    A whole-document run that cannot read the whole document says so and falls
    back to search rather than failing — a report by the older method is worth
    more than none, as long as nobody mistakes which method produced it.

    A project run always searches. Concatenating several designs into one text
    would put three "page 4"s in front of a judge whose every quote is checked
    by page, and on any real project the whole would pass the token budget — at
    which point this would fall back to search anyway, silently. Search across
    the designs reaches the same verdicts with every quote still checked against
    the design it came from, and the absent re-read still reads each design
    whole, one at a time.

    "auto" — the default — resolves here rather than at the button, because the
    thing it turns on is the design's token count and nobody pressing assess
    knows that. It reads a single design whole whenever it fits, which is the
    stronger method and the one that cannot report a clause absent because the
    passage answering it fell outside a window of eight. An explicit
    "retrieval" is still honoured: a reviewer who asked for search gets search.
    """
    wanted = run.get("mode") or "retrieval"
    auto = wanted == AUTO
    if auto:
        wanted = "document" if get_config().prefer_whole_document else "retrieval"

    if len(scope.designs) != 1:
        asked = wanted == "document" and not auto
        return (
            "retrieval",
            (
                "Assessed by search across the project's designs. Reading several designs as "
                "one text would make every page number ambiguous; each design is still read "
                "whole for anything the search reported absent."
            )
            if asked
            else None,
            None,
        )
    if wanted != "document":
        return "retrieval", None, None
    only = scope.designs[0]
    with db.connection() as conn:
        whole = whole_document.load(conn, only.document_id, only.title)
    # An auto run was not promised a whole-document read, so falling back to
    # search is not a failed request and does not read as one. It still says
    # which method produced the results, which is the part that matters: a
    # reader must never have to guess how a verdict was reached.
    if whole is None:
        return (
            "retrieval",
            "Assessed by search. This document was processed before its pages were stored, "
            "so it cannot be read whole yet — reprocess it to assess it that way."
            if auto
            else "Assessed by search, not by reading the whole document: this document was "
            "processed before its pages were stored. Reprocess it, then run the "
            "whole-document assessment again.",
            None,
        )
    limit = get_config().whole_document_max_tokens
    if whole.tokens > limit:
        return (
            "retrieval",
            f"Assessed by search. At about {whole.tokens:,} tokens this design is longer "
            f"than the {limit:,} a whole-document assessment reads at once."
            if auto
            else f"Assessed by search, not by reading the whole document: it is about "
            f"{whole.tokens:,} tokens, more than the {limit:,} a whole-document "
            "assessment reads at once.",
            None,
        )
    return "document", None, whole


def _contrary_practice(verdict: str, rationale: str, raw: dict, whole) -> tuple[str, str]:
    """Let the model's own finding of fact overturn a hedge. Promote-only.

    The measured failure this answers: on twenty-one clauses that six
    consecutive runs all got wrong the same way, the model retrieved the
    sentence in which this design does what the clause forbids, wrote it out
    correctly in prose, and graded the clause "partial". Asking for the
    sentence as a field rather than for the label is the difference between an
    extractive question and a seven-way classification, and the two disagree on
    exactly the clauses that decide a report.

    Three things have to hold before a verdict moves, and the order is the
    point:

      1. the model says it found a contrary practice;
      2. the sentence it quotes is the document's own, word for word, by the
         same `verify` every piece of evidence goes through — so a breach
         asserted here and nowhere in the design is refused exactly as an
         invented evidence quote is;
      3. the document does not RECORD an exception for it. A carve-out the
         design merely describes is a breach being narrated; one it records as
         requested, risk-assessed, time-bound or approved is an exception, and
         "partial" is then the honest answer.

    Promote-only, and only from "partial". It cannot invent a pass, it cannot
    reach a clause the model called covered or absent, and `_guard_document`
    still runs afterwards — so a promoted verdict with no verified evidence
    behind it is demoted again by the rule that already exists.

    Off unless `VERDICT_PROCEDURE` is set; see `config.verdict_procedure`.
    """
    if not get_config().verdict_procedure or verdict != "partial":
        return verdict, rationale

    practice = raw.get("contrary_practice") or {}
    if not practice.get("found"):
        return verdict, rationale
    quote = " ".join(str(practice.get("quote") or "").split())
    if not quote or not whole.verify(quote, _page_number(practice.get("page"))).verified:
        return verdict, rationale

    exception = raw.get("recorded_exception") or {}
    if exception.get("found"):
        excused = " ".join(str(exception.get("quote") or "").split())
        if excused and whole.verify(excused, _page_number(exception.get("page"))).verified:
            return verdict, rationale

    return _noted(
        "contradicts",
        "(Graded 'partial', but the design's own words state the breach: "
        f"\u201c{_shorten(quote, MAX_BREACH_QUOTE)}\u201d)",
        rationale,
    )


def judged_document_once(
    clause: dict,
    whole,
    *,
    reference: str,
    stack_block: str = "",
    precedents: list | None = None,
    reading: int = 0,
) -> _Judged:
    """One reading of one clause against the whole document.

    Lifted out of `_assess_document_one` so that it has exactly one
    implementation. `scripts/judge_harness.py` measures this function, and a
    harness that measured its own copy of these six steps would drift from the
    engine silently — which is the one failure a measuring instrument must not
    have.
    """
    offered = precedents or []
    raw = llm.judge_document(
        document=whole.text,
        reference=reference,
        clause=_render_clause(clause, stack_block=stack_block),
        precedents=decisions.render(offered),
        reading=reading,
    )
    verdict, confidence, rationale, _, claimed = _normalise(raw, clause)
    # Before the guards, so a promoted verdict still has to satisfy them.
    verdict, rationale = _contrary_practice(verdict, rationale, raw, whole)
    evidence, unverified = _checked_quotes(raw, whole)
    stacked, unverified = _stack_quotes(unverified, stack_block, whole)
    have = {item["excerpt"] for item in evidence}
    evidence = evidence + [item for item in stacked if item["excerpt"] not in have]
    evidence = evidence[:MAX_QUOTES]
    applied, fabricated = _applied(offered, claimed)
    asked = (verdict, rationale)
    guard_args = dict(
        offered=len(offered),
        conflicted=decisions.conflicting(offered),
        clause_text=_render_clause(clause, with_force=False),
    )
    verdict, rationale = _guard_document(
        verdict,
        confidence,
        rationale,
        evidence=evidence,
        unverified=unverified,
        fabricated=fabricated,
        **guard_args,
    )
    held = None
    if asked[0] in _RESCUABLE and verdict == "needs_review" and not evidence and unverified:
        # The quote guard is what demoted this reading. Work out what the
        # reading would have been had the opening words of its quote counted,
        # running every other guard over it, and hold that for `_rescue`.
        partial = _prefix_evidence(unverified, whole)
        if partial:
            again, again_rationale = _guard_document(
                asked[0],
                confidence,
                asked[1],
                evidence=partial,
                unverified=[],
                fabricated=fabricated,
                **guard_args,
            )
            if again == asked[0]:
                held = (again, again_rationale, partial)
    return _Judged(
        verdict,
        confidence,
        rationale,
        evidence,
        applied,
        0.0,
        obligation=str(raw.get("obligation") or ""),
        raw=_raw_answer(raw),
        held=held,
    )


def _assess_document_one(  # noqa: D401 — see _assess_one for the return
    run: dict,
    clause: dict,
    whole: whole_document.WholeDocument,
    scope: designs.Scope,
    document_context: str = "",
    *,
    stack_block: str = "",
) -> bool:
    """Read the whole document, judge, check every quote, commit — one clause.

    Returns whether the clause was refused, exactly as `_assess_one` does and
    for the same tally.

    Search is not gone from this path; it changes job. It no longer decides what
    the judge sees. It is the second opinion on "absent", the one verdict a
    reading of the whole document can still get wrong without quoting anything.
    That second opinion is given the document summary exactly as a search-mode
    run is, so the two modes' search verdicts on a clause are the same question.
    The stack block rides with it for that same reason. A search asked about a
    technology clause with no sight of the stack answers a different question
    from the one the whole-document reading answered, and `_overrides_absent`
    below would read the disagreement as "one of the two readings missed
    something" — which is how EA-007 was lost once already.
    """
    query = retrieval.clause_query(
        clause["statement"], clause["requirements"] or [], clause["title"]
    )
    reference = f"{clause['documentTitle']} — {clause['headingPath']}"
    vector = retrieval.embed_query(query)
    precedents = _precedents(run, clause, query, vector, scope)

    def once(reading: int) -> _Judged:
        return judged_document_once(
            clause,
            whole,
            reference=reference,
            stack_block=stack_block,
            precedents=precedents,
            reading=reading,
        )

    judged = _read_and_vote(once, get_config().judge_readings, best=0.0, clause=clause)
    verdict = judged.verdict
    confidence = judged.confidence
    rationale = judged.rationale
    evidence = judged.evidence
    applied = judged.applied

    score = 0.0
    if verdict == "absent":
        second = _judge_by_search(
            run,
            clause,
            scope=scope,
            query=query,
            vector=vector,
            precedents=precedents,
            document=document_context,
            readings=get_config().judge_readings,
            stack_block=stack_block,
        )
        # Only a search that *decides* the clause outranks the reading that saw
        # the whole document.
        #
        # A whole-document read has strictly more to go on than eight retrieved
        # chunks, so the search is a safety net against it missing a passage —
        # which is a real risk for "absent", and the reason this check exists.
        # But a search answering "partial" has not found a passage that settles
        # anything; over eight chunks with no surrounding document, "partial" is
        # the cheap hedge, and rule 4 of the judge prompt exists because its
        # evidence is so often an adjacent subject.
        #
        # Taking any citing verdict was costing every absent in the run: EA-007,
        # EA-015 and INF-006 all went to needs_review on a search "partial",
        # EA-015 for a design that names no Databricks, SageMaker or Bedrock
        # anywhere. The check had been quiet only because the search's own
        # verdict used to be demoted before it got here — see `fabricated` in
        # `_guard` — so this is the same bug surfacing in a second place.
        if _overrides_absent(second.verdict, second.evidence):
            # Set here rather than above: on the branches below the verdict stays
            # "absent" and keeps the whole-document read's (empty) evidence, and a
            # retrieval score on a finding that cites nothing describes work that
            # did not support it.
            score = second.best
            verdict = "needs_review"
            rationale = (
                "Reading the whole document found nothing on this clause, but a search of "
                f"the same document found passages judged to address it ({second.verdict}: "
                f"{second.rationale}) One of the two readings missed something — check the "
                f"passages below. Whole-document reading: {rationale}"
            )
            evidence = second.evidence
        elif second.verdict in CITING_VERDICTS and second.evidence:
            # Kept, not discarded: the disagreement is real even where it is not
            # strong enough to overturn the verdict, and a reviewer doubting an
            # absent is exactly who should know a search found something. The
            # search's passages are deliberately not attached — this finding is
            # still "absent", and evidence under it would read as a citation for
            # a verdict that cites nothing.
            verdict, rationale = _noted(
                verdict,
                f"(A search of the same document found passages it judged "
                f"'{second.verdict}'; none of them decides the clause, so this stands.)",
                rationale,
            )

    _write(
        run["id"],
        clause,
        verdict=verdict,
        confidence=confidence,
        rationale=rationale,
        evidence=evidence,
        retrieval_score=score,
        applied=applied,
        judged_obligation=judged.obligation,
        design_id=scope.designs[0].document_id if not run.get("projectId") else None,
        readings=judged.readings,
        agreed=judged.agreed,
        dissent=judged.dissent,
        raw=judged.raw,
    )
    return judged.readings == 0


#: A rationale claiming the design does not state something. "absent" is not
#: the only verdict that makes this claim — a "partial" routinely does, in the
#: half of the clause it says is unmet — and until now only "absent" was read
#: again against the whole document.
#:
#: The failure this exists for: a partial reported that an integration design
#: did not specify a correlation id, while the design's own operational-controls
#: table listed one. The search had not retrieved that table, nothing re-read
#: the document, and the finding reached a report as a confirmed omission.
_CLAIMS_OMISSION = re.compile(
    r"\b(?:not (?:specified|stated|defined|documented|described|addressed|mentioned|"
    r"present|included|provided|covered)"
    r"|no (?:mention|evidence|statement|specification|definition|reference|detail)"
    r"|does not (?:specify|state|define|document|describe|address|mention|include|cover)"
    r"|is (?:missing|absent)|are (?:missing|absent)"
    r"|without (?:any )?(?:stated|specified|documented|defined)"
    r"|fails to (?:specify|state|define|document|mention)"
    r"|neither .{0,40} nor)\b",
    re.IGNORECASE,
)


def claims_an_omission(rationale: str) -> bool:
    """Whether a rationale asserts the design does not say something.

    Used to decide which findings are worth a second read. Deliberately broad:
    the cost of re-reading a finding that did not need it is one more clause in
    an existing batched call, and the cost of missing one is a reviewer sent to
    build what the document already specifies.
    """
    return bool(_CLAIMS_OMISSION.search(rationale or ""))


def _confirm_absents(run: dict, clauses: list[dict], scope: designs.Scope) -> None:
    """Re-read each design whole for every clause the search found nothing for.

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
        _confirm(run, clauses, scope)
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
                # The replay and vote columns come back too, because this
                # rewrites the row and `_write` would otherwise put its own
                # defaults in their place. This pass makes no model call — it is
                # a guard, and `rawVerdict` is meant to hold what the model said
                # *before* a guard touched it (see b15ddde). Letting the demoted
                # verdict land there would make the one column a replay reads
                # the one column a replay must not trust.
                'SELECT "clauseId", "designKey", "confidence", "rationale", '
                '"obligation", "obligationSource", "appliedDecisions", '
                '"readings", "agreed", "dissent", '
                '"rawVerdict", "rawConfidence", "rawRationale" FROM "finding" '
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
                # Carried, not cleared. `appliedDecisions` is why a finding can
                # still explain itself a year later (see the note on the column
                # in schema.prisma); a guard that demotes a verdict has not
                # un-applied the board's decisions, so blanking them here was
                # losing the record rather than correcting it.
                applied=list(row.get("appliedDecisions") or []),
                judged_obligation=_carried_obligation(row),
                design_id=row.get("designKey") or None,
                # Likewise the vote. Three readings with one dissent stays three
                # readings with one dissent; `_write`'s defaults would have
                # rewritten it as a single unanimous reading.
                readings=int(row.get("readings") or 1),
                agreed=int(row.get("agreed") or 1),
                dissent=row.get("dissent") or None,
                raw=(
                    str(row.get("rawVerdict") or ""),
                    float(row.get("rawConfidence") or 0.0),
                    str(row.get("rawRationale") or ""),
                ),
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


def _confirm(run: dict, clauses: list[dict], scope: designs.Scope) -> None:
    """Read each design in scope whole, and overturn what any of them answers.

    One design at a time, never concatenated: every quote the reply gives is
    checked word for word against the design it was read from, and a quote
    checked against another design's text is how an invented one gets through.

    A clause leaves the list the moment one design answers it, so each design
    after that is only asked about what is still outstanding — on a project of
    five designs that is the difference between five full passes and one.
    """
    with db.connection() as conn:
        # Not only "absent". A "partial" that says the design does not specify
        # something is making the same claim about the same document, and it was
        # never checked — which is how a finding reporting a missing correlation
        # id survived beside a design table that listed one. The verdict is not
        # what decides whether a claim of absence is worth verifying; the claim
        # is.
        rows = db.query(
            conn,
            'SELECT "clauseId", "documentId", "verdict", "rationale", '
            '"obligation", "obligationSource", "appliedDecisions" FROM "finding" '
            'WHERE "runId" = %s AND "verdict" = ANY(%s)',
            (run["id"], ["absent", "partial", "not_assessable"]),
        )
    candidates = [
        row
        for row in rows
        if row["verdict"] == "absent" or claims_an_omission(row.get("rationale") or "")
    ]
    if not candidates:
        return

    by_id = {clause["id"]: clause for clause in clauses}
    # The obligation each row is carrying, so a verdict this pass overturns
    # keeps it. `outstanding` below is clauses, not findings, so without this
    # the row's own reading is gone by the time `_write` is called — see
    # `_carried_obligation`. Keyed by design as well as clause because an
    # alternatives run holds one row per candidate design.
    carried = {
        (row["clauseId"], str(row.get("documentId") or "")): _carried_obligation(row)
        for row in candidates
    }
    # And the decisions already applied to each, keyed the same way. A re-read
    # that overturns "absent" has not un-applied the board's rulings on that
    # clause, and `_write` would otherwise store the empty list it is handed —
    # see the note on `appliedDecisions` in schema.prisma.
    applied_by = {
        (row["clauseId"], str(row.get("documentId") or "")): list(
            row.get("appliedDecisions") or []
        )
        for row in candidates
    }
    if scope.alternatives:
        # Every alternative owns a separate result row. Re-read omissions only
        # against the document that row belongs to; another candidate cannot
        # confirm or overturn it.
        for design in scope.designs:
            outstanding = [
                by_id[row["clauseId"]]
                for row in candidates
                if row.get("documentId") == design.document_id
                and row["clauseId"] in by_id
            ]
            if not outstanding:
                continue
            with db.connection() as conn:
                whole = whole_document.load(conn, design.document_id, design.title)
            if whole is None or whole.tokens > get_config().whole_document_max_tokens:
                continue
            unit_scope = designs.only(scope, design.document_id)
            for start_at in range(0, len(outstanding), CONFIRM_BATCH):
                batch = outstanding[start_at : start_at + CONFIRM_BATCH]
                raw = llm.confirm_absent(
                    document=whole.text,
                    clauses=_render_absent(batch),
                )
                _adopt_confirmations(
                    run,
                    batch,
                    raw,
                    whole,
                    design,
                    unit_scope,
                    carried=carried,
                    applied_by=applied_by,
                    design_id=design.document_id,
                )
        return

    outstanding = [by_id[row["clauseId"]] for row in candidates if row["clauseId"] in by_id]
    absent_count = len(outstanding)
    limit = get_config().whole_document_max_tokens
    changed = 0
    read = 0

    for design in scope.designs:
        if not outstanding:
            break
        with db.connection() as conn:
            whole = whole_document.load(conn, design.document_id, design.title)

        # Both of these leave the search's verdicts exactly as they are, which is
        # the behaviour this stage had before the pass existed. On a project run
        # one unreadable design does not stop the others being read.
        if whole is None:
            logs.info(
                log,
                "no stored pages: absent verdicts stand as the search left them",
                runId=run["id"],
                documentId=design.document_id,
            )
            continue
        if whole.tokens > limit:
            logs.info(
                log,
                "design too large to re-read for absent clauses",
                runId=run["id"],
                documentId=design.document_id,
                tokens=whole.tokens,
                limit=limit,
            )
            continue

        read += 1
        answered: set[str] = set()
        for start_at in range(0, len(outstanding), CONFIRM_BATCH):
            batch = outstanding[start_at : start_at + CONFIRM_BATCH]
            raw = llm.confirm_absent(document=whole.text, clauses=_render_absent(batch))
            answered |= _adopt_confirmations(
                run,
                batch,
                raw,
                whole,
                design,
                scope,
                carried=carried,
                applied_by=applied_by,
                # What `handle` wrote the original finding with, and it has to
                # match or the rewrite does not land on it. `handle` says
                # `scope.designs[0].document_id`; inside this loop that is this
                # iteration's `design`, because the only run that takes the
                # non-project branch has exactly one.
                #
                # Omitted here, this defaulted to None, so `_write` stored
                # `designKey = ""` while a single-document run's finding carries
                # `designKey = <documentId>`. The upsert key is
                # (runId, clauseId, designKey), so the overturned verdict was
                # INSERTed as a second row and the stale "absent" stayed: the
                # clause appeared twice on the report and the verdict tallies
                # came to more than the clause count.
                #
                # The `carried` lookup missed for the same reason — it is keyed
                # on the finding's documentId — so a verdict this pass
                # overturned also lost the obligation it was carrying and its
                # severity collapsed to `unstated`.
                #
                # A project run was unaffected, because there both sides are "".
                # That is why this survived: the runs anyone looked at were
                # project runs.
                design_id=(design.document_id if not run.get("projectId") else None),
            )
        changed += len(answered)
        outstanding = [clause for clause in outstanding if clause["id"] not in answered]

    logs.info(
        log,
        "absent clauses re-read against each design whole",
        runId=run["id"],
        clauses=absent_count,
        designsRead=read,
        of=len(scope.designs),
        changed=changed,
    )


#: The confidence recorded for a "covered" its own evidence unseated. Lower than
#: `CONFIRM_CONFIDENCE`: that pass finds a passage the first reading never saw,
#: while this one re-reads what the first reading already had and disagrees with
#: the conclusion drawn from it. Two readings of one text, and the report should
#: not present the second as the more certain.
COVERED_REVIEW_CONFIDENCE = 0.6

#: How much evidence text one covered-review call carries, in characters.
#:
#: Measured, not guessed. A whole-document run's covered findings average 471
#: characters of evidence each, so this leaves that mode batching at
#: `CONFIRM_BATCH` as it did. A search run's average 1,951 and reach 6,904, so
#: it splits those into calls of six or so — which is the point, because the
#: model has to read each clause against its own passage rather than skim
#: twenty-five of them.
COVERED_REVIEW_BUDGET = 12_000


def _review_covered(run: dict, clauses: list[dict]) -> None:
    """Ask each "covered" whether its own evidence names the exception it ignored.

    The mirror of `_confirm_absents`, and the half the engine was missing. That
    pass doubts a claim of silence, because a search cannot see everywhere it did
    not look. This doubts a claim of compliance, because every code guard in this
    module is demote-only and fires on a verdict with no verified quote — so a
    "covered" that quotes the design accurately and reasons wrongly from it was
    the one shape nothing examined.

    Scoped to the finding's own verified passages, never the whole document. The
    question is narrow enough to answer from them, they are already proven to be
    the design's own words, and sending the document would invite a second full
    judgement of a clause the first reading already made with everything in
    front of it.

    Never raises, for the reason `_confirm_absents` does not: the run's verdicts
    have to reach the report. A pass that cannot run leaves every "covered"
    exactly as it was, which is what the engine did before this existed.
    """
    try:
        _reconsider_covered(run, clauses)
    except Exception as exc:  # noqa: BLE001 — the clause verdicts stand without it
        logs.warn(
            log, "covered clauses could not be reviewed", runId=run["id"], error=str(exc)[:300]
        )


def _reconsider_covered(run: dict, clauses: list[dict]) -> None:
    with db.connection() as conn:
        rows = db.query(
            conn,
            'SELECT "clauseId", "designKey", "evidence", "rationale", '
            '"obligation", "obligationSource", "appliedDecisions" FROM "finding" '
            'WHERE "runId" = %s AND "verdict" = %s',
            (run["id"], "covered"),
        )

    by_id = {clause["id"]: clause for clause in clauses}
    # Evidence is the whole point: a "covered" with nothing verified behind it
    # has already been demoted by `_guard`, and there would be nothing here to
    # read it against.
    pending = [
        (by_id[row["clauseId"]], row)
        for row in rows
        if row["clauseId"] in by_id and _excerpts(row.get("evidence"))
    ]
    if not pending:
        return

    moved = 0
    batches = _covered_batches(pending)
    for batch in batches:
        raw = llm.review_covered(clauses=_render_covered(batch))
        moved += _adopt_covered_review(run, batch, raw)

    logs.info(
        log, "covered findings reviewed against their own evidence",
        runId=run["id"], reviewed=len(pending), batches=len(batches), moved=moved,
    )


def _covered_batches(pending: list[tuple[dict, dict]]) -> list[list[tuple[dict, dict]]]:
    """Split the pending findings into calls, by how much text each carries.

    `CONFIRM_BATCH` alone is the wrong measure here, and it is worth saying why
    rather than leaving the next reader to assume it was copied carelessly. The
    absent re-read it was chosen for sends the document once and then that many
    *short* clause renders; this sends each clause together with all of its own
    evidence, and in search mode that evidence is chunk text rather than a
    verified sentence. Rendering the real pending set of a search run at 25 gave
    one call of 49,338 characters, with a single finding carrying 6,904 of them.

    That fits the context window and costs about a cent, so this is not about
    either. It is about what the pass is for: a question narrow enough that the
    model reads one clause against one short passage and answers it. Twenty-five
    clauses of section text is how that turns back into the skim this exists to
    correct.

    So a batch closes on whichever comes first, the character budget or
    `CONFIRM_BATCH`. A single finding larger than the budget still goes, alone —
    splitting its evidence would ask the model about half the proof.
    """
    batches: list[list[tuple[dict, dict]]] = []
    batch: list[tuple[dict, dict]] = []
    size = 0
    for item in pending:
        cost = sum(len(text) for text in _excerpts(item[1].get("evidence")))
        if batch and (size + cost > COVERED_REVIEW_BUDGET or len(batch) >= CONFIRM_BATCH):
            batches.append(batch)
            batch, size = [], 0
        batch.append(item)
        size += cost
    if batch:
        batches.append(batch)
    return batches


def _excerpts(evidence) -> list[str]:
    """The quoted passages of a finding, as plain strings."""
    items = evidence if isinstance(evidence, list) else []
    return [
        " ".join(str(item.get("excerpt") or "").split())
        for item in items
        if isinstance(item, dict) and str(item.get("excerpt") or "").strip()
    ]


def _render_covered(batch: list[tuple[dict, dict]]) -> str:
    """Each clause and the passages its "covered" verdict rests on, numbered.

    Without the obligation line, like every other string handed to a check
    rather than to the first judge: how strongly the clause binds is not what is
    in question here, and the words would only widen what a quote can match.
    """
    blocks = []
    for index, (clause, row) in enumerate(batch, start=1):
        passages = "\n".join(f"- {text}" for text in _excerpts(row.get("evidence")))
        blocks.append(
            f"[{index}] {_render_clause(clause, with_force=False)}\n\n"
            f"Quoted as proof that the design meets it:\n{passages}"
        )
    return "\n\n".join(blocks)


def _adopt_covered_review(run: dict, batch: list[tuple[dict, dict]], raw: dict) -> int:
    """Demote the findings whose own evidence contradicts them, and only those.

    Three conditions, all required. The verdict has to be one that lowers the
    finding — this pass can never raise one, and "stands" is not written back at
    all, so a clause it agrees with keeps the confidence and wording it had. The
    quote has to be in THAT finding's own passages, which is what stops the
    review inventing an exception the design never stated. And the original
    evidence is carried over unchanged, because a reviewer reading a demotion
    needs the passage it turns on.
    """
    items = raw.get("clauses") if isinstance(raw.get("clauses"), list) else []
    moved = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        number = _page_number(item.get("clause"))
        if number is None or not 1 <= number <= len(batch):
            continue
        verdict = str(item.get("verdict", "")).strip().lower()
        # Demote-only. "stands" is the expected answer and needs no write; any
        # other verdict is one this pass is not allowed to reach.
        if verdict not in ("partial", "contradicts"):
            continue

        clause, row = batch[number - 1]
        quote = " ".join(str(item.get("quote") or "").split())
        passages = " ".join(_excerpts(row.get("evidence")))
        # Checked against this finding's passages alone, not the document. A
        # quote found elsewhere in the design is not what the first reading
        # relied on, and demoting a verdict over it would be answering a
        # question nobody asked.
        if not whole_document.contains(passages, quote):
            logs.warn(
                log,
                "the covered verdict stands: the quoted words are not in its own evidence",
                clauseId=clause["id"],
                quote=quote[:300],
            )
            continue

        reason = " ".join(str(item.get("rationale") or "").split())
        _, rationale = _noted(
            verdict,
            "(Graded 'covered'; its own quoted evidence names an exception.)",
            f"{reason} Excepted: “{_shorten(quote, MAX_BREACH_QUOTE)}”",
        )
        _write(
            run["id"],
            clause,
            verdict=verdict,
            confidence=COVERED_REVIEW_CONFIDENCE,
            rationale=rationale,
            evidence=row.get("evidence") or [],
            retrieval_score=0.0,
            # Carried, for the reason the column's own note in schema.prisma
            # gives: a decision the board applied to this clause is still
            # applied after this pass re-reads the evidence. Only the verdict
            # moved.
            #
            # `raw` and the reading counts are deliberately NOT carried here.
            # Unlike `_demote_unconfirmed`, this pass made a model call, so the
            # answer it writes is a model's answer and belongs in `rawVerdict`
            # — which is what `_write`'s default already does.
            applied=list(row.get("appliedDecisions") or []),
            judged_obligation=_carried_obligation(row),
            design_id=row.get("designKey") or None,
        )
        moved += 1
    return moved


def _render_absent(clauses: list[dict]) -> str:
    """The batch, numbered. The reply answers by number, never in the clause's words.

    The one judge path that is deliberately not given the stack block, and the
    reason is the batch. This renders `CONFIRM_BATCH` clauses into a single
    prompt, so attaching a thousand-token list to each would multiply by the
    batch size on a pass that runs over every absent verdict in the run.

    Safe to withhold because of which way this pass can move a verdict. It only
    takes a clause *off* absent when the reply quotes the design word for word
    — so a clause whose breach turns on the stack stays absent and is reported
    as absent. The block's absence cannot invent a breach here, only miss one,
    and the whole-document reading that already saw the stack is the one that
    was asked first.
    """
    return "\n\n".join(
        f"[{index}] {clause['documentTitle']} — {clause['headingPath']}\n{_render_clause(clause)}"
        for index, clause in enumerate(clauses, start=1)
    )


def _adopt_confirmations(
    run: dict,
    batch: list[dict],
    raw: dict,
    whole: whole_document.WholeDocument,
    design: designs.Design,
    scope: designs.Scope,
    *,
    carried: dict[tuple[str, str], str] | None = None,
    applied_by: dict[tuple[str, str], list] | None = None,
    design_id: str | None = None,
) -> set[str]:
    """Rewrite the findings this design's re-read overturned, and only those.

    Returns the clause ids that moved, so the caller can stop asking the
    remaining designs about them.

    A verdict moves off "absent" on one condition: the reply quotes the design,
    and the quote is in that design word for word. Anything else — a clause
    number that is not in this batch, a verdict that is not one of ours, a quote
    nowhere in the text — leaves the finding as the search left it.
    """
    items = raw.get("clauses") if isinstance(raw.get("clauses"), list) else []
    answered: set[str] = set()
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
                "the first verdict stands: the quoted words are not in the design",
                documentId=design.document_id,
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
                # The opening has to match what was actually re-read. The pass
                # now covers any finding that claimed the design does not say
                # something, not only "absent", and telling a reviewer "a search
                # found nothing" about a clause that had come back partial is a
                # false account of how the verdict was reached.
                (
                    "The first reading reported this as unmet, so each design was read in "
                    f'full — and "{design.title}" does address it. {rationale}'
                )
                if len(scope.designs) > 1
                else (
                    "The first reading reported this as unmet, so the whole document was "
                    f"read again — and it does address it. {rationale}"
                )
            ),
            evidence=[
                {
                    "chunkId": f"confirm-{clause['id']}",
                    "headingPath": "",
                    "page": check.page,
                    "excerpt": quote[:1500],
                    "sourceKind": "quote",
                    "figureId": None,
                    "documentId": design.document_id,
                    "documentTitle": design.title,
                }
            ],
            retrieval_score=0.0,
            applied=list((applied_by or {}).get((clause["id"], design_id or ""), [])),
            judged_obligation=(carried or {}).get((clause["id"], design_id or ""), ""),
            design_id=design_id,
        )
        answered.add(clause["id"])
    return answered


def _carried_obligation(row: dict) -> str:
    """The obligation a rewritten finding has to be handed back, or "".

    `_write` resolves the obligation through `obligations.resolve`, which
    prefers this engine's own reading — the strength the parser recorded, or a
    modal verb in the clause's own words — and falls back to the judge's only
    where the clause establishes nothing. That fallback is the whole problem
    here: every path that rewrites a finding reads the row, builds a new
    verdict and calls `_write` without the judge's answer, so `resolve` finds
    nothing to fall back to and returns "unstated".

    Severity is a function of obligation. So a clause whose force only the
    judge could read came out of a demotion with its `must` replaced by
    "unstated" and its severity collapsed — on the one write where a reviewer
    is being asked to look harder, not less. On a real search run 59 of 170
    findings rested on the judge's reading, and 18 of the 36 "covered" ones
    did, every one of them "must": exactly the rows `_reconsider_covered`
    re-reads.

    Returns "" for any other source, which is correct rather than merely safe:
    where the clause states its own obligation `resolve` ignores this argument
    anyway, so handing back a parsed or read strength would be noise that could
    only mislead the next person to read it.
    """
    if str(row.get("obligationSource") or "") != obligations.JUDGE:
        return ""
    return str(row.get("obligation") or "")


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
    offered: int = 0,
    conflicted: bool = False,
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
        offered=offered,
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
                 "mode","comparedWithId","designRelationship")
            VALUES (%s,%s,%s,%s,'queued',%s,%s,%s,%s)
            """,
            (
                next_id,
                run["organisationId"],
                run["documentId"],
                run["frameworkId"],
                total,
                follow,
                run["id"],
                run.get("designRelationship") or "components",
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
    offered: int = 0,
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
    # citing a passage that is not in the document. A verdict that also cites
    # one is not the same thing, and used to get the same treatment: on one
    # 170-clause run this demoted twenty findings, among them a contradiction
    # carrying three verified quotes and the right answer.
    #
    # What made that unanimous rather than unlucky: the organisation had no
    # standing decisions at all, so the model was handed an empty register and
    # every id it named was "fabricated" by definition. It had named the
    # design's own ADRs. A check that cannot not fire is not a check.
    #
    # So the citation is dropped and the verdict stands on its document
    # evidence, which is what `_applied` already does with the stored ids.
    #
    # The demotion below is narrower than it looks: any citing verdict with no
    # evidence has already returned at the top of this function, so what
    # reaches it is an "absent" or a "needs_review" that cited a decision. For
    # those the citation is the only thing that was ever offered, and there is
    # nothing left to stand on once it goes.
    if fabricated:
        if not evidence:
            return _demoted(
                f"Reported '{verdict}' citing a standing decision that is not on record.",
                rationale,
            )
        # Said out loud only when there was a register to get wrong. With none
        # offered, the model had nothing to cite from and the slip says nothing
        # about the verdict — noting it on every finding would be noise in the
        # report and would read as a fault in the design.
        if offered:
            count = len(fabricated)
            verdict, rationale = _noted(
                verdict,
                f"({count} cited standing decision{'s' if count != 1 else ''} "
                "not on record, set aside.)",
                rationale,
            )

    # Two rulings pulling opposite ways, and deliberately not resolved by taking
    # the newer one — that would hide a contradiction the customer needs to fix.
    if conflicted and verdict in DECISIVE_VERDICTS:
        return _demoted(
            "Two standing decisions on this clause disagree; resolve the register.",
            rationale,
        )

    # ---- Does the conclusion say more than the clause does? ----
    #
    # Three checks, all reading only the clause's own words and the model's own
    # output, all found by reproducing one real run of standard1 against a GCP
    # design. See fidelity.py for what each one is answering.
    evidence_text = " ".join(str(item.get("excerpt") or "") for item in evidence)

    # A confirmed breach that rests on a restriction the clause never stated.
    # Only "contradicts": on every other verdict an "it must use X" sentence is
    # the concrete fix the prompt asks for, not a claim about the rule.
    if verdict == "contradicts":
        overreach = fidelity.overreaches(rationale, clause_text)
        if overreach:
            return _demoted(overreach, rationale)

        # A breach reported over a missing record rather than over anything the
        # design does. Not a demotion to needs_review: the engine knows what
        # this is — the document does not say — and that is not_assessable.
        silence = fidelity.hedged_breach(rationale)
        if silence:
            return _reclassified("not_assessable", silence, rationale)

    if verdict == "covered":
        # A clause about what is "approved" or "certified", answered by a design
        # that names a technology and shows no approval. Not a breach and not a
        # pass: the record is missing, which is exactly not_assessable.
        missing_approval = fidelity.needs_approval_evidence(
            clause_text, evidence_text, rationale
        )
        if missing_approval:
            return _reclassified("not_assessable", missing_approval, rationale)

        # A requirement enumerating several control families, answered on some of
        # them. "Partial" with the unaddressed families named is the honest
        # answer, and naming them is what makes it actionable.
        compound = fidelity.controls(clause_text, evidence_text, rationale)
        if compound.is_compound and compound.missing:
            return _reclassified(
                "partial",
                f"Covers {len(compound.addressed)} of {len(compound.families)} control families "
                f"this clause names; nothing addresses {', '.join(compound.missing)}.",
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


def _noted(verdict: str, note: str, rationale: str) -> tuple[str, str]:
    """Keep the verdict; record the part of the answer that was set aside.

    The counterpart to `_demoted`, and the distinction it draws is the whole
    point: an unsupported *part* of an answer is not an unsupported answer. A
    model that reads a design correctly, quotes it correctly, and then also
    cites a standing decision nobody made has got one thing wrong and the
    finding right. Throwing the finding away loses a real breach and teaches a
    reviewer nothing; stripping the citation loses nothing at all.

    The note trails the model's own reason rather than leading it, matching the
    set-aside-quotes note in `_guard_document`: the verdict did not change, so
    the reason it was reached still comes first.
    """
    note = _shorten(note, MAX_GUARD_REASON)
    room = MAX_RATIONALE - len(note) - 1
    body = _shorten(rationale, room) if room >= 40 else ""
    return verdict, f"{body} {note}".strip()


def _reclassified(verdict: str, reason: str, rationale: str) -> tuple[str, str]:
    """A demotion that knows the right answer, not just that this one is wrong.

    `_demoted` lands on needs_review, which is the honest answer when the engine
    can only tell that a verdict is unsupported. These two cases are different:
    a clause whose approval was never evidenced IS not_assessable, and a
    compound requirement with families nobody addressed IS partial. Saying
    needs_review there would throw away a conclusion the engine can actually
    reach, and bury a real gap in the "a person has to look" pile.

    Bounded like `_demoted`, and for the same reason: the guard's sentence and
    the model's have to stay readable together in one row of the report.
    """
    reason = _shorten(reason, MAX_GUARD_REASON)
    room = MAX_RATIONALE - len(reason) - 1
    tail = _shorten(rationale, room) if room >= 40 else ""
    return verdict, f"{reason} {tail}".strip()


#: A remediation opens with an instruction. Checked on the rationale's last
#: sentence, which the prompts reserve for the fix.
# A closed list, and the cost of a gap in it falls the wrong way. A verb that
# is missing turns a real fix into a "the two do not agree" demotion, and four
# of five ordinary remediation sentences were failing it:
#
#     "Ensure the legacy console conforms to the MFA baseline."
#     "Adopt MuleSoft so the design conforms to the integration standard."
#     "Use KMS so the staging file meets the encryption requirement."
#     "Update the ADR so it adheres to the exception process."
#
# Each pairs an imperative the list did not know with a phrase `_COMPLIANT_PROSE`
# does. So err generous: a verb wrongly admitted only lets a finding keep the
# wording the model gave it, which is where the engine started; a verb wrongly
# missing rewrites a correct finding into a review item.
_IMPERATIVE = re.compile(
    r"^\s*(?:Add|Replace|Remove|Define|Document|Specify|Route|Decouple|Split|Move|Set|"
    r"Enforce|Introduce|Restrict|Encrypt|Bound|Configure|Record|Obtain|Migrate|Separate|"
    r"Apply|Limit|Rename|Publish|Retire|Isolate|Pin|Scope|Require|Capture|Store|Rotate|"
    r"Terminate|Upgrade|Patch|Index|Partition|Cache|Throttle|Version|Validate|Review|"
    r"Confirm|Raise|Agree|Ask|"
    r"Ensure|Adopt|Use|Update|Create|Establish|Extend|Enable|Disable|Assign|Nominate|"
    r"Align|Consolidate|Centralise|Centralize|Standardise|Standardize|Provision|Deploy|"
    r"Automate|Harden|Monitor|Instrument|Track|Schedule|Complete|Close|Plan|Fund|Grant|"
    r"Revoke|Tighten|Reduce|Increase|Test|Verify|Reconcile|Formalise|Formalize)\b",
    re.IGNORECASE,
)

#: The shape of a sentence that says the design is fine. On a verdict that is
#: not "covered" this is the contradiction worth catching: the model has graded
#: the clause as unmet and then written that it is met.
_COMPLIANT_PROSE = re.compile(
    r"\b(?:aligning with|aligns with|in alignment with|complies with|is compliant|"
    r"are compliant|satisfies the|meets the|is appropriate for|are appropriate for|"
    r"is consistent with|adheres to|conforms to|fulfils the|fulfills the)\b",
    re.IGNORECASE,
)

#: A clause asking for an architectural property rather than a record. Used to
#: refuse a governance-shaped answer to a technical question.
_ARCHITECTURAL_CLAUSE = re.compile(
    r"\b(?:pattern|reuse|encrypt|layer|interface|coupling|cohesion|redundan|failover|"
    r"replicat|segment|least privilege|authenticat|authoris|authoriz|timeout|retry|"
    r"idempoten|scalab|latency|throughput|backup|restore|retention|logging|monitor|"
    r"index|partition|cache|queue|broker|gateway|protocol|tls|ssl|api|schema|"
    r"transaction|session|secret|key management)\b",
    re.IGNORECASE,
)

#: The paperwork words a false `not_assessable` leans on.
_PAPERWORK = re.compile(
    r"\b(?:approval|approved|certification|certified|waiver|sign-?off|authoris\w+|"
    r"authoriz\w+|exception record|governance record)\b",
    re.IGNORECASE,
)

#: Verdicts whose rationale must end in an instruction, not a compliance claim.
_NEEDS_REMEDIATION = ("contradicts", "partial", "absent", "not_assessable", "needs_review")


def _last_sentence(rationale: str) -> str:
    """The fix, which the prompts put last. Falls back to the whole string."""
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", rationale.strip()) if p.strip()]
    return parts[-1] if parts else rationale.strip()


def _fix_is_a_compliance_claim(verdict: str, rationale: str) -> bool:
    """Whether the remediation sentence says the design already complies.

    The failure this catches, from a live run on gpt-4.1-mini:

        verdict: not_assessable
        gap:     "The clause governs what is 'approved', and nothing quoted
                  records an approval, certification or waiver."
        fix:     "The design uses service-oriented, client-server, MVC, and
                  layered patterns appropriate for the system's business and
                  operational needs, aligning with the clause's fit-for-purpose
                  integration principle."

    The fix states compliance with the clause the verdict says was not met.
    Nothing in that finding is actionable and a reviewer reading it loses
    confidence in every other finding on the page.

    A cheap model will do this whatever the prompt says, so it is checked in
    code: the last sentence of a non-covered rationale has to read as an
    instruction. Compliance prose with no imperative verb is the signal.
    """
    if verdict not in _NEEDS_REMEDIATION:
        return False
    fix = _last_sentence(rationale)
    if not fix:
        return False
    return bool(_COMPLIANT_PROSE.search(fix)) and not _IMPERATIVE.match(fix)


#: Control families a security clause might name. Checked against the clause's
#: own words before a rationale is allowed to say one is unmet.
#
# Broader than `fidelity._FAMILIES` on purpose, and kept separate from it. This
# list only has to recognise a family word a rationale used; being wrong adds a
# note. `fidelity._FAMILIES` decides whether a clause is enumerating several
# families at all, and being wrong there rewrites a verdict — so it stays
# conservative and holds none of the CIA-triad words below.
#
# What the two must agree on is synonymy, and they now do: whether a word names
# a family the clause already covers is asked of `fidelity.synonyms_of`, which
# is the same grouping `fidelity.controls` reads. Before that, a clause saying
# "resiliency" answered by a rationale blaming "availability" was addressed by
# one guard and invented by the other, on the same finding.
_CONTROL_FAMILIES = (
    "governance",
    "cybersecurity",
    "identity",
    "data protection",
    "privacy",
    "connectivity",
    "resiliency",
    "resilience",
    "regulatory",
    "compliance",
    "authentication",
    "authorization",
    "authorisation",
    "encryption",
    "auditability",
    "monitoring",
    "availability",
    "integrity",
    "confidentiality",
)


def invented_families(rationale: str, clause: dict | None) -> list[str]:
    """Control families a rationale blames the design for, that the clause never asked for.

    The failure this exists for: a clause requiring "authentication,
    authorization, encryption and appropriate security controls" produced a
    finding reading "three of the four control families are covered; regulatory
    requirements are not addressed". The clause says nothing about regulatory
    requirements. The engine had invented a fourth obligation and then marked the
    design short of it, which is the most damaging kind of false positive — it
    looks precise, it counts, and it cannot be traced to anything.

    Both judge prompts already tell the model to answer each family the clause
    names and no others (rules 3h and 5e). A cheap model counts anyway, so the
    claim is checked here: a family named as unmet has to appear in the clause.

    Returns the families that do not, so the caller can say so rather than
    silently rewriting the verdict — the rest of the finding may be sound.

    A clause names a family if it uses any of that family's words, which is why
    the lookup goes through `fidelity.synonyms_of`: "the design does not address
    availability" is not an invented requirement against a clause that asked for
    resiliency, and reading the word literally said it was.
    """
    text = _clause_text(clause).lower()
    if not text:
        return []
    low = (rationale or "").lower()
    # Only when the rationale is actually making a family claim. Mentioning
    # encryption in passing is not the same as counting it as a failed family.
    if not re.search(r"\b(?:famil|requirements? (?:are|is) not|not addressed|unaddressed)\b", low):
        return []
    return [
        family
        for family in _CONTROL_FAMILIES
        if _names(low, family) and not any(_names(text, w) for w in fidelity.synonyms_of(family))
    ]


def _names(text: str, word: str) -> bool:
    """Whether `text` uses `word` as a word, not inside a longer one.

    Substring matching counted "authorisation" as present in "authorisations"
    and, less harmlessly, read a family out of any word that happened to
    contain one.
    """
    return bool(re.search(rf"\b{re.escape(word)}\b", text))


def _clause_text(clause: dict | None) -> str:
    """A clause's own words, for deciding what it is asking for."""
    if not clause:
        return ""
    parts = [
        str(clause.get("title") or ""),
        str(clause.get("statement") or ""),
        " ".join(str(r) for r in (clause.get("requirements") or [])),
    ]
    return " ".join(" ".join(parts).split())


def _paperwork_answer_to_a_technical_clause(verdict: str, rationale: str, clause: dict | None) -> bool:
    """Whether a technical clause was answered as a governance question.

    The live failure: a clause on fit-for-purpose pattern selection came back
    `not_assessable` because "nothing quoted records an approval, certification
    or waiver". The clause had not asked for one. The design's patterns were
    right there in the document, and the reviewer was handed a paperwork
    complaint instead of a verdict on their architecture.

    Both judge prompts now forbid this, and a cheap model will still do it, so
    it is checked here as well: `not_assessable` whose reason leans on approval
    language, against a clause whose own words are about an architectural
    property. The verdict is sent to `needs_review` rather than guessed at —
    the engine knows the answer is wrong but not what the right one is, and a
    person reading the clause will settle it in seconds.
    """
    if verdict != "not_assessable":
        return False
    if not _PAPERWORK.search(rationale):
        return False
    text = _clause_text(clause)
    if not text:
        return False
    # Asking for a record is legitimate grounds; asking for a property is not.
    # Both can appear, so the architectural signal has to be the stronger one.
    return bool(_ARCHITECTURAL_CLAUSE.search(text)) and not _PAPERWORK.search(text)


def _raw_answer(raw: dict) -> tuple[str, float, str]:
    """The model's answer as it arrived, for the replay columns on `finding`.

    Deliberately taken before `_normalise`, not after. `_normalise` is itself
    one of the things a replay needs to be able to re-run — it promotes a
    described breach out of "partial" and demotes a rationale that argues
    against its own verdict — so its output is no more the model's answer than
    `_guard`'s is.

    Not validated here beyond its types. A verdict this function does not
    recognise is exactly what someone replaying a prompt change needs to see.
    """
    try:
        confidence = float(raw.get("confidence", 0) or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    return (
        str(raw.get("verdict", "") or "")[:40],
        confidence,
        str(raw.get("rationale", "") or "")[:4000],
    )


def _normalise(
    raw: dict, clause: dict | None = None
) -> tuple[str, float, str, list[str], list[str]]:
    verdict = str(raw.get("verdict", "")).strip().lower()
    if verdict not in VERDICTS:
        verdict = "needs_review"

    try:
        confidence = max(0.0, min(1.0, float(raw.get("confidence", 0))))
    except (TypeError, ValueError):
        confidence = 0.0

    rationale = _shorten(str(raw.get("rationale", "")), MAX_RATIONALE)

    # A model that describes a breach and then grades it "partial" has answered
    # its own question. Both judge prompts say a breach is never partial, and
    # both are ignored often enough to matter: on the sample corpus one clause
    # came back "partial" with "failed messages are dropped after retries
    # without dead-letter queue" as its reason. Prose is the model's real
    # answer; the verdict field is a label it picked afterwards, so where the
    # two disagree this trusts the prose.
    #
    # Only ever "partial" to "contradicts" — the direction the evidence already
    # supports. And `_guard` still runs after this, so a promoted verdict with
    # no verified quote behind it is demoted to needs_review exactly as a
    # model-authored one would be. This can make a verdict stricter; it cannot
    # make one unfounded.
    #
    # Read on the gap sentence alone, for the reason `hedged_breach` reads the
    # same one: the prompts reserve the last sentence for the fix, and a fix
    # names the thing to be fixed. "Add a dead-letter queue so failed messages
    # are not dropped" is a correct remediation on a correct "partial", and
    # testing the whole rationale let it promote itself to a contradiction.
    #
    # The note is not decoration. This is the engine's only rule that makes a
    # verdict *stricter*, and it used to rewrite the field and say nothing — so
    # it was the one guard whose firing rate could not be counted after a run,
    # and a reviewer saw a contradiction the model had never written.
    if verdict == "partial" and _BREACH.search(fidelity.first_sentence(rationale)):
        verdict, rationale = _noted(
            "contradicts",
            "(Graded 'partial', but the gap describes a breach; recorded as one.)",
            rationale,
        )

    # The model graded the clause as unmet and then wrote that the design meets
    # it. A finding whose fix says there is nothing to fix is unusable and the
    # contradiction is worth catching — but it used to be caught by trusting
    # the prose and promoting the verdict to "covered".
    #
    # That was the wrong half to trust. The argument for it was that `_guard`
    # runs afterwards and "demotes any promoted verdict with no verified quote
    # behind it, so this cannot invent a pass". The gap in that reasoning is
    # that the guard only catches an *unevidenced* promotion. A clause whose
    # evidence quotes the design accurately and whose last sentence argues
    # compliance sails through it.
    #
    # SEC-006 on a real run is what that looks like. The clause requires MFA
    # for privileged access. The design says MFA is enforced for SSO, console
    # and VPN, "Legacy operations console has username/password
    # authentication" — quoted, verified, in the finding's own evidence. The
    # rationale ended "This satisfies the clause's requirement", the verdict
    # was promoted to covered, and a reviewer reading the report learned that
    # an unprotected privileged console was compliant.
    #
    # The engine can tell the answer contradicts itself without knowing which
    # half is right, so it says that and stops — the same reasoning, and the
    # same landing place, as the paperwork check below.
    # Not when the engine is the one that said "needs_review". `_NEEDS_REMEDIATION`
    # includes it, and any unrecognised verdict field is mapped to it above — so
    # without this the engine writes "Graded 'needs_review', then gave a reason
    # arguing the design already complies" about a label it assigned itself, and
    # changes no verdict in the process.
    if verdict != "needs_review" and _fix_is_a_compliance_claim(verdict, rationale):
        logs.info(
            log,
            "remediation sentence argued compliance with the verdict it contradicts",
            was=verdict,
        )
        verdict, rationale = _demoted(
            f"Graded '{verdict}', then gave a reason arguing the design already complies; "
            "the two do not agree.",
            rationale,
        )

    # A technical clause answered with a complaint about paperwork. Sent to
    # needs_review rather than guessed: the engine can tell the answer is wrong
    # without knowing the right one, and a person reading the clause settles it.
    # A family blamed on the design that the clause never named. Said in the
    # rationale rather than used to flip the verdict: the finding may be right
    # about the families the clause does name, and the reviewer is the one who
    # should see which part was invented.
    stray = invented_families(rationale, clause)
    if stray:
        logs.info(log, "rationale named a requirement the clause does not", families=stray)
        named = ", ".join(stray)
        rationale = (
            f"{rationale} (This clause does not state a requirement for {named}; "
            "that part of the assessment is not traceable to it.)"
        )[:MAX_RATIONALE]

    if _paperwork_answer_to_a_technical_clause(verdict, rationale, clause):
        logs.info(log, "governance answer to a technical clause; sending for review")
        verdict = "needs_review"
        rationale = (
            "This clause asks for an architectural property, and the assessment answered it "
            "with a missing approval record instead. A reviewer should read the clause against "
            "the design. " + rationale
        )[:MAX_RATIONALE]

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
        # Deduplicated, order kept. A model that cites the same extract twice is
        # making one claim, not two, and two places downstream counted it as
        # two: the evidence array stored the chunk twice, and `_guard`'s
        # diagram-only check compares `len(cited_generated)` — a set — against
        # `cited_total`, a count. One repeated figure id made those two numbers
        # differ, the condition read as "not every citation is a figure", and a
        # verdict resting on nothing but a diagram description walked past the
        # one guard that exists to stop it.
        list(dict.fromkeys(str(c) for c in cited if c)),
        [str(a) for a in applied if a],
    )


def _reference(clause: dict) -> str:
    """What a reviewer is shown to identify the clause, and can cite back.

    The reference comes from the section, deliberately: a decision anchored to
    §9.3 has to keep finding the clause after it has been sharpened, and a
    clause carries no number of its own. That is right for anchoring and was
    wrong on screen as soon as a section held more than one clause.

    "Core Integration Principles" is a table of ten integration principles, and
    all ten findings showed the same line — the title underneath was the only
    thing that differed, and the report read as one clause repeated ten times.
    A section numbered "9" with several clauses gave a reference of "9", which
    is not something a person can quote at anybody.

    So where a section holds one clause the reference is the section's, exactly
    as before; where it holds several, the clause's own position and name are
    appended. Nothing that anchors a decision changes, because that still reads
    the section.
    """
    base = clause["numberText"] or clause["headingPath"]
    if (clause.get("siblings") or 1) <= 1:
        return base
    title = " ".join(str(clause.get("title") or "").split())
    position = clause.get("ordinal")
    tail = f"{position}. {title}" if position and title else (title or str(position or ""))
    return f"{base} › {tail}" if tail else base


def _refuse_without_credit(pending: int) -> None:
    """Stop before the first clause when the key is already empty.

    Dying halfway is the worst outcome this stage has. The credits are spent
    either way, and what they bought is a third of a report — on one real run,
    the third that happened to hold DAT and EA, while every clause that would
    have decided the review sat in the two-thirds that never ran. Nobody can
    act on that, and re-running pays for the first third again.

    Unknown is not empty. Any provider that does not report a balance, and any
    check that fails for its own reasons, returns None and the run proceeds —
    refusing to start on a number nobody could read would be a worse failure
    than the one this prevents.
    """
    # A resume with every clause already judged needs no model calls at all —
    # only the finishing passes. Refusing it on an empty key would fail a run
    # that was about to succeed for free, and take its coverage, advice and
    # root-cause passes with it. That is the resume this check exists to
    # protect, so it is the one case it must not touch.
    if pending <= 0:
        return
    # The promise in the docstring, kept. `credit_remaining` guards its own
    # HTTP call, but reaching it goes through `client()` and the bound
    # credential, and anything raised there would fail the job before the run
    # has even started.
    try:
        left = llm.credit_remaining()
        if left is not None:
            # Inside the try, deliberately. Only the OpenRouter implementation
            # coerces its own figures; another provider could hand back a string
            # or a Decimal, and the comparison below would raise outside this
            # block and fail the job before the run had started — which is the
            # one thing the docstring promises cannot happen.
            left = float(left)
    except Exception:  # noqa: BLE001 — a failed check must never fail a run
        return
    if left is None:
        return
    needed = pending * MIN_CREDIT_PER_CLAUSE
    logs.info(
        log,
        "credit before the run",
        remaining=round(left, 4),
        clauses=pending,
        leastNeeded=round(needed, 4),
    )
    # Not `left <= 0`. A balance can be positive and still nowhere near enough,
    # which is the failure that keeps happening: the run starts, bills for a
    # fraction of the framework, and stops somewhere arbitrary. The findings it
    # did reach are the ones that happened to be judged first, not the ones
    # worth having, and re-running pays for them again.
    if left < needed:
        raise llm.QuotaExhausted(
            f"{credentials.whose()} has {round(left, 4)} left and this run needs at "
            f"least {round(needed, 4)} for {pending} clauses; add credits and re-run"
        )


def _overrides_absent(verdict: str, evidence: list[dict]) -> bool:
    """Whether a search second opinion is strong enough to unseat an "absent".

    Decisive and cited, or it does not count. A whole-document read has seen
    everything the search has and more, so the search earns its say only by
    finding a passage that settles the clause — "covered", "contradicts", or
    "not_applicable", which settles it just as firmly by showing the clause
    does not govern this design. Not by hedging "partial" over eight chunks it
    has no surrounding document for.
    """
    return verdict in DECISIVE_VERDICTS and bool(evidence)


def _render_clause(clause: dict, *, with_force: bool = True, stack_block: str = "") -> str:
    """The clause as the judge reads it.

    `with_force=False` for the copy handed to the guards. They are given this
    same string as `clause_text`, and `_figure_corroborates` tokenises it to
    decide whether a diagram is even on the clause's subject — so every word in
    here becomes a word a figure description may match against.

    The obligation line costs seven of them: how, strongly, clause, binds,
    read, own, wording, none of which are in `_STOPWORDS`. With it
    included, a figure description reading "Diagram read by the team showing
    how each service binds to its own queue" corroborated a cryptography
    clause, because `_figure_corroborates` needs two shared keywords and
    "read" and "binds" are two. A verdict resting on nothing but a diagram
    stopped being demoted, which is the one thing that guard exists to do.

    So the prompt gets the sentence and the guards get the clause.

    `stack_block` rides on the same split, and for the same reason. It is the
    organisation's technology stack, a thousand tokens of product names, and it
    is attached only to clauses that are about what the stack approves — see
    `stack.concerns_technology`. Handed to the guards it would be catastrophic:
    `fidelity` tokenises this string to decide whether cited evidence is even on
    the clause's subject, and two hundred technology names would corroborate
    almost any extract from almost any design.
    """
    parts = []
    if clause["title"]:
        parts.append(f"Title: {clause['title']}")
    if clause["statement"]:
        parts.append(f"Statement: {clause['statement']}")
    # The clause's own force, stated once and stated always — not only where the
    # parser recorded a strength per requirement.
    #
    # The block below prints those strengths, and prints nothing at all when the
    # clause has no requirement rows. A clause read from a register workbook has
    # none: its obligation lives in its statement. So on a run over six client
    # registers this function never once told the judge which clauses were
    # mandatory, across all 170 of them, while the prompt went on asking it to
    # weigh exactly that.
    #
    # `obligations.of` is the same deterministic reading the finding is stored
    # with, so the judge is told what the report will say rather than forming a
    # second opinion. Printed only when it is known: an invented "must" is the
    # one thing the brief forbids outright.
    force = obligations.of(clause)
    if with_force and force.is_known:
        parts.append(f"How strongly this clause binds: {force.describe()}")
    if clause["requirements"]:
        # Each requirement with how strongly it binds. The parser has always
        # recorded this and nothing ever read it, so the judge could not tell a
        # "shall" from a "may" and graded both the same — see obligations.py.
        # Unstated is printed as unstated rather than omitted: the judge has to
        # know the standard did not say, so that it does not supply a "must" of
        # its own.
        rows = obligations.per_requirement(clause)
        parts.append(
            "Requirements, with how strongly the standard binds each:\n"
            + "\n".join(
                f"- [{strength}] {text}" for text, strength in rows
            )
        )
    # Rationale and guidance are deliberately withheld: they explain why the
    # rule exists and how to implement it, and including them tempts the model
    # to mark a design down for not following advice the clause never required.
    #
    # The stack goes last, after the clause and its requirements, and is
    # labelled as the organisation's record rather than as part of the standard.
    # A clause says what must be true; this says what the organisation has
    # approved. Printed above the clause they would read as one thing, and a
    # judge would start quoting the stack as though the standard had said it.
    if stack_block and stack.concerns_technology(clause):
        parts.append(
            "The organisation's own technology record, for this clause. These are "
            "facts about what has been approved, not part of the standard above:\n"
            + stack_block
        )
    return "\n".join(parts)


# The design's own words, as the comparison beside the clause prints them.
MAX_BREACH_QUOTE = 240


def _mark_breach(
    evidence: list[dict],
    raw_breach: object,
    by_id: dict[str, retrieval.Candidate],
) -> None:
    """Mark the one passage a contradiction rests on, if the judge named it.

    A finding cites several passages and says nothing about what each is for,
    so a report showing "what the design says" beside the clause had to pick
    one — and picking meant guessing. Measured over a project's fifteen
    contradictions, the guess quoted a design the finding never mentions in
    twenty of forty cases, and quoted a design's own remediation plan, or a row
    reading "Aligned", as the breach.

    So the judge names it instead, and this verifies the naming rather than
    trusting it: the extract has to be one the finding actually cites, and the
    quote has to appear inside the text the model was shown, word for word on
    whitespace and case. Anything else is dropped and the report falls back to
    its paragraph. A quote that is nearly right is the failure this guards
    against — it would be put in the design's mouth, in quotation marks, in a
    compliance record.
    """
    if not isinstance(raw_breach, dict):
        return
    extract = str(raw_breach.get("extract") or "").strip()
    quote = " ".join(str(raw_breach.get("quote") or "").split())
    if not extract or not quote:
        return

    candidate = by_id.get(extract)
    if candidate is None:
        logs.info(
            log,
            "breaching quote names an extract this finding does not cite",
            extract=extract,
        )
        return

    # Compared against `excerpt`, which is the text `_render_extracts` put in
    # front of the model — not the stored chunk, which may differ from it.
    haystack = " ".join(candidate.excerpt.split()).casefold()
    marked = quote
    if quote.casefold() not in haystack:
        # Character-for-character was the whole test, and it was costing a third
        # of the quotes it was given: 11 of 37 contradictions on one real run,
        # 9 of 9 on another. The words were the design's every time; what
        # differed was punctuation, and most often a table row the model had
        # re-rendered — an em dash where the extract has a pipe, the heading
        # prefix dropped.
        #
        # A dropped quote costs more than the side-by-side it was written for.
        # `designVoices` in FindingModal.tsx skips any passage without one, so
        # the cited table row never reaches `rowCells` and the reviewer is shown
        # the parser's run-on line instead of the drawn row.
        #
        # So fall back to the comparison every other quote check in the engine
        # already uses. It is not a weaker guarantee: `contains` requires the
        # words in order inside this extract, which a paraphrase cannot satisfy
        # — only the characters between them are forgiven.
        if not whole_document.contains(candidate.excerpt, quote):
            logs.info(log, "breaching quote is not inside its extract", extract=extract)
            return
        # Shown to a person, so the control characters go; see `readable`. The
        # stored quote is then the model's rendering of the passage rather than
        # the document's own punctuation, which is the trade this fallback makes.
        marked = whole_document.readable(quote)
        logs.info(
            log, "breaching quote matched on words, not characters", extract=extract
        )

    for item in evidence:
        if item.get("chunkId") == extract:
            item["breachQuote"] = marked[:MAX_BREACH_QUOTE]
            return


def _render_extracts(candidates: list[retrieval.Candidate], *, named: bool = False) -> str:
    """Extracts, with generated ones labelled as such.

    A figure extract is a vision model's reading of a diagram, not a quotation
    from the document. Unlabelled it is indistinguishable from one — which is
    precisely how a hallucinated system name becomes cited evidence in a
    compliance finding.

    `named` adds the design each extract is from, for a project run. Without it
    two designs' page 4 are the same location to the reader of this block, and
    the judge's rationale cannot say which design answers the clause.
    """
    out = []
    for c in candidates:
        page = f" page={c.page_start}" if c.page_start else ""
        origin = ' origin="model-description-of-a-diagram"' if c.is_generated else ""
        design = f' design="{c.document_title}"' if named and c.document_title else ""
        out.append(
            f'<extract id="{c.chunk_id}"{design} location="{c.heading_path}"{page}{origin}>\n'
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
    judged_obligation: str = "",
    design_id: str | None = None,
    readings: int = 1,
    agreed: int = 1,
    dissent: list[dict] | None = None,
    raw: tuple[str, float, str] | None = None,
) -> None:
    """One finding, committed on its own so a crash costs at most one clause.

    `raw` is what the model answered before `_normalise` and the guards touched
    it. Stored beside the finding rather than instead of it: the columns above
    are what a reviewer reads and must stay post-guard, while these are what a
    replay needs. Without them a guard or prompt change could only be measured
    by paying for the whole framework again, because the inputs those functions
    read had not been kept. Defaults to the final answer, so a path that writes
    a finding without going through the judge — the absent re-read, the covered
    review — records the verdict it actually produced rather than an empty one.
    """
    reference = _reference(clause)
    # Severity is a function of this, so it is recorded with the finding rather
    # than looked up later: the clause behind a report can be sharpened or
    # retired, and a report has to keep explaining its own severities.
    obligation = obligations.resolve(clause, judged_obligation)
    raw_verdict, raw_confidence, raw_rationale = raw or (verdict, confidence, rationale)
    with db.transaction() as conn:
        db.execute(
            conn,
            """
            INSERT INTO "finding"
                ("id","runId","clauseId","documentId","designKey",
                 "clauseRef","clauseTitle","clauseStatement",
                 "verdict","confidence","rationale","evidence","retrievalScore",
                 "appliedDecisions","obligation","obligationSource",
                 "readings","agreed","dissent",
                 "rawVerdict","rawConfidence","rawRationale")
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT ("runId","clauseId","designKey") DO UPDATE SET
                "documentId" = EXCLUDED."documentId",
                "verdict"    = EXCLUDED."verdict",
                "confidence" = EXCLUDED."confidence",
                "rationale"  = EXCLUDED."rationale",
                "evidence"   = EXCLUDED."evidence",
                "retrievalScore" = EXCLUDED."retrievalScore",
                "appliedDecisions" = EXCLUDED."appliedDecisions",
                "obligation" = EXCLUDED."obligation",
                "obligationSource" = EXCLUDED."obligationSource",
                "readings" = EXCLUDED."readings",
                "agreed" = EXCLUDED."agreed",
                "dissent" = EXCLUDED."dissent",
                "rawVerdict" = EXCLUDED."rawVerdict",
                "rawConfidence" = EXCLUDED."rawConfidence",
                "rawRationale" = EXCLUDED."rawRationale"
            """,
            (
                db.new_id(),
                run_id,
                clause["id"],
                design_id,
                design_id or "",
                str(reference)[:300],
                (clause["title"] or "")[:500],
                (clause["statement"] or "")[:2000],
                verdict,
                confidence,
                rationale,
                Jsonb(evidence),
                retrieval_score,
                Jsonb(applied),
                obligation.strength,
                obligation.source,
                readings,
                agreed,
                Jsonb(dissent or []),
                raw_verdict,
                raw_confidence,
                raw_rationale,
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

    # A failed run ends a request as surely as a complete one does, and the
    # requestor is owed the news either way. The app reads the run's own state
    # to decide which ending it was.
    notify.run_complete(run_id)


def _complete(job: Job, run_id: str, refused: int = 0) -> None:
    """Close the run, and say so honestly when part of it could not be judged.

    `refused` is the number of clauses the model could not answer usably. Each
    one is on the report as `needs_review` with its own reason, but the run
    itself used to say nothing: state "complete", completedClauses equal to
    totalClauses, and a reader with no way to tell a run where every clause was
    judged from one where a third of them failed and were recorded as questions.

    A run that assessed 60 of 94 clauses is not a complete assessment of 94
    clauses, and presenting it as one is the single most misleading thing this
    stage can do — a governance reviewer signing off on that has been told the
    coverage was total. So the count goes in the run's note, which the report
    already shows above the findings.

    The state stays "complete", because the run did finish and its findings
    stand; what changes is that the report no longer implies the coverage was
    total. Appended to whatever the note already said rather than replacing it:
    the fallback-to-search reason and the designs left out are both in there.
    """
    said = (
        f"{refused} of {{total}} clauses could not be assessed — the model did not return a "
        "usable answer for them, and each is on the report as needing review. This is not a "
        "complete assessment of every clause; run it again to retry them."
        if refused
        else None
    )

    with db.transaction() as conn:
        counts = db.query(
            conn,
            'SELECT "verdict", count(*)::int AS n FROM "finding" WHERE "runId" = %s GROUP BY 1',
            (run_id,),
        )
        if said is not None:
            row = db.one(
                conn, 'SELECT "totalClauses", "note" FROM "assessment_run" WHERE "id" = %s', (run_id,)
            )
            total = (row or {}).get("totalClauses") or 0
            previous = ((row or {}).get("note") or "").strip()
            note = said.format(total=total)
            db.execute(
                conn,
                'UPDATE "assessment_run" SET "note" = %s WHERE "id" = %s',
                (f"{previous} {note}".strip(), run_id),
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
        refused=refused,
        **{c["verdict"]: c["n"] for c in counts},
    )

    # Outside the transaction and after it has committed, the same ordering
    # embed.py uses for document_ready: the run is complete whether or not
    # anyone is told, and a call made inside would hold the transaction open
    # for the length of an HTTP round trip.
    #
    # This is what lets "your report is ready" be sent at the moment it becomes
    # true, instead of whenever somebody next opens a page. It never raises —
    # see notify.py.
    notify.run_complete(run_id)


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

