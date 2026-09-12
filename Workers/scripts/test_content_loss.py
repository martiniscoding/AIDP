"""The content-loss tripwire: does it fire, and does it stay quiet?

Three separate defects lost deck content before this existed — slide text
dropped for carrying a diagram, everything before the model's first heading
discarded, chart data never read at all. Every one was found by a person
noticing that a specific slide was missing from a report, which is the most
expensive way to find out and the most embarrassing.

A tripwire that never fires is worse than none, because it gets trusted. So
this asserts both directions: silence when the document is fully indexed, and
an issue naming the missing text when it is not.

    python3 Workers/scripts/test_content_loss.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp.parsing.clauses import Clause  # noqa: E402
from aidp.parsing.sections import Section  # noqa: E402
from aidp.parsing.spans import Line  # noqa: E402
from aidp.stages import parse  # noqa: E402

passed = 0
failed = 0

# Long enough that losing one of these is a tenth of the document.
BULK = "a substantial paragraph of slide content that runs on for a while " * 3


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


def line(text: str) -> Line:
    return Line(
        text=text, page=1, y=0.0, x0=0.0, bbox=(0, 0, 0, 0),
        sig=("x", 11.0, False, False, 0),
    )


def section(title: str, texts: list[str]) -> Section:
    built = Section(
        ordinal=1, number_text=None, title=title, depth=1,
        heading_path=title, page_start=1, page_end=1,
    )
    built.lines = [line(text) for text in texts]
    return built


def issues_of(out: parse._Result) -> list[dict]:
    return [issue for issue in out.issues if issue["kind"] == "content_not_indexed"]


print("\n1. Quiet when everything reached a section")
out = parse._Result()
out.sections = [section("Slide one", ["kept one", "kept two"])]
parse._flag_content_loss(out, [line("Slide one"), line("kept one"), line("kept two")])
ok("no issue raised", not issues_of(out), out.issues)

print("\n2. Fires when a whole slide is missing")
out = parse._Result()
out.sections = [section("Slide one", ["kept one"])]
parse._flag_content_loss(
    out, [line("Slide one"), line("kept one"), line(BULK), line("also lost " * 6)]
)
hits = issues_of(out)
ok("issue raised", len(hits) == 1, out.issues)
if hits:
    ok("severity is high for a large loss", hits[0]["severity"] == "high", hits[0]["severity"])
    ok("it says how much", "%" in hits[0]["detail"], hits[0]["detail"][:80])
    ok("it names what was lost", "substantial paragraph" in hits[0]["detail"])

print("\n3. Low severity when only a fragment falls out")
out = parse._Result()
out.sections = [section("Slide one", [BULK, BULK, BULK])]
parse._flag_content_loss(
    out, [line("Slide one"), line(BULK), line(BULK), line(BULK), line("tiny")]
)
hits = issues_of(out)
ok("issue raised", len(hits) == 1)
if hits:
    ok("severity is low", hits[0]["severity"] == "low", hits[0]["severity"])

print("\n4. Clause text counts as kept, because it is reflowed rather than copied")
out = parse._Result()
out.sections = [section("Slide one", [])]
out.clauses = {
    0: [
        Clause(
            ordinal=1, title="t", statement="the rule text", rationale="",
            requirements=["req one"], guidance=[],
        )
    ]
}
parse._flag_content_loss(
    out, [line("Slide one"), line("the rule text"), line("req one")]
)
ok("no issue raised", not issues_of(out), out.issues)

print("\n5. A numbered heading is reached, though its section keeps only the title")
# A section stores "1.1 Purpose" as number "1.1" and title "Purpose". Matching
# the line against the title alone reported every numbered heading in a PDF as
# lost — 71 false losses on one 96-page blueprint.
out = parse._Result()
numbered = section("Purpose", ["the purpose text"])
numbered.number_text = "1.1"
appendix = section("Glossary", ["a term"])
appendix.number_text = "Appendix A"
out.sections = [numbered, appendix]
parse._flag_content_loss(
    out,
    [line("1.1 Purpose"), line("the purpose text"), line("Appendix A: Glossary"), line("a term")],
)
ok("no issue raised", not issues_of(out), out.issues)

print("\n6. ...but numbering does not excuse text that is genuinely missing")
out = parse._Result()
out.sections = [section("Purpose", [])]
parse._flag_content_loss(out, [line("1.1 Purpose"), line("2.4 " + BULK)])
ok("issue still raised", len(issues_of(out)) == 1, out.issues)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
