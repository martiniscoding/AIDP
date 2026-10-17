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
    designs,
    fidelity,
    lifecycle,
    logs,
    obligations,
    progress,
    queue,
    retrieval,
    rootcause,
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
    r"violat(?:es|ing|ed)"
    r"|breach(?:es|ing|ed)"
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
        # One design, or every finished design in a project. Everything below
        # reads this rather than run["documentId"], which is null on a project
        # run. See designs.py.
        scope = designs.for_run(conn, run)
        # What the submitted work is, read once per run. The same string for
        # every clause, so fetching it inside the loop would be a hundred round
        # trips for one column.
        document_context = _context(conn, scope)
        per_design = bool(run.get("projectId") and scope.alternatives)
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

    pending = [
        (clause, design_id)
        for clause, design_id in tasks
        if (clause["id"], design_id or "") not in done
    ]
    completed = len(tasks) - len(pending)
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
    for index, (clause, design_id) in enumerate(pending, start=1):
        progress.step(step_label, done=completed + index - 1, total=len(tasks))
        unit_scope = designs.only(scope, design_id) if design_id else scope
        unit_context = task_contexts.get(design_id, document_context)
        try:
            if whole is not None:
                _assess_document_one(run, clause, whole, unit_scope, unit_context)
            else:
                _assess_one(run, clause, unit_scope, unit_context, design_id=design_id)
        except llm.QuotaExhausted:
            # Not this clause's problem and not survivable: every clause after
            # it would fail the same way, and the run is worth retrying once
            # the customer's credit is back. Let the job layer back off.
            raise
        except Exception as exc:  # noqa: BLE001 — one clause must not cost the other ninety-nine
            # A clause that cannot be judged is recorded as needing a person,
            # and the run goes on.
            #
            # Before this, anything raised here — a model returning JSON that
            # does not parse, a provider 500, one unreadable figure — aborted
            # the whole run. The clauses already committed stayed (each is its
            # own transaction), the rest were never attempted, and the report
            # opened showing however few had landed before the failure, with a
            # dead-lettered job as the only trace. A hundred-clause framework
            # reporting one clause is that bug, and it looks like a limit
            # somebody left in rather than the single failure it is.
            #
            # `needs_review` rather than a silent skip: the clause was in scope
            # and was not judged, and the one thing the report must not do is
            # imply it passed. The rationale says what happened so a reviewer
            # knows this is a system failure and not a reading of their design.
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
                        "This clause could not be assessed: the model did not return a usable "
                        "answer for it. Nothing is implied about the design. Run the assessment "
                        "again to retry this clause."
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
        heartbeat()
        # Every clause, not every fifth. A clause takes around fifteen seconds,
        # so batching the write held the progress bar still for over a minute at
        # a time — long enough that a run in perfect health reads as a hung one,
        # which is what a progress bar exists to rule out. The cost is one small
        # UPDATE per clause against a row already in cache, spaced fifteen
        # seconds apart; the model call beside it dwarfs it.
        if _progress(run_id, completed + index) == 0:
            logs.info(
                log,
                "run is no longer running, abandoning it",
                runId=run_id,
                clausesDone=completed + index,
            )
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


def _assess_one(
    run: dict,
    clause: dict,
    scope: designs.Scope,
    document: str = "",
    *,
    design_id: str | None = None,
) -> None:
    """Retrieve, judge, guard, commit — one clause, one transaction."""
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
    )


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
) -> _Judged:
    """The passages a search finds for the clause, judged and guarded.

    The whole of a retrieval-mode assessment, and the second opinion a
    whole-document assessment asks for before it will call anything absent.
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

    try:
        raw = llm.judge(
            reference=reference,
            clause=_render_clause(clause),
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
        )
    except Exception as exc:  # noqa: BLE001 — one clause must not sink the run
        logs.warn(log, "judge failed for clause", clauseId=clause["id"], error=str(exc)[:200])
        return _Judged(
            "needs_review",
            0.0,
            "This clause was not judged: the model's answer could not be read. Run the "
            f"assessment again. ({str(exc)[:120]})",
            [],
            [],
            best,
        )

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
        conflicted=decisions.conflicting(precedents),
        clause_text=_render_clause(clause),
        figure_text=" ".join(
            c.excerpt for cid in cited_figures if (c := by_id.get(cid)) is not None
        ),
    )
    # After the guard, not before: the guard can demote a contradiction to
    # needs_review, and a quote presented as the conflict on a verdict that is
    # no longer a conflict would be the UI asserting something nothing stands
    # behind any more.
    if verdict == "contradicts":
        _mark_conflict(evidence, raw.get("conflict"), by_id)

    return _Judged(
        verdict, confidence, rationale, evidence, applied, best,
        obligation=str(raw.get("obligation") or ""),
    )


# ---------------------------------------------------------------------------
# Whole-document mode
# ---------------------------------------------------------------------------

MODES = ("retrieval", "document")

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
    """
    if len(scope.designs) != 1:
        asked = (run.get("mode") or "retrieval") == "document"
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
    if (run.get("mode") or "retrieval") != "document":
        return "retrieval", None, None
    only = scope.designs[0]
    with db.connection() as conn:
        whole = whole_document.load(conn, only.document_id, only.title)
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
    scope: designs.Scope,
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
    precedents = _precedents(run, clause, query, vector, scope)

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
            rationale=(
                "This clause was not judged: the model's answer could not be read. Run the "
                f"assessment again. ({str(exc)[:120]})"
            ),
            evidence=[],
            retrieval_score=0.0,
            applied=[],
            design_id=scope.designs[0].document_id if not run.get("projectId") else None,
        )
        return

    verdict, confidence, rationale, _, claimed = _normalise(raw, clause)
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
            scope=scope,
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
        judged_obligation=str(raw.get("obligation") or ""),
        design_id=scope.designs[0].document_id if not run.get("projectId") else None,
    )


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
                'SELECT "clauseId", "designKey", "confidence", "rationale" FROM "finding" '
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
                design_id=row.get("designKey") or None,
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
            'SELECT "clauseId", "documentId", "verdict", "rationale" FROM "finding" '
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
            answered |= _adopt_confirmations(run, batch, raw, whole, design, scope)
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


