"""A standard extracted as one clause must not pass for a healthy one.

The assessment screen read "2 designs against 1 clauses from Standards v3".
Nothing in the pipeline was raising anything: the parser had produced a single
clause from a whole standard, that document reached `ready`, joined the
framework, and every assessment then measured two designs against one rule.

The extractor was not the fault, and this file pins that down first — the real
sample standards still yield 12 to 14 clauses each, which is what they held
before and after. The fault was that there was no test for "far too few": the
only clause-count guard fired at exactly zero, so one clause out of a hundred
rules looked identical to a correct parse from the outside.

So the guard now also checks the ratio of sections to clauses, and this holds
both ends of it:

  - the three real standards, where the parser is right, raise nothing
  - a standard whose rules were lumped into one clause is reported
  - a genuinely short policy is not reported, because a one-rule standard is a
    real thing and crying wolf over it would train reviewers to ignore the
    notice

    docker run --rm -v "$PWD":/repo -w /repo/Workers -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_standard_clause_yield.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp.parsing import clauses as clause_parser  # noqa: E402
from aidp.parsing import sections as section_parser  # noqa: E402
from aidp.parsing import spans  # noqa: E402
from aidp.stages import parse as parse_stage  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


SAMPLES = pathlib.Path(__file__).resolve().parents[2] / "samples" / "standards"


class _Out:
    """Just enough of `_Result` for the guard: sections, clauses and issues."""

    def __init__(self, sections: int, clauses: int):
        self.sections = list(range(sections))
        self.clauses = {0: list(range(clauses))} if clauses else {}
        self.issues: list[dict] = []

    def issue(self, severity: str, kind: str, detail: str, *, page=None, ref=None) -> None:
        self.issues.append({"severity": severity, "kind": kind, "detail": detail})

    def kinds(self) -> set[str]:
        return {i["kind"] for i in self.issues}


REFERENCE = {"role": "reference"}
DESIGN = {"role": "assessed"}


# ---------------------------------------------------------------------------
print("\n1. The extractor itself still finds the rules")

try:
    import fitz
except ImportError:  # pragma: no cover
    print("  .... skipped — pymupdf not installed")
    fitz = None

counts: dict[str, tuple[int, int]] = {}
if fitz is not None:
    for pdf in sorted(SAMPLES.glob("*.pdf")):
        doc = fitz.open(pdf)
        lines = spans.extract_lines(doc)
        profile = spans.profile_fonts(lines)
        secs = section_parser.build(lines, profile, document_title=pdf.stem)
        found = 0
        for section in secs:
            got = clause_parser.from_prose(section) or clause_parser.from_normative_prose(section)
            found += len(got)
        counts[pdf.name] = (len(secs), found)
        doc.close()

    for name, (sections, found) in sorted(counts.items()):
        # Not an exact number: the extractor is allowed to improve. What must
        # hold is that a whole standard yields many rules and not one.
        ok(f"{name}: yields many clauses, not one ({found} from {sections} sections)", found >= 8)

    ok("every sample standard was read", len(counts) == 3, sorted(counts))


# ---------------------------------------------------------------------------
print("\n2. A thin extraction is reported")

# The failure as it reached the customer: a standard of many sections whose
# rules all landed in one clause.
one = _Out(sections=96, clauses=1)
parse_stage._flag_no_clauses(one, REFERENCE)
ok("one clause out of 96 sections is reported", "few_clauses" in one.kinds(), one.issues)
ok("and not as a parse failure, which it is not", "no_clauses" not in one.kinds())
ok(
    "the notice says what to check rather than only that something is wrong",
    any("clause list" in i["detail"] for i in one.issues),
    one.issues,
)
ok(
    "it is low severity: the document still assesses",
    all(i["severity"] == "low" for i in one.issues),
    one.issues,
)

none = _Out(sections=40, clauses=0)
parse_stage._flag_no_clauses(none, REFERENCE)
ok("no clauses at all is still the high-severity notice", none.kinds() == {"no_clauses"}, none.issues)


# ---------------------------------------------------------------------------
print("\n3. A correct parse is left alone")

# The real measured ratios, which must not trip the guard.
for name, (sections, found) in sorted(counts.items()) or []:
    out = _Out(sections=sections, clauses=found)
    parse_stage._flag_no_clauses(out, REFERENCE)
    ok(f"{name}: raises nothing", out.issues == [], out.issues)

# A short policy really can hold one rule.
short = _Out(sections=4, clauses=1)
parse_stage._flag_no_clauses(short, REFERENCE)
ok("a one-page policy with one rule is not reported", short.issues == [], short.issues)

# Right at the threshold, so the boundary is the documented one rather than
# whatever the comparison happens to do.
ok(
    "a clause every eight sections is accepted",
    (lambda o: (parse_stage._flag_no_clauses(o, REFERENCE), o.issues == [])[1])(
        _Out(sections=80, clauses=10)
    ),
)
ok(
    "a clause every nine is reported",
    (lambda o: (parse_stage._flag_no_clauses(o, REFERENCE), "few_clauses" in o.kinds())[1])(
        _Out(sections=90, clauses=10)
    ),
)


# ---------------------------------------------------------------------------
print("\n4. None of this applies to a submitted design")

design = _Out(sections=96, clauses=1)
parse_stage._flag_no_clauses(design, DESIGN)
ok("a design with one clause raises nothing", design.issues == [], design.issues)
design_none = _Out(sections=96, clauses=0)
parse_stage._flag_no_clauses(design_none, DESIGN)
ok("nor one with none — a design is not measured by its clauses", design_none.issues == [])


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
