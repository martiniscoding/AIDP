"""A quote of the stack record is answered with the design's own words, or not at all.

A technology clause is judged with the organisation's stack printed under it,
and the judge often quotes that record — "Amazon Redshift — recorded as Hold" —
as its evidence. The quote guard rightly refuses words the design never wrote,
and on Meridian that demoted readings of EA-007 and EA-008 that had found the
breach.

`_stack_quotes` swaps such a quote for the design sentence the stack entry was
built from, checked against the document like any other quote. The rule this
file holds it to: the record itself never becomes evidence, a quote that is not
a stack line is left refused, and a design sentence that is not in the document
is dropped.

No database, no model, no network.

    python tests/test_stack_quotes.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import stack  # noqa: E402
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


PAGE = (
    "The analytics layer loads curated data into Amazon Redshift for reporting and "
    "finance dashboards. Customer accounts live in an Oracle Database on Amazon RDS "
    "that the order service reads on every checkout."
)
DOC = wd.build("MERIDIAN ONE", [{"page": 7, "kind": "text", "text": PAGE}], [])

ROWS = stack.Stack(
    [
        stack.Row("Amazon Redshift", "hold", approved_versions="RA3 / Serverless",
                  notes="Migrate to Databricks SQL on a rolling basis."),
        stack.Row("Oracle Database (Amazon RDS)", "hold", approved_versions="19c"),
        stack.Row("Amazon S3", "adopt"),
    ]
)
HITS = [
    stack.Hit(ROWS.rows[0], stack._around(PAGE, PAGE.index("Amazon Redshift"), PAGE.index("Amazon Redshift") + 15, 40)),
    stack.Hit(ROWS.rows[1], stack._around(PAGE, PAGE.index("Oracle Database"), PAGE.index("Oracle Database") + 15, 40)),
]
BLOCK = stack.render(ROWS, HITS)

REDSHIFT_LINE = (
    "Amazon Redshift — recorded as Hold, approved versions: RA3 / Serverless. "
    "Stack notes: Migrate to Databricks SQL on a rolling basis."
)
REFUSED = "the quoted words are not in the document"

print("\nThe block is what the judge reads")
ok("the stack line is not in the document", not DOC.verify(REDSHIFT_LINE, None).verified)
ok("each entry carries the design's own words", BLOCK.count("Design says:") == 2, BLOCK)

print("\nA quote of a stack line")
found, left = analyse._stack_quotes([(REDSHIFT_LINE, REFUSED)], BLOCK, DOC)
ok("is answered", len(found) == 1 and left == [], (found, left))
ok("with the design's sentence, not the record", bool(found) and "recorded as" not in found[0]["excerpt"])
ok("which names the technology", bool(found) and "Amazon Redshift" in found[0]["excerpt"])
ok("and is found in the document", bool(found) and DOC.verify(found[0]["excerpt"], None).verified)
ok("on its page", bool(found) and found[0]["page"] == 7)

mangled = REDSHIFT_LINE.replace(" — ", " \x187 ")
found, left = analyse._stack_quotes([(mangled, REFUSED)], BLOCK, DOC)
ok("a mangled dash still matches its entry", len(found) == 1 and left == [], (found, left))

oracle = "Oracle Database (Amazon RDS) — recorded as Hold, approved versions: 19c"
found, _ = analyse._stack_quotes([(oracle, REFUSED)], BLOCK, DOC)
ok("a bracketed name matches its own entry only", len(found) == 1 and "Oracle" in found[0]["excerpt"], found)

heading = "Technologies this design names that appear in the organisation's technology stack"
found, left = analyse._stack_quotes([(heading, REFUSED)], BLOCK, DOC)
ok("the list's heading stands for every entry under it", len(found) == 2 and left == [], found)

snippet = HITS[0].quote
found, left = analyse._stack_quotes([(f"Design says: {snippet}", REFUSED)], BLOCK, DOC)
ok("a 'Design says' line, label and all, is answered", len(found) == 1 and left == [], (snippet, found))
found, left = analyse._stack_quotes([(snippet.strip("…") + " and more", REFUSED)], BLOCK, DOC)
ok("so is the snippet copied without its label", len(found) == 1 and left == [], (snippet, found))
ok("by the entry it was copied from", bool(found) and "Redshift" in found[0]["excerpt"], found)

print("\nA snippet the stack module flattened")
TABLE = wd.build(
    "MERIDIAN ONE",
    [{"page": 4, "kind": "text", "text": (
        "Data platform\nOperational extracts, analytical models and executive reporting.\n"
        "S3, Glue, Redshift; selected reports query Aurora\nreplicas.\nShared platform")}],
    [],
)
flattened = (
    "…2: Operational extracts, analytical models and executive reporting.. "
    "column 3: S3, Glue, Redshift; selected repor…"
)
got = analyse._design_words(flattened, "Amazon Redshift", TABLE)
ok("the whole snippet is not the document's wording", not TABLE.verify(analyse._unclipped(flattened), None).verified)
ok("the cell naming the technology is found", bool(got) and "Redshift" in got[0], got)
ok("and only that cell", bool(got) and "column" not in got[0] and "Operational" not in got[0], got)
ok(
    "a cell that does not name the technology is never taken",
    analyse._design_words(flattened, "Amazon Cognito", TABLE) is None,
)

print("\nWhat is left refused")
invented = "Amazon Redshift is approved for all new analytical workloads across the platform"
found, left = analyse._stack_quotes([(invented, REFUSED)], BLOCK, DOC)
ok("a sentence that only names a stack technology", found == [] and left == [(invented, REFUSED)])

s3 = "Amazon S3 — recorded as Adopt"
found, left = analyse._stack_quotes([(s3, REFUSED)], BLOCK, DOC)
ok("an entry from the full list, which has no design words", found == [] and len(left) == 1, found)

ghost = stack.render(ROWS, [stack.Hit(ROWS.rows[0], "Redshift clusters are replicated to a second region nightly")])
found, left = analyse._stack_quotes([(REDSHIFT_LINE, REFUSED)], ghost, DOC)
ok("design words that are not in the document", found == [] and len(left) == 1, found)

found, left = analyse._stack_quotes([(REDSHIFT_LINE, REFUSED)], "", DOC)
ok("anything, when no stack was shown", found == [] and len(left) == 1)

print("\nThrough one reading")


def judged(raw: dict, block: str) -> analyse._Judged:
    real = analyse.llm.judge_document
    analyse.llm.judge_document = lambda **_: raw
    try:
        clause = {"ref": "EA-008", "title": "Technology Approval", "statement":
                  "New technology must be approved through the technology stack before use.",
                  "requirements": {}, "documentTitle": "EA", "headingPath": "EA-008"}
        return analyse.judged_document_once(clause, DOC, reference="EA", stack_block=block)
    finally:
        analyse.llm.judge_document = real


raw = {
    "verdict": "contradicts",
    "confidence": 0.9,
    "rationale": "The design uses Amazon Redshift, which the stack records as Hold, for new reporting work. "
                 "That breaches the approval clause. Reporting on a Hold platform deepens the migration debt. "
                 "Move the reporting load to an Adopt platform.",
    "evidence": [{"quote": REDSHIFT_LINE, "page": 1}],
}
try:
    one = judged(raw, BLOCK)
    ok("a stack-line quote no longer demotes the reading", one.verdict == "contradicts", (one.verdict, one.rationale))
    ok("and the evidence is the design's sentence", bool(one.evidence) and "recorded as" not in one.evidence[0]["excerpt"], one.evidence)
    bare = judged(raw, "")
    ok("without the block the same quote is still refused", bare.verdict == "needs_review", bare.verdict)
except Exception as error:  # the clause shape is the engine's; say so plainly if it moves
    ok("one reading runs end to end", False, repr(error))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
