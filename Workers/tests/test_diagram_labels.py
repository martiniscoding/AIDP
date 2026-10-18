"""A diagram's box labels must not each open a section.

Three two-page design documents were assessed as one project. Each draws its
"3 Architecture sketch" as a row of filled boxes with a bold label inside — "HR
System", "Nightly ETL Job", "BI Dashboard". Every label is short, capitalised,
unpunctuated and set bold, which is what `sections._TITLE_LIKE` accepts, and
each one sits under a numbered heading, so each opened a subsection of its own:
seven of them on one page, holding an arrow apiece, while "3 Architecture
sketch" itself came out with no content at all.

Coverage then read those stubs as parts of the design, and three of them reached
the customer's report as "no standard governs this", quoting a heading and an
arrow as the design's own words. Nothing but position separates a label from a
heading, which is the same conclusion tables reached in `not_headings`.

Two things have to hold at once, and the second is why the suppression is drawn
from the boxes rather than from the figure's outline:

  - a label inside a drawn box is not a heading
  - a real heading in open space is still a heading, even when a loose vector
    cluster has grown over it

Checked on pages built here, so the geometry is explicit and the test needs no
document on the machine.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_diagram_labels.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


try:
    import fitz
except ImportError:  # pragma: no cover
    print("  .... skipped — pymupdf not installed")
    sys.exit(0)

from aidp.parsing import figures, sections, spans  # noqa: E402

BOLD = "Helvetica-Bold"
BODY = "Helvetica"


def line(
    text: str, page: int, bbox: tuple[float, float, float, float], *, bold: bool
) -> spans.Line:
    """One extracted line, placed and weighted by hand."""
    return spans.Line(
        text=text,
        page=page,
        y=bbox[1],
        x0=bbox[0],
        bbox=bbox,
        sig=(BOLD if bold else BODY, 8.0, bold),
        has_bold=bold,
    )


# Bold at body size is a heading level, which is the condition that makes a
# diagram label a heading candidate in the first place. See sections.py.
PROFILE = spans.FontProfile(body=(BODY, 8.0, False), levels=[(BOLD, 8.0, True)])


# ---------------------------------------------------------------------------
print("\n1. The boxes a diagram is drawn from")

# A sketch drawn the way the three designs draw theirs: four filled boxes in a
# row, a label inside each. Then a real subsection heading in open space below,
# and a table of rules under that — the shape whose vector cluster grows over
# the whole page.
doc = fitz.open()
page = doc.new_page()  # 612 x 792
for x0, x1 in ((80, 165), (185, 280), (300, 405), (425, 510)):
    page.draw_rect(fitz.Rect(x0, 300, x1, 345), color=(0.2, 0.3, 0.6), fill=(0.9, 0.93, 0.98))
page.insert_text((90, 325), "HR System", fontsize=8, fontname="hebo")
page.insert_text((195, 325), "Nightly ETL Job", fontsize=8, fontname="hebo")
page.insert_text((310, 325), "Analytics Warehouse", fontsize=8, fontname="hebo")
page.insert_text((435, 325), "BI Dashboard", fontsize=8, fontname="hebo")
page.insert_text((72, 420), "Leg-by-leg classification", fontsize=8, fontname="hebo")
for top in range(450, 650, 20):
    page.draw_rect(fitz.Rect(72, top, 540, top + 20), fill=(0.97, 0.97, 0.97))

boxes = figures.label_regions_page(page)
print(f"     {len(boxes)} label boxes on the page")


def covered(x: float, y: float) -> bool:
    return any(left <= x <= right and top <= y <= bottom for left, top, right, bottom in boxes)


ok("a label inside a box is covered", covered(120, 322))
ok("so is the last box's label", covered(465, 322))
ok("a heading in open space between the drawings is not", not covered(120, 417))
ok("and neither is the page above the sketch", not covered(300, 120))

# The outline itself is the whole page, which is exactly why it is not used.
outline = [rect for _, rect in figures.regions_page(page)]
ok("the figure outline, by contrast, reaches past that heading", any(r.y1 > 420 for r in outline))
doc.close()


# ---------------------------------------------------------------------------
print("\n2. What the section tree does with them")

# One page's lines, in reading order: a numbered heading, four box labels, a
# real unnumbered subheading, and the next numbered heading.
lines = [
    line("3. Architecture sketch", 1, (72.0, 270.0, 240.0, 284.0), bold=True),
    line("HR System", 1, (90.0, 315.0, 140.0, 325.0), bold=True),
    line("→", 1, (170.0, 315.0, 178.0, 325.0), bold=False),
    line("Nightly ETL Job", 1, (195.0, 315.0, 258.0, 325.0), bold=True),
    line("→", 1, (288.0, 315.0, 296.0, 325.0), bold=False),
    line("Analytics Warehouse", 1, (310.0, 315.0, 390.0, 325.0), bold=True),
    line("→", 1, (412.0, 315.0, 420.0, 325.0), bold=False),
    line("BI Dashboard", 1, (435.0, 315.0, 495.0, 325.0), bold=True),
    line("Arrows show the conceptual flow.", 1, (72.0, 360.0, 300.0, 370.0), bold=False),
    line("Leg-by-leg classification", 1, (72.0, 410.0, 200.0, 420.0), bold=True),
    line("Each leg is classified below.", 1, (72.0, 435.0, 300.0, 445.0), bold=False),
    line("4. Application decisions", 1, (72.0, 680.0, 240.0, 694.0), bold=True),
]

# The boxes, and the loose cluster that grew over the lot of them.
label_boxes = {1: [(80.0, 300.0, 165.0, 345.0), (185.0, 300.0, 280.0, 345.0),
                   (300.0, 300.0, 405.0, 345.0), (425.0, 300.0, 510.0, 345.0)]}
whole_page = {1: [(72.0, 290.0, 540.0, 700.0)]}

loose = sections.build(lines, PROFILE, document_title="D", not_titles=whole_page)
tight = sections.build(lines, PROFILE, document_title="D", not_titles=label_boxes)
unfixed = sections.build(lines, PROFILE, document_title="D")

titles = lambda built: [s.title for s in built]  # noqa: E731
ok("without the fix every box opened a section", "HR System" in titles(unfixed), titles(unfixed))
ok("  which left the sketch empty", unfixed[0].text == "", repr(unfixed[0].text))

ok("the box labels open no section", "HR System" not in titles(tight), titles(tight))
ok("nor do the rest of them", len(tight) == 3, titles(tight))
ok("the sketch keeps its own heading", tight[0].title == "Architecture sketch", titles(tight))
ok("and now holds the labels as content", "HR System" in tight[0].text, repr(tight[0].text))
ok("the real subsection survives", "Leg-by-leg classification" in titles(tight), titles(tight))
ok("so does the heading after it", "Application decisions" in titles(tight), titles(tight))

# Numbered headings are refused by a table region but not by a figure one. On
# the designs this was built against nothing numbered falls inside a drawn
# shape, so this is a guard rather than a need — kept because a box label
# promoted to a heading invents a section while a heading demoted to a label
# loses a real one, and a number is the one landmark a box label never carries.
ok(
    "a numbered heading survives a region that swallowed it",
    [s.title for s in loose if s.number_text] == ["Architecture sketch", "Application decisions"],
    titles(loose),
)
ok(
    "an unnumbered one in that same region does not",
    "Leg-by-leg classification" not in titles(loose),
    titles(loose),
)
everything = {1: [(0.0, 0.0, 612.0, 792.0)]}
ok(
    "a table region refuses the numbered ones too",
    sections.build(lines, PROFILE, document_title="D", not_headings=everything) == [],
)
ok(
    "where a figure region over the same page does not",
    len(sections.build(lines, PROFILE, document_title="D", not_titles=everything)) == 2,
)

# Nothing is dropped from the document, only from the heading list: a line is
# either a section's own heading or one of its content lines, both ways round.
ok(
    "every line is still accounted for",
    sum(len(s.lines) for s in tight) + len(tight) == len(lines),
    (sum(len(s.lines) for s in tight), len(tight), len(lines)),
)
ok(
    "as it was before the fix",
    sum(len(s.lines) for s in unfixed) + len(unfixed) == len(lines),
)


# ---------------------------------------------------------------------------
print("\n3. A page with no drawings at all")

plain = fitz.open()
bare = plain.new_page()
bare.insert_text((72, 100), "1. Scope", fontsize=14)
bare.insert_text((72, 140), "This standard applies to every integration.", fontsize=11)
ok("no boxes, so nothing is suppressed", figures.label_regions_page(bare) == [])
ok("and the document's regions are empty", figures.label_regions(plain) == {})
plain.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