def _render_absent(clauses: list[dict]) -> str:
    """The batch, numbered. The reply answers by number, never in the clause's words."""
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
            applied=[],
            design_id=design_id,
        )
        answered.add(clause["id"])
    return answered


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

    if verdict in CITING_VERDICTS:
        mismatch = fidelity.subject_mismatch(clause_text, evidence_text)
        if mismatch:
            return _demoted(mismatch, rationale)

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
_IMPERATIVE = re.compile(
    r"^\s*(?:Add|Replace|Remove|Define|Document|Specify|Route|Decouple|Split|Move|Set|"
    r"Enforce|Introduce|Restrict|Encrypt|Bound|Configure|Record|Obtain|Migrate|Separate|"
    r"Apply|Limit|Rename|Publish|Retire|Isolate|Pin|Scope|Require|Capture|Store|Rotate|"
    r"Terminate|Upgrade|Patch|Index|Partition|Cache|Throttle|Version|Validate|Review|"
    r"Confirm|Raise|Agree|Ask)\b",
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
        if family in low and family not in text
    ]


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
    if verdict == "partial" and _BREACH.search(rationale):
        verdict = "contradicts"

    # The model graded the clause as unmet and then wrote that the design meets
    # it. Trusting the prose here, as the rule above does: a remediation
    # sentence that argues compliance *is* the model's real answer, and the
    # verdict label is what it picked before writing it out.
    #
    # Promoted to "covered" rather than left contradicting itself, because the
    # alternative — a finding whose fix says there is nothing to fix — is
    # unusable, and `_guard` still runs afterwards. That guard demotes any
    # promoted verdict with no verified quote behind it, so this cannot invent
    # a pass: it can only let one the model already argued for stand or be
    # demoted on the evidence.
    if _fix_is_a_compliance_claim(verdict, rationale):
        logs.info(
            log,
            "remediation sentence argued compliance; trusting the prose",
            was=verdict,
        )
        verdict = "covered"

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
        [str(c) for c in cited if c],
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


def _render_clause(clause: dict) -> str:
    parts = []
    if clause["title"]:
        parts.append(f"Title: {clause['title']}")
    if clause["statement"]:
        parts.append(f"Statement: {clause['statement']}")
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
    return "\n".join(parts)


# The design's own words, as the comparison beside the clause prints them.
MAX_CONFLICT_QUOTE = 240


def _mark_conflict(
    evidence: list[dict],
    raw_conflict: object,
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
    if not isinstance(raw_conflict, dict):
        return
    extract = str(raw_conflict.get("extract") or "").strip()
    quote = " ".join(str(raw_conflict.get("quote") or "").split())
    if not extract or not quote:
        return

    candidate = by_id.get(extract)
    if candidate is None:
        logs.info(
            log,
            "conflict quote names an extract this finding does not cite",
            extract=extract,
        )
        return

    # Compared against `excerpt`, which is the text `_render_extracts` put in
    # front of the model — not the stored chunk, which may differ from it.
    haystack = " ".join(candidate.excerpt.split()).casefold()
    if quote.casefold() not in haystack:
        logs.info(log, "conflict quote is not inside its extract", extract=extract)
        return

    for item in evidence:
        if item.get("chunkId") == extract:
            item["conflictQuote"] = quote[:MAX_CONFLICT_QUOTE]
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
) -> None:
    """One finding, committed on its own so a crash costs at most one clause."""
    reference = _reference(clause)
    # Severity is a function of this, so it is recorded with the finding rather
    # than looked up later: the clause behind a report can be sharpened or
    # retired, and a report has to keep explaining its own severities.
    obligation = obligations.resolve(clause, judged_obligation)
    with db.transaction() as conn:
        db.execute(
            conn,
            """
            INSERT INTO "finding"
                ("id","runId","clauseId","documentId","designKey",
                 "clauseRef","clauseTitle","clauseStatement",
                 "verdict","confidence","rationale","evidence","retrievalScore",
                 "appliedDecisions","obligation","obligationSource")
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT ("runId","clauseId","designKey") DO UPDATE SET
                "documentId" = EXCLUDED."documentId",
                "verdict"    = EXCLUDED."verdict",
                "confidence" = EXCLUDED."confidence",
                "rationale"  = EXCLUDED."rationale",
                "evidence"   = EXCLUDED."evidence",
                "retrievalScore" = EXCLUDED."retrievalScore",
                "appliedDecisions" = EXCLUDED."appliedDecisions",
                "obligation" = EXCLUDED."obligation",
                "obligationSource" = EXCLUDED."obligationSource"
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

