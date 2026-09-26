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

from aidp import advice, coverage, whole_document  # noqa: E402
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

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
