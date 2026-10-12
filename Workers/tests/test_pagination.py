"""Real page numbers for a Word document, matched against a rendering of it.

A .docx stores no pagination, so `docs.read` counts explicit page breaks and
reports a floor — three pages for the nineteen-page blueprint that prompted
this. Citations then point at pages that do not exist. `pagination.map_lines`
walks the document's lines against a rendering of it and reads the real pages
off, and recovers the heading numbers Word generates at layout time and never
stores.

Every check here is a trap the real document actually sprang, and each one
fails silently rather than loudly:

  * a table of contents lists every heading, so matching its entries walks the
    cursor through the whole document before the first line of real content is
    placed — and everything after lands on the last page;
  * a rendered heading carries a number the file does not ("3.2 Application and
    Data Architecture" against "Application and Data Architecture"), so without
    stripping it no heading matches anything;
  * a short line matches far too much: a table cell reading "Solution" pulled
    the cursor to the heading "Solution Architecture" pages away;
  * a number taken from a near-miss is a citation to the wrong rule, which is
    worse than no citation at all.

Needs only PyMuPDF — the fixture is built here rather than rendered, so this
runs in the test image:

    docker run --rm -v "$PWD":/w -w /w --entrypoint python \\
      aidp-worker-test tests/test_pagination.py
"""

from __future__ import annotations

import pathlib
import sys

import fitz

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp.parsing import pagination  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


def pdf_of(pages: list[list[str]]) -> bytes:
    """A PDF with these lines on these pages, as a rendering would hold them."""
    document = fitz.open()
    for lines in pages:
        page = document.new_page()
        y = 72.0
        for line in lines:
            page.insert_text((72, y), line, fontsize=11)
            y += 18
    return document.tobytes()


# A rendering of a small document: cover, contents, then four pages of content
# whose headings carry the numbers Word generates.
RENDERED = pdf_of(
    [
        ["Wellness Station", "(Pharmacy)"],
        ["TABLE OF CONTENTS", "1", "DOCUMENT.........3", "2", "Solution Architecture.........4"],
        ["1 DOCUMENT", "This document represents the completion of the proposal."],
        ["2 Solution Architecture", "The solution is described below in detail."],
        ["2.1 Application and Data Architecture", "Solution", "It stores readings."],
        ["3 Appendices", "Nothing of substance appears in this appendix."],
    ]
)

# The same document as the .docx holds it: no generated numbers on the headings,
# and the contents entries carry Word's tab stops.
LINES = [
    "Wellness Station",
    # The heading above the entries, which is an ordinary line and does match —
    # it is what puts the cursor on the contents page so the entries below it,
    # which are skipped, inherit the right page.
    "TABLE OF CONTENTS",
    "1\tDOCUMENT\t3",
    "2\tSolution Architecture\t4",
    "DOCUMENT",
    "This document represents the completion of the proposal.",
    "Solution Architecture",
    "The solution is described below in detail.",
    "Application and Data Architecture",
    "It stores readings.",
    "Appendices",
]
HEADINGS = {4, 6, 8, 10}


# ---------------------------------------------------------------------------
print("\n1. Comparing two readings of the same words")

ok("case and punctuation are ignored", pagination._flatten("§3.2 — Data!") == "3 2 data")
ok("runs of space collapse", pagination._flatten("a   b\tc") == "a b c")
ok("nothing but punctuation is nothing", pagination._flatten("—  ·") == "")

ok(
    "a contents entry is recognised by its tab stops",
    pagination._CONTENTS_ENTRY.match("3.6.2\tAssumptions\t16") is not None,
)
ok(
    "and a heading of the same name is not",
    pagination._CONTENTS_ENTRY.match("Assumptions") is None,
)
ok(
    "nor is a sentence that ends in a number",
    pagination._CONTENTS_ENTRY.match("Retries are bounded to 3") is None,
)


# ---------------------------------------------------------------------------
print("\n2. Placing the lines")

mapping = pagination.map_lines(RENDERED, LINES, HEADINGS)
ok("the document is as long as the rendering", mapping is not None and mapping.page_count == 6)

pages = mapping.pages
ok("the cover line is on the cover", pages[0] == 1, pages)

# The trap: a contents entry reads exactly like the heading it points at, and
# matching it would move the cursor to that heading's page.
ok("contents entries stay on the contents page", pages[2] == 2 and pages[3] == 2, pages[1:4])

ok("the first real heading is on its own page", pages[4] == 3, pages[4])
ok("and the prose under it with it", pages[5] == 3, pages[5])
ok("a heading the rendering numbered still matches", pages[6] == 4, pages[6])
ok("as does the one after it", pages[8] == 5, pages[8])
ok("and the last heading", pages[10] == 6, pages[10])

# "Solution" sits on page 5 as a table cell would. Matching it from page 4
# against "Solution Architecture" is what sent a third of the real document to
# page 17 in the blueprint.
ok("a short line does not pull the cursor forward", pages[7] == 4, pages[7])

ok("pages never go backwards", all(b >= a for a, b in zip(pages, pages[1:])), pages)


# ---------------------------------------------------------------------------
print("\n3. Recovering the numbers Word generates")

ok("a heading gets the number the rendering printed", mapping.numbers.get(6) == "2", mapping.numbers)
ok("including a nested one", mapping.numbers.get(8) == "2.1", mapping.numbers)
ok("and the last", mapping.numbers.get(10) == "3", mapping.numbers)
ok("prose is not numbered", 5 not in mapping.numbers and 7 not in mapping.numbers)

# Without the set of headings, a numbered list item would be read as a section.
listed = pagination.map_lines(
    pdf_of([["1 All of the sections are completed in the template"]]),
    ["All of the sections are completed in the template"],
    set(),
)
ok("a numbered list item is not a heading", listed.numbers == {}, listed.numbers)

# A near-miss is where a wrong citation comes from: the rendering's line starts
# like this heading but is not it.
near = pagination.map_lines(
    pdf_of([["1.1 Information and Revision History and Approvals"]]),
    ["Information and Revision History"],
    {0},
)
ok("a number is refused on a near-miss", near.numbers == {}, near.numbers)


# ---------------------------------------------------------------------------
print("\n4. When there is nothing to match against")

ok("a rendering that is not a PDF is no mapping", pagination.map_lines(b"not a pdf", ["x"]) is None)
ok("an empty rendering is no mapping", pagination.map_lines(b"", ["x"]) is None)

lost = pagination.map_lines(RENDERED, ["a line that appears nowhere in the rendering"], set())
ok("a line found nowhere keeps the page before it", lost.pages == [1], lost.pages)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
