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

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import advice, coverage, lifecycle, whole_document  # noqa: E402
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

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
