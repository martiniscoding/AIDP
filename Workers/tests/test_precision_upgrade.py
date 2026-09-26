"""The precision upgrade, checked without a database or a model.

Every rule this exercises is pure: the specificity gate, the length caps, the
verdict guards, and whether a quote is found in the document. What is under
test is the judgement each of them makes, because all of them exist to stop a
confident answer that nothing supports, and a change that quietly relaxed one
would fail no other check in this repository.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_precision_upgrade.py
"""

from __future__ import annotations

import inspect
import os
import pathlib
import sys
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import advice, config, coverage, lifecycle, retrieval, whole_document  # noqa: E402
from aidp.ai import llm  # noqa: E402
from aidp.stages import analyse  # noqa: E402

passed = 0
failed = 0


def ok(name: str, condition: bool, detail: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  -> {detail!r}" if detail != "" else ""))


print("The specificity gate refuses advice that says nothing")

for filler in (
    "Consider implementing caching for the API Gateway.",
    "Consider adopting a service mesh.",
    "Ensure that proper logging is configured.",
    "Review and update the retention policy.",
    "Follow best practices for Kafka.",
    "Confirm support status of RabbitMQ.",
    "Align with stakeholders on the schema.",
    "Add retries.",
):
    ok(f"refuses {filler[:40]!r}", advice._is_generic(filler))

for real in (
    "Bound the Orders API retry to 3 attempts with backoff and a 30s dead-letter queue.",
    "Replicate the Postgres primary to a standby in eu-west-2 with streaming replication.",
    "Set the RabbitMQ consumer prefetch to 50 and enable publisher confirms on ingest.",
):
    ok(f"keeps {real[:40]!r}", not advice._is_generic(real))

ok(
    "a word that merely starts with a banned one is not filler",
    not advice._is_generic("The gateway considered here terminates TLS 1.3 for inbound traffic."),
)
ok("a recommendation under six words is filler", advice._is_generic("Encrypt the bucket."))


print("\nLength caps cut at a sentence, not mid-clause")

ok("recommendation cap", advice.MAX_RECOMMENDATION == 320)
ok("why cap", advice.MAX_WHY == 220)
ok("rationale cap", analyse.MAX_RATIONALE == 280)

cut = coverage._sentences("The gateway terminates TLS for every inbound call. " * 12, 320)
ok("within the cap", len(cut) <= 320, len(cut))
ok("ends on a full stop", cut.endswith("."), cut[-40:])
ok("short text is untouched", coverage._sentences("Short and done.", 320) == "Short and done.")
ok(
    "one long sentence falls back to an ellipsis",
    coverage._sentences("x" * 500, 320).endswith("…"),
)

_, _, rationale, _, _ = analyse._normalise(
    {"verdict": "partial", "confidence": 0.8, "rationale": "The design states a thing. " * 40}
)
ok("a long rationale is cut to the cap", len(rationale) <= 280, len(rationale))
ok("and ends on a full stop", rationale.endswith("."), rationale[-40:])


print("\nAn absent nobody is sure of is a question, not an answer")

verdict, reason = analyse._guard("absent", 0.40, [], 1.0, "The design is silent on key rotation.")
ok("low confidence is demoted even on strong retrieval", verdict == "needs_review", verdict)
ok("the demotion stays within the cap", len(reason) <= analyse.MAX_RATIONALE, len(reason))
ok("the guard's own reason comes first", reason.startswith("Reported absent with low"), reason[:40])
ok("a confident absent stands", analyse._guard("absent", 0.90, [], 1.0, "Silent.")[0] == "absent")

_, bounded = analyse._guard("absent", 0.2, [], 1.0, "Sentence about the design. " * 30)
ok("guard and model text together stay bounded", len(bounded) <= analyse.MAX_RATIONALE, len(bounded))

verdict, _ = analyse._guard_document(
    "absent",
    0.30,
    "No mention of backups.",
    evidence=[],
    unverified=[],
    fabricated=[],
    conflicted=False,
)
ok("the floor runs in whole-document mode too", verdict == "needs_review", verdict)
verdict, _ = analyse._guard_document(
    "absent",
    0.95,
    "Genuinely silent.",
    evidence=[],
    unverified=[],
    fabricated=[],
    conflicted=False,
)
ok("and a confident one still stands there", verdict == "absent", verdict)


print("\nA quote in a diagram is found, and known to be from one")

doc = whole_document.build(
    "Telemetry SAD",
    [{"page": 1, "kind": "text", "text": "The platform ingests telemetry from field devices."}],
    [
        {
            "id": "fig-7",
            "page": 2,
            "description": (
                "An API Gateway fronts the ingest service and terminates TLS for all "
                "inbound traffic."
            ),
            "reviewState": None,
        }
    ],
)

check = doc.verify("The platform ingests telemetry from field devices", 1)
ok("the document's own words are found", check.verified and check.source_kind == "page")
ok("and carry no figure", check.figure_id is None)

check = doc.verify("An API Gateway fronts the ingest service", 2)
ok("a diagram's words are found at all", check.verified, check.reason)
ok("labelled as a diagram", check.source_kind == "figure", check.source_kind)
ok("and carrying the figure they came from", check.figure_id == "fig-7", check.figure_id)

ok(
    "words in neither are still refused",
    not doc.verify("A Kafka cluster replicates across three regions", None).verified,
)
ok(
    "a figure a reviewer rejected is not searched",
    not whole_document.build(
        "t",
        [{"page": 1, "kind": "text", "text": "Anything."}],
        [
            {
                "id": "f",
                "page": 2,
                "description": "An API Gateway fronts it.",
                "reviewState": "rejected",
            }
        ],
    )
    .verify("An API Gateway fronts it", 2)
    .verified,
)

evidence, _ = analyse._checked_quotes(
    {"evidence": [{"quote": "An API Gateway fronts the ingest service", "page": 2}]}, doc
)
ok("the evidence keeps the diagram", len(evidence) == 1 and evidence[0]["sourceKind"] == "figure")
ok("and the figure id reaches the report", evidence[0]["figureId"] == "fig-7", evidence)
page_evidence, _ = analyse._checked_quotes(
    {"evidence": [{"quote": "The platform ingests telemetry from field devices", "page": 1}]}, doc
)
ok("a page quote is not mislabelled", page_evidence[0]["sourceKind"] == "quote")
ok("and has no figure", page_evidence[0]["figureId"] is None)


print("\nA diagram alone carries a verdict only when it is really about the clause")

ok("the confidence floor", analyse.FIGURE_COVERED_CONFIDENCE == 0.80)
ok("the words needed", analyse.FIGURE_KEYWORD_HITS == 2)

CLAUSE = "Transport encryption. All inbound traffic must terminate TLS at the API gateway."
ON_POINT = "An API Gateway fronts the ingest service and terminates TLS for all inbound traffic."
OFF_POINT = "A flowchart showing an operator approving a purchase order before dispatch."

ok("the clause's own words corroborate", analyse._figure_corroborates(CLAUSE, ON_POINT, 1))
ok("a diagram about something else does not", not analyse._figure_corroborates(CLAUSE, OFF_POINT, 1))
ok("two diagrams stand in for the words", analyse._figure_corroborates(CLAUSE, OFF_POINT, 2))
ok(
    "common prose is not a match",
    not analyse._figure_corroborates(
        "The system shall provide appropriate documentation for each service.",
        "A diagram of the system and its services with appropriate documentation.",
        1,
    ),
)
ok("a word too short to mean anything is ignored", analyse._keywords("of in a to") == set())

one_figure = [{"chunkId": "c1", "sourceKind": "figure", "excerpt": ON_POINT}]


def guarded(verdict: str, confidence: float, evidence: list, clause: str = CLAUSE) -> str:
    return analyse._guard(
        verdict,
        confidence,
        evidence,
        1.0,
        "Shown in the architecture diagram.",
        # Only the diagram-derived rows are "generated" — the whole point of the
        # guard is what happens when that set is the entire citation.
        cited_generated={
            item["chunkId"] for item in evidence if item["sourceKind"] == "figure"
        },
        cited_total=len(evidence),
        clause_text=clause,
        figure_text=" ".join(
            item["excerpt"] for item in evidence if item["sourceKind"] == "figure"
        ),
    )[0]


ok("confident and on the subject stands", guarded("covered", 0.85, one_figure) == "covered")
ok("under the floor is demoted", guarded("covered", 0.79, one_figure) == "needs_review")
ok(
    "confident but about something else is demoted",
    guarded("covered", 0.99, [{"chunkId": "c1", "sourceKind": "figure", "excerpt": OFF_POINT}])
    == "needs_review",
)
ok(
    "two diagrams carry it without the words",
    guarded(
        "covered",
        0.85,
        [
            {"chunkId": "c1", "sourceKind": "figure", "excerpt": OFF_POINT},
            {"chunkId": "c2", "sourceKind": "figure", "excerpt": "Another view of the same flow."},
        ],
    )
    == "covered",
)
ok(
    "a contradiction on a diagram alone is always put to a reviewer",
    guarded("contradicts", 0.99, one_figure) == "needs_review",
)
ok(
    "evidence that is not all diagrams is left alone",
    guarded(
        "covered",
        0.50,
        [
            {"chunkId": "c1", "sourceKind": "figure", "excerpt": ON_POINT},
            {"chunkId": "c2", "sourceKind": "clause", "excerpt": "TLS 1.2 or higher is required."},
        ],
    )
    == "covered",
)
ok(
    "a diagram still supports a partial",
    analyse._guard_document(
        "partial",
        0.8,
        "Engages but leaves rotation unmet.",
        evidence=one_figure,
        unverified=[],
        fabricated=[],
        conflicted=False,
        clause_text=CLAUSE,
    )[0]
    == "partial",
)

print("\nArchitecture prose does not corroborate anything")

# Measured against samples/: one ordinary context diagram matched 44 of the 54
# clauses in the three sample standards -- the encryption clause among them --
# on words like "data", "through" and "rather". These cases pin the words whose
# removal took that to 7, because the gate is only worth having while a match
# means the diagram is about the clause.
CONTEXT_DIAGRAM = (
    "Enterprise context diagram. Customer, billing and field domains are drawn as "
    "grouped boxes. Arrows show governed data flow passing through a central "
    "integration platform rather than directly between systems."
)
for governed, subject in (
    (
        "6.3 Encryption. Data must be encrypted in transit using TLS 1.2 or above, "
        "including across private networks.",
        "encryption",
    ),
    (
        "3.3 Statelessness. Session state must be externalised to a shared cache "
        "rather than held in local application memory.",
        "statelessness",
    ),
    (
        "3.1 Network segmentation. Production networks must be segmented from "
        "corporate networks with controlled flow between them.",
        "network segmentation",
    ),
):
    ok(
        f"a context diagram does not answer the {subject} clause",
        not analyse._figure_corroborates(governed, CONTEXT_DIAGRAM, 1),
        sorted(analyse._keywords(governed) & analyse._keywords(CONTEXT_DIAGRAM)),
    )

ok(
    "but it does answer the clause it belongs to",
    analyse._figure_corroborates(
        "1.3 Enterprise Context. Figure 1 - Enterprise context. Systems are grouped "
        "by domain; arrows indicate governed data flow through the integration "
        "platform.",
        CONTEXT_DIAGRAM,
        1,
    ),
)

for filler in ("data", "through", "rather", "between", "platform", "access", "control"):
    ok(f"{filler!r} alone carries no subject matter", analyse._keywords(filler) == set())


print("\nCoverage holds its gaps and standards to the same standard")

ok("the filter is shared, not copied", advice._is_generic is coverage._is_generic)
ok("and so is its word floor", advice.MIN_RECOMMENDATION_WORDS == coverage.MIN_SPECIFIC_WORDS)
ok("gap cap", coverage.MAX_GAP_WHAT == 220)
ok("suggestion covers cap", coverage.MAX_SUGGESTION_COVERS == 300)
ok("suggestion why cap", coverage.MAX_SUGGESTION_WHY == 220)
ok("a refusal counter exists for generic wording", "generic" in coverage.Checked().dropped)

for filler in (
    "Consider implementing appropriate controls.",
    "Ensure that proper governance is applied.",
    "Review and update this area.",
    "Follow best practices.",
):
    ok(f"coverage refuses {filler[:36]!r}", coverage._is_generic(filler))

for real in (
    "The storefront caches card numbers in Redis with no stated expiry or tokenisation.",
    "Telemetry is written straight to the billing Oracle database with no staging table.",
):
    ok(f"coverage keeps {real[:36]!r}", not coverage._is_generic(real))

long_what = "The portal stores customer addresses in its own schema. " * 8
ok(
    "a long gap is cut to the cap at a sentence",
    len(coverage._sentences(long_what, coverage.MAX_GAP_WHAT)) <= coverage.MAX_GAP_WHAT
    and coverage._sentences(long_what, coverage.MAX_GAP_WHAT).endswith("."),
    coverage._sentences(long_what, coverage.MAX_GAP_WHAT),
)


print("\nLifecycle reports facts, and has nowhere to put an opinion")

# Every stored lifecycle field is either copied from the design under a cap or
# computed from endoflife.date. The only free text is `note`, which this module
# writes itself. If a prose field is ever added, this test should start failing.
outcome = lifecycle._outcome("skipped", "Turned off in this deployment.")
ok("the note is ours, not the model's", outcome["note"] == "Turned off in this deployment.")
ok("no technology carries prose by default", outcome["technologies"] == [])
prose = {"name", "version", "quote", "note"}
stored = set(outcome) | {"name", "product", "version", "section", "quote", "page"}
ok(
    "no summary, rationale or recommendation field exists",
    not (stored & {"summary", "rationale", "recommendation", "advice", "why"}),
    sorted(stored & {"summary", "rationale", "recommendation", "advice", "why"}),
)
ok("and the fields that do hold model text are capped", prose.issubset(stored))


print("\nThe provider follows the key that is actually configured")

# Every model call reads the key belonging to `llm_provider`, so the two have to
# agree. They used to be set separately, and a worker given only an OpenRouter
# key defaulted to gemini, found no gemini key, and reported no model configured
# while holding a working one.
for label, environment, expected in (
    ("an OpenRouter key alone", {"OPENROUTER_API_KEY": "x"}, "openrouter"),
    ("a Gemini key alone", {"GEMINI_API_KEY": "x"}, "gemini"),
    ("Google's spelling of it", {"GOOGLE_API_KEY": "x"}, "gemini"),
    ("an Anthropic key alone", {"ANTHROPIC_API_KEY": "x"}, "anthropic"),
    (
        "two keys, in preference order",
        {"GEMINI_API_KEY": "x", "OPENROUTER_API_KEY": "x"},
        "gemini",
    ),
    (
        "an explicit choice outranks a key",
        {"LLM_PROVIDER": "anthropic", "OPENROUTER_API_KEY": "x"},
        "anthropic",
    ),
    # Named but unkeyed stays named: that deployment wants the missing-key
    # error, not someone else's model quietly answering and billing.
    ("a provider named without its key", {"LLM_PROVIDER": "openrouter"}, "openrouter"),
    ("case and spacing around the name", {"LLM_PROVIDER": "  OpenRouter  "}, "openrouter"),
    ("nothing configured at all", {}, "gemini"),
):
    with mock.patch.dict(os.environ, environment, clear=True):
        chosen = config._provider()
    ok(f"{label} -> {expected}", chosen == expected, chosen)


print("\nA judgement is asked for at temperature zero")

# Verdict drift between runs of an unchanged design is the one kind of noise a
# reviewer cannot account for, so every call that produces a verdict, a
# confirmation, advice, coverage or a technology list is asked at zero. The two
# rules readings are the deliberate exception: they are a cross-check, and at
# zero they would make the same mistakes and agree for the wrong reason.
ok("the OpenRouter client defaults to zero",
   inspect.signature(llm.OpenRouterLLM._chat).parameters["temperature"].default == 0.0)
ok("a Gemini call carrying a schema is zero",
   inspect.signature(llm.GeminiLLM._generate).parameters["temperature"].default is None)

source = pathlib.Path(llm.__file__).read_text(encoding="utf-8")
ok("Gemini's structured branch pins zero", '(0.0 if schema else 0.2)' in source)
judgement = (
    "def judge", "def judge_document", "def confirm_absent",
    "def suggest_improvements", "def find_uncovered", "def find_technologies",
)
bad: list[str] = []
for block in source.split("\n    def ")[1:]:
    name = "def " + block.split("(")[0]
    if name not in judgement:
        continue
    for line in block.splitlines():
        if "temperature" in line and "=" in line:
            value = line.split("temperature")[1].strip(' :=",')
            if not value.startswith("0"):
                bad.append(f"{name}: {line.strip()[:50]}")
ok("no judgement method asks for anything else", not bad, bad)
ok("the first rules reading is deterministic", llm._rules_temperature(1) == 0.0)
ok("and only the cross-check samples", llm._rules_temperature(2) > 0)


print("\nAn absent nobody could confirm is not presented as settled")

ok("the band needing confirmation", analyse.CONFIRM_REQUIRED_CONFIDENCE == 0.85)
verdict, rationale = analyse._demoted(
    analyse.UNCONFIRMED_ABSENT, "Nothing in the document mentions retention."
)
ok("a failed re-read demotes to needs_review", verdict == "needs_review", verdict)
ok("saying so first", rationale.startswith("Absent confirmation unavailable"), rationale[:40])
ok("within the cap", len(rationale) <= analyse.MAX_RATIONALE, len(rationale))

# The failure path must not raise: the other verdicts of the run still have to
# reach the report. It is reached with no database here, so the inner query
# fails too, and both layers are exercised at once.
raised = None
try:
    analyse._demote_unconfirmed({"id": "run-1"}, [], "the provider refused")
except Exception as exc:  # noqa: BLE001 — that it raises at all is the failure
    raised = exc
ok("and a failure inside it is still swallowed", raised is None, raised)

raised = None
try:
    analyse._confirm_absents({"id": "run-1", "documentId": "doc-1"}, [])
except Exception as exc:  # noqa: BLE001
    raised = exc
ok("as it is for the pass as a whole", raised is None, raised)


class _NoConnection:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


# What it writes, with the database standing in. The run above only proved it
# does not raise; this proves it does the work.
_clauses = [
    {
        "id": "c1",
        "numberText": "8.1",
        "headingPath": "Data 8.1",
        "title": "Retention",
        "statement": "Retention periods must be defined.",
    }
]
_written: list[dict] = []
_asked: dict = {}
with (
    mock.patch.object(analyse.db, "connection", lambda: _NoConnection()),
    mock.patch.object(
        analyse.db,
        "query",
        lambda conn, sql, args: _asked.update(sql=sql, args=args)
        or [{"clauseId": "c1", "confidence": 0.70, "rationale": "Nothing found on retention."}],
    ),
    mock.patch.object(analyse, "_write", lambda *a, **k: _written.append(k)),
):
    _count = analyse._demote_unconfirmed({"id": "run-1"}, _clauses, "the provider refused")

ok("the finding is rewritten", _count == 1 and len(_written) == 1, (_count, len(_written)))
ok("as needs_review", _written and _written[0]["verdict"] == "needs_review")
ok(
    "saying the confirmation never ran",
    _written and _written[0]["rationale"].startswith(analyse.UNCONFIRMED_ABSENT),
    _written[0]["rationale"][:60] if _written else "",
)
ok(
    "keeping the model's own reason after it",
    _written and "Nothing found on retention." in _written[0]["rationale"],
)
ok(
    "and only the absents that needed confirming are asked for",
    _asked.get("args") == ("run-1", "absent", analyse.CONFIRM_REQUIRED_CONFIDENCE),
    _asked.get("args"),
)


print("\nA diagram is not left behind by a long document's search")

ok("the lookahead is real", retrieval.FIGURE_LOOKAHEAD > 0)


def candidate(name, *, kind="clause", page=1, text="A paragraph about something.", head="3 Security"):
    return retrieval.Candidate(
        chunk_id=name, heading_path=head, text=text, page_start=page, score=0.1,
        vector_rank=1, lexical_rank=1, source_kind=kind, source_id=name,
    )


CLAUSE_QUERY = "All inbound traffic must terminate TLS at the API gateway"
ON_PAGE = candidate(
    "fig", kind="figure", page=1,
    text="An API Gateway terminates TLS for all inbound traffic.",
)
ELSEWHERE = candidate(
    "far", kind="figure", page=99, head="9 Appendix",
    text="An API Gateway terminates TLS for all inbound traffic.",
)
OFF_TOPIC = candidate(
    "off", kind="figure", page=1,
    text="A purchase order approval flowchart with a rejection loop.",
)
text_window = [candidate(f"t{i}") for i in range(8)]

carried = retrieval.with_figure(text_window + [ON_PAGE], CLAUSE_QUERY, 8)
ok("a relevant diagram on a page already reached is carried in",
   any(c.is_generated for c in carried))
ok("and the judge still sees no more than before", len(carried) == 8, len(carried))
ok("the text it displaced is the lowest ranked",
   [c.chunk_id for c in carried][:7] == [f"t{i}" for i in range(7)])
ok("a diagram somewhere else in the document is left alone",
   not any(c.is_generated for c in retrieval.with_figure(
       text_window + [ELSEWHERE], CLAUSE_QUERY, 8)))
ok("so is one on the page that is about something else",
   not any(c.is_generated for c in retrieval.with_figure(
       text_window + [OFF_TOPIC], CLAUSE_QUERY, 8)))
ok("a window that already has a diagram is untouched",
   sum(1 for c in retrieval.with_figure(
       [candidate("f0", kind="figure")] + text_window[:7], CLAUSE_QUERY, 8)
       if c.is_generated) == 1)
ok("and a result set shorter than the window is returned whole",
   len(retrieval.with_figure(text_window[:3], CLAUSE_QUERY, 8)) == 3)

print("\nA rationale that states a breach settles the verdict")

# The model wrote the breach out and graded it "partial" anyway. On the sample
# corpus this was telem Data 7.2, live, with both prompts telling it not to.
ROW_12 = "Failed messages are dropped after retries without dead-letter queue."
ok(
    "the live rationale that started this promotes",
    analyse._normalise({"verdict": "partial", "confidence": 0.9, "rationale": ROW_12})[0]
    == "contradicts",
)
for stated in (
    "The analytics service connects directly to the Oracle database, violating the rule.",
    "This breaches the encryption requirement for data in transit.",
    "The approach conflicts with the single-source-of-truth rule.",
    "The design directly contradicts the versioning requirement.",
    "Records are deleted before the retention period expires.",
    "Events are discarded when the queue is full.",
):
    ok(
        f"stated breach promotes: {stated[:44]!r}",
        analyse._normalise({"verdict": "partial", "confidence": 0.9, "rationale": stated})[0]
        == "contradicts",
    )

# The line this must not cross. Absence is not a breach, and reading it as one
# would turn ordinary findings into contradictions — the expensive direction.
for gap in (
    "Encryption is specified, but key rotation is not mentioned.",
    "No dead-letter queue is mentioned for failed messages.",
    "Retention periods are defined but archival is not detailed.",
    "The design does not address correlation identifiers.",
    "Dropped connections are retried automatically.",
):
    ok(
        f"a gap stays partial: {gap[:44]!r}",
        analyse._normalise({"verdict": "partial", "confidence": 0.9, "rationale": gap})[0]
        == "partial",
    )

for other in ("covered", "absent", "needs_review", "contradicts"):
    ok(
        f"{other!r} is never rewritten",
        analyse._normalise(
            {"verdict": other, "confidence": 0.9, "rationale": ROW_12}
        )[0]
        == other,
    )

# Promotion is not a way past the guards: a contradiction still needs a quote.
ok(
    "a promoted verdict with no evidence is still demoted",
    analyse._guard_document(
        *analyse._normalise({"verdict": "partial", "confidence": 0.9, "rationale": ROW_12})[:3],
        evidence=[],
        unverified=[],
        fabricated=[],
        conflicted=False,
    )[0]
    == "needs_review",
)


print("\nA verified quote in the wrong section moves to the right one")


def _section(ordinal, title, body, page):
    section = coverage.Section(
        ordinal=ordinal, title=title, heading_path=title, page_start=page, page_end=page
    )
    section.lines = body
    section.pages = {page}
    return section


FAILOVER = "Failed messages are written to the application log and discarded."
GATEWAY = "The API Gateway terminates TLS for all inbound traffic."
s1 = _section(1, "2 Ingest", ["The ingest service accepts device readings.", GATEWAY], 2)
s2 = _section(2, "4 Failure Handling", [FAILOVER], 3)
sections = [s1, s2]
doc = whole_document.build(
    "Telemetry",
    [
        {"page": 2, "kind": "text", "text": "The ingest service accepts device readings."},
        {"page": 2, "kind": "text", "text": GATEWAY},
        {"page": 3, "kind": "text", "text": FAILOVER},
    ],
    [],
)

quote, page, reason, home = coverage._checked_quote(
    {"quote": FAILOVER, "page": 3}, s1, doc, sections
)
ok("the quote is kept", quote is not None, reason)
ok("and rehomed to the section that holds it", home.ordinal == 2, home.ordinal)
ok("with that section's page", page == 3, page)

quote, _, reason, home = coverage._checked_quote({"quote": FAILOVER, "page": 3}, s2, doc, sections)
ok("a correctly cited quote does not move", quote is not None and home.ordinal == 2)

quote, _, reason, home = coverage._checked_quote(
    {"quote": "The platform uses quantum-resistant cryptography.", "page": 2}, s1, doc, sections
)
ok("words in no section are still refused", quote is None and reason == "unverified", reason)

quote, _, reason, _ = coverage._checked_quote({"quote": FAILOVER, "page": 3}, s1, doc, None)
ok(
    "and without the section list the old behaviour stands",
    quote is None and reason == "outsideSection",
    reason,
)

# Two sections holding the same words cannot say which was meant, so neither is
# chosen — attaching a suggestion to the wrong part of a design is the failure
# the section check exists to prevent.
twin = _section(3, "6 Appendix", [FAILOVER], 9)
quote, _, reason, _ = coverage._checked_quote(
    {"quote": FAILOVER, "page": 3}, s1, doc, [s1, s2, twin]
)
ok("an ambiguous rehome is refused", quote is None and reason == "outsideSection", reason)

# End to end through advice.check(): the suggestion survives, in section 2.
checked = advice.check(
    {
        "suggestions": [
            {
                "title": "Dead-letter the failed telemetry messages",
                "kind": "improve",
                "category": "resilience",
                "priority": "high",
                "section": 1,
                "component": "application log",
                "quote": FAILOVER,
                "page": 3,
                "recommendation": (
                    "Route failed telemetry messages to a dead-letter queue instead of "
                    "discarding them after the retry budget is spent."
                ),
                "why": "Discarded readings cannot be replayed, so the billing feed loses data.",
                "clauses": [],
            }
        ]
    },
    sections,
    doc,
    [],
)
ok("advice keeps the rehomed suggestion", len(checked.suggestions) == 1, checked.dropped)
ok(
    "recorded against the section that holds the quote",
    checked.suggestions and checked.suggestions[0]["section"] == 2,
    checked.suggestions[0]["section"] if checked.suggestions else None,
)
ok("and nothing was counted as refused", sum(checked.dropped.values()) == 0, checked.dropped)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
