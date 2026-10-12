"""Real page numbers for a Word document, from a rendering of it.

A .docx stores no pagination. Word computes it when it lays the document out,
so the file itself can only be asked where the author pressed Ctrl+Enter — two
explicit breaks in a nineteen-page blueprint, which is why `docs.read` reports
three pages and says so in its own note. Citations then point at a page that
does not exist, and a reviewer sent to "page 2" for something printed on page
seven stops trusting the report.

So LibreOffice lays the document out — it is in this image already, for the deck
path and for the drawings in vectors.py — and the pages are read off that.

What this deliberately does **not** do is parse the rendering. Measured on the
blueprint that prompted it, reading the converted PDF instead of the .docx costs
four tables and nineteen table rows, and raises `structure_uncertain`,
`table_low_confidence` and `section_missing`. A table is assessable content —
the assumptions, the RTO and RPO, the technology stack — and a page number is
how a reviewer finds it. Trading the first for the second is a bad trade, so
the Word parse stays exactly as it is and only the page numbers come from here.

The match is sequential, which is what makes it safe: the rendering holds the
same lines in the same order as the document they came from, so each line is
looked for from the page the last one was found on. A line that cannot be found
keeps the page of the line before it, and a document that will not convert keeps
the floor it had. Nothing here can fail a parse.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import tempfile

import fitz

from .vectors import TIMEOUT_SECONDS, binary

# The search runs forward from the page the last line was found on, to the end
# of the document. Not a window: most of a blueprint's content is in its tables,
# which are not lines at all, so two consecutive paragraphs can be pages apart —
# and a window narrow enough to be safe left a third of the document piled onto
# whichever page the cursor had stalled on. Forward-only is what keeps it
# honest; the two readings hold the same lines in the same order.

# Shorter than this and a line is "N/A", "TBD" or a number — it appears on half
# the pages and would drag the cursor wherever it first saw it.
_MIN_MATCH = 12

# Word generates heading numbers when it lays the document out, so "3.1.6" is
# in the rendering and nowhere in the file. Captured while matching, because
# a finding that cites "§3.1.6" is one a reviewer can look up and "Non-functional
# Qualities of the Solution" is one they have to search for.
_NUMBER = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+(.{3,})$")

# A line of the table of contents: a number, the heading, and the page it is on,
# separated by the tab stops Word writes. These are the one thing in the file
# that must not be matched — each one reads exactly like the heading it points
# at, so matching them walks the cursor through the whole document before the
# first page of real content has been placed, and everything after lands on the
# last page. Recognised rather than located, because `docs.read` does not mark
# a contents page and the heading path is what the parse actually cites.
_CONTENTS_ENTRY = re.compile(r"^\s*\d+(?:\.\d+)*\s*\t.*\t\s*\d+\s*$")


def _flatten(text: str) -> str:
    """Comparable text: no case, no runs of space, no soft punctuation.

    The two readings disagree about whitespace and about which dash or quote
    character they saw, and never about the words.
    """
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def render(raw: bytes) -> bytes | None:
    """A PDF of a .docx, or None if it could not be made."""
    command = binary()
    if command is None:
        return None
    with tempfile.TemporaryDirectory(prefix="aidp-paginate-") as work:
        folder = pathlib.Path(work)
        source = folder / "source.docx"
        source.write_bytes(raw)
        try:
            result = subprocess.run(
                [
                    command,
                    f"-env:UserInstallation=file://{folder / 'profile'}",
                    "--headless",
                    "--norestore",
                    "--nologo",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(folder),
                    str(source),
                ],
                capture_output=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None
        pdf = folder / "source.pdf"
        if result.returncode != 0 or not pdf.exists():
            return None
        return pdf.read_bytes()


def _pages(pdf: bytes) -> list[list[tuple[str, str]]]:
    """Each page's lines as (text, heading number), flattened for comparison.

    The number is stripped off and kept, because Word generates heading numbers
    when it lays the document out: the rendering says "3.2 Application and Data
    Architecture" where the file holds "Application and Data Architecture", and
    nothing matched until the two were compared without it. The number that
    comes off is worth having for its own sake — a finding that cites "§3.2" is
    one a reviewer can look up, and "Application and Data Architecture" is one
    they have to search for.
    """
    out: list[list[tuple[str, str]]] = []
    with fitz.open(stream=pdf, filetype="pdf") as document:
        for page in document:
            lines: list[tuple[str, str]] = []
            for line in page.get_text().splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                number = ""
                match = _NUMBER.match(stripped)
                if match:
                    number, stripped = match.group(1), match.group(2)
                flat = _flatten(stripped)
                if flat:
                    lines.append((flat, number))
            out.append(lines)
    return out


class Mapping:
    """Where each line of a Word document actually prints."""

    def __init__(self, pages: list[int], numbers: dict[int, str], page_count: int) -> None:
        #: Page number per line index, 1-based.
        self.pages = pages
        #: Heading number by line index, for the lines the rendering numbered.
        self.numbers = numbers
        self.page_count = page_count


def map_lines(
    pdf: bytes, texts: list[str], headings: set[int] | None = None
) -> Mapping | None:
    """Match a Word document's lines, in order, to the pages they print on.

    `headings` is the indices `docs.read` recorded a depth for. Only those get a
    number: Word numbers its lists as well as its headings, and without this the
    three bullets under "It is the responsibility of the Document Author" come
    back as sections 1, 2 and 3.
    """
    try:
        flat_pages = _pages(pdf)
    except Exception:  # noqa: BLE001 — a rendering we cannot read is one we ignore
        return None
    if not flat_pages:
        return None

    pages: list[int] = []
    numbers: dict[int, str] = {}
    cursor = 0

    for index, text in enumerate(texts):
        wanted = _flatten(text)
        found = None
        # A heading is matched on exact equality, so it needs no length floor:
        # "Roles", "Network" and "Appendices" are all shorter than the floor and
        # all real sections, and leaving them unmatched is what left a third of
        # this document's sections unnumbered. Equality is what makes it safe —
        # a short *prefix* match is the thing that drags the cursor.
        is_heading = headings is not None and index in headings
        long_enough = len(wanted) >= _MIN_MATCH or (is_heading and wanted)
        if long_enough and not _CONTENTS_ENTRY.match(text):
            for page in range(cursor, len(flat_pages)):
                for line, number in flat_pages[page]:
                    if is_heading and line == wanted:
                        found = (page, number, line)
                        break
                    # `startswith` both ways, because the rendering wraps a long
                    # paragraph across several lines while the document holds it
                    # as one — but both sides have to be long enough to mean
                    # something. Without that floor a table cell reading
                    # "Solution" matched the heading "Solution Architecture"
                    # pages away and dragged the cursor, and every line after it
                    # piled onto that page.
                    if len(line) < _MIN_MATCH or len(wanted) < _MIN_MATCH:
                        continue
                    if line.startswith(wanted) or wanted.startswith(line):
                        found = (page, number, line)
                        break
                if found:
                    break
        if found:
            cursor = found[0]
            # The number is only taken when the rendering's line is this line and
            # not merely something starting like it. A page is a hint and a
            # near-miss costs little; a number is a citation, and "§2" against a
            # section that is really §1.1 sends a reviewer to the wrong rule —
            # worse than leaving it unnumbered, which is where this started.
            if (
                found[1]
                and found[2] == wanted
                and (headings is None or index in headings)
            ):
                numbers[index] = found[1]
        pages.append(cursor + 1)

    return Mapping(pages, numbers, len(flat_pages))
