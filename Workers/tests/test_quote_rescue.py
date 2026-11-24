"""A verdict demoted for a badly copied quote comes back only when readings agree.

`_guard_document` demotes a reading whose quote does not verify, and it cannot
tell an invented quote from a real table row copied with a cell spliced. On the
Meridian run that sent INT-002, DAT-022, INT-004 and INT-008 — all clauses the
key marks covered, every reading of each saying covered — to `needs_review`.

`_rescue` gives those back, and the rule it follows is the point of this file:
a wrong "covered" is the expensive error, so one reading is never enough. At
least two readings must have reached the same verdict, each with a quote whose
opening words are the document's own, and that verdict must lead every other
final answer. Words that are not in the document never count.

No database, no model, no network.

    python tests/test_quote_rescue.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import whole_document as wd  # noqa: E402
from aidp.stages import analyse  # noqa: E402

passed = 0
failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name}", extra)


ROW = (
    "Source → Target: Web/mobile → API Gateway | Pattern / mechanism: "
    "Request-Response; HTTPS REST | Latency, frequency, volume: Interactive; "
    "payload <2 MB; peak 1,500 req/s platform-wide"
)
DOC = wd.build("MERIDIAN ONE", [{"page": 5, "kind": "table_row", "text": ROW}], [])

# A real opening, then cells the document does not contain in that order.
SPLICED = (
    "Source → Target: Web/mobile → API Gateway | Pattern / mechanism: "
    "Request-Response; HTTPS REST | Latency, frequency, volume: Interactive; "
    "payload <9 GB; peak 40,000 req/s everywhere and always"
)
INVENTED = "The platform stores every customer password in a plaintext spreadsheet on a shared drive"


def reading(verdict: str, held=None, evidence=None) -> analyse._Judged:
    return analyse._Judged(
        verdict, 1.0, f"{verdict} rationale", evidence or [], [], 0.0, held=held
    )


def held_covered() -> tuple:
    partial = analyse._prefix_evidence([(SPLICED, "the quoted words are not in the document")], DOC)
    return ("covered", "covered rationale", partial)


print("\nWhat counts as the document's own opening")
ok("the splice is refused whole", not DOC.verify(SPLICED, 5).verified)
partial = analyse._prefix_evidence([(SPLICED, "x")], DOC)
ok("its real opening is found", len(partial) == 1, partial)
ok(
    "only the words that were found are kept as the excerpt",
    bool(partial) and "40,000" not in partial[0]["excerpt"] and "<9 GB" not in partial[0]["excerpt"],
    partial,
)
ok("and it is marked as partly verified", bool(partial) and partial[0].get("partial") is True)
ok(
    "an invented quote gives nothing",
    analyse._prefix_evidence([(INVENTED, "x")], DOC) == [],
)
ok(
    "a quote shorter than the minimum gives nothing",
    analyse._prefix_evidence([("Source → Target: Web/mobile", "x")], DOC) == [],
)

print("\nWhen a demotion is undone")
held = held_covered()
two = analyse._rescue([reading("needs_review", held), reading("needs_review", held)])
ok("two agreeing readings are rescued", [j.verdict for j in two] == ["covered", "covered"], two)
ok("with the located words as evidence", bool(two[0].evidence) and two[0].evidence[0].get("partial"))
ok("and the rationale says the quote was only partly verified", "partly verified" in two[0].rationale)

three = analyse._rescue(
    [reading("needs_review", held), reading("needs_review", held), reading("needs_review")]
)
ok(
    "two of three is enough, the third stays as it was",
    [j.verdict for j in three] == ["covered", "covered", "needs_review"],
    three,
)

print("\nWhen it is not")
one = analyse._rescue([reading("needs_review", held), reading("contradicts")])
ok("a single reading is never rescued", [j.verdict for j in one] == ["needs_review", "contradicts"], one)

lead = analyse._rescue(
    [
        reading("needs_review", held),
        reading("needs_review", held),
        reading("contradicts"),
        reading("contradicts"),
    ]
)
ok(
    "a verdict that does not lead the others is left demoted",
    [j.verdict for j in lead] == ["needs_review", "needs_review", "contradicts", "contradicts"],
    lead,
)

none = analyse._rescue([reading("needs_review"), reading("needs_review")])
ok("readings with nothing held are untouched", [j.verdict for j in none] == ["needs_review"] * 2)
ok(
    "not_applicable is never a rescuable verdict",
    "not_applicable" not in analyse._RESCUABLE and "not_assessable" not in analyse._RESCUABLE,
)

print("\nThrough the vote")
final = analyse._vote([reading("needs_review", held), reading("needs_review", held)])
ok("the vote returns covered", final.verdict == "covered", final.verdict)
ok("and says two readings agreed", final.agreed == 2 and final.readings == 2)
alone = analyse._vote([reading("needs_review", held)])
ok("a single-reading clause stays demoted", alone.verdict == "needs_review")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
