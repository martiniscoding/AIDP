"""The section tree.

A line becomes a heading when typography *and* shape agree: its font signature
is one of the document's heading levels, and it either carries a section number
or reads like a title. Requiring both stops body lines that happen to open with
a figure from being promoted, and stops a bold run mid-paragraph from splitting
a clause in half.

Section numbers are captured but never used as identity. One sample document
contains two sections both numbered `9.1.1` — Word auto-numbering drift, present
in the corpus before we wrote a line of code. Identity is
`(document_id, ordinal)`; `number_text` is for display and citation only.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .spans import FontProfile, Line

_NUMBERED = re.compile(r"^(?P<number>\d+(?:\.\d+)*)\.?\s+(?P<title>\S.*)$")
_APPENDIX = re.compile(r"^(?P<number>Appendix\s+[A-Z])\s*[:.]?\s*(?P<title>.*)$", re.IGNORECASE)

# A title-cased line, short, no terminal punctuation, and no colon.
#
# The colon matters. Subsection headings in this corpus are bold at roughly body
# size, so `profile_fonts` has to treat bold-at-body-size as a heading level —
# which means a fully bold body line is a heading candidate too. Real headings
# do not carry a "Label: sentence" shape; clause parts and definition lines do.
_TITLE_LIKE = re.compile(r"^[A-Z][^.!?:]{2,78}$")

# Lines naming a clause part are content, always. Belt and braces alongside the
# colon rule above: some exports set the entire statement line in bold, not just
# its label, and losing a clause to a false heading is silent — the section
# still parses, it just comes out empty.
_CLAUSE_LABEL = re.compile(
    r"^\s*(statement|rationale|requirements?|implications?|"
    r"applicable\s+patterns?|note)\b\s*:",
    re.IGNORECASE,
)

# A deep subsection number — three parts or more — then the start of a title.
_DEEP_NUMBERED = re.compile(r"^\d+(?:\.\d+){2,}\.?\s+[A-Z(]")

# How far under body size a bold, deeply numbered line may be set and still be a
# heading. See `_small_numbered_heading`.
_SMALL_HEADING_SLACK = 1.5

# Enough numbered headings to say how this document sets its headings.
_MIN_NUMBERED = 5

# Structural sections that carry no standards and should not become chunks.
_SKIP_TITLES = {"table of contents", "contents", "revision history", "document control"}


@dataclass
class Section:
    ordinal: int
    number_text: str | None
    title: str
    depth: int
    heading_path: str
    page_start: int
    page_end: int
    lines: list[Line] = field(default_factory=list)
    #: Where the heading sits on `page_start`. Several sections can open on one
    #: page, and a table or figure on that page belongs to whichever heading is
    #: above it — not simply to the last one on the page. 0.0 when the section
    #: was not cut from positioned lines, which reads as "top of the page".
    y_start: float = 0.0

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines).strip()

    @property
    def is_structural(self) -> bool:
        return self.title.strip().lower() in _SKIP_TITLES


def _small_numbered_heading(line: Line, text: str, profile: FontProfile) -> bool:
    """A bold, deeply numbered line set just under body size.

    Word templates step their deepest heading styles down a point. One live
    blueprint sets "3.4.3.1.1 Virtual Servers" in 11pt bold italic over 12pt
    body, and five of its subsections vanished into their neighbours — two of
    them then reported as missing from the table of contents. `profile_fonts`
    cannot list 11pt bold as a level without also listing every bold word at
    that size, so these are admitted on the strength of the number instead: a
    three-part section number is not something body text opens with.
    """
    sig = line.sig
    return (
        bool(sig[2])
        and not profile.body[2]
        and sig[1] >= profile.body[1] - _SMALL_HEADING_SLACK
        and bool(_DEEP_NUMBERED.match(text))
    )


def _classify(line: Line, profile: FontProfile) -> tuple[str | None, str] | None:
    """(number, title) when the line is a heading, else None."""
    text = line.text.strip()
    if profile.level_of(line.sig) is None and not _small_numbered_heading(line, text, profile):
        return None

    if not text or len(text) > 160:
        return None
    if _CLAUSE_LABEL.match(text):
        return None

    if m := _NUMBERED.match(text):
        return m.group("number"), m.group("title").strip()
    if m := _APPENDIX.match(text):
        title = (m.group("title") or "").strip()
        return m.group("number").title(), title or m.group("number").title()
    if _TITLE_LIKE.match(text):
        return None, text
    return None


def _in_region(line: Line, regions: dict[int, list] | None) -> bool:
    """Whether a line's centre falls inside any region on its page."""
    if not regions:
        return False
    x0, y0, x1, y1 = line.bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return any(
        left <= cx <= right and top <= cy <= bottom
        for left, top, right, bottom in regions.get(line.page, [])
    )


def build(
    lines: list[Line],
    profile: FontProfile,
    *,
    document_title: str,
    skip_pages: set[int] | None = None,
    not_headings: dict[int, list] | None = None,
) -> list[Section]:
    """Walk lines in reading order and cut them into sections.

    `skip_pages` drops the contents pages: they look like dense content and are
    entirely redundant, having already been consumed as ground truth by toc.py.

    `not_headings` is regions, by page, where no line may open a section — the
    tables. A column header is set bold at body size, which is exactly the
    signature `profile_fonts` has to accept as a heading level for real
    subsection titles, and it is short, capitalised and unpunctuated, which is
    exactly what `_TITLE_LIKE` accepts. Typography and shape both agree, and
    both are wrong. Only position can tell the difference. On a 96-page
    architecture blueprint — a template that is mostly tables — 259 of 444
    heading candidates were header cells, including fragments a narrow column
    had hyphenated ("Estima", "Transactio"), and each opened an empty section.

    A line in a region is not dropped. It stays in whichever section it falls
    under, as content, exactly as before.
    """
    skip_pages = skip_pages or set()

    # Decided before the walk, because it needs the whole document: does this
    # document set its numbered headings in bold? If every one of them is, an
    # unnumbered "heading" that is not bold is something else set large — on
    # one blueprint, the labels of embedded spreadsheets, at 18pt regular, each
    # of which opened a section and pulled the server inventory under it.
    candidates = [
        None
        if line.page in skip_pages or _in_region(line, not_headings)
        else _classify(line, profile)
        for line in lines
    ]
    numbered = [
        lines[i]
        for i, found in enumerate(candidates)
        if found and found[0] and found[0][0].isdigit()
    ]
    bold_document = len(numbered) >= _MIN_NUMBERED and sum(
        1 for line in numbered if line.sig[2]
    ) >= 0.9 * len(numbered)

    sections: list[Section] = []
    stack: list[tuple[int, str]] = []  # (depth, title) for the heading path
    current: Section | None = None
    ordinal = 0
    # Depth of the most recent numbered heading, or None before the first one.
    anchor: int | None = None

    for index, line in enumerate(lines):
        if line.page in skip_pages:
            continue

        heading = candidates[index]
        if heading is not None and heading[0] is None and bold_document and not line.sig[2]:
            heading = None
        if heading is None:
            if current is not None:
                current.lines.append(line)
                current.page_end = max(current.page_end, line.page)
            continue

        number, title = heading
        if number and number[0].isdigit():
            depth = number.count(".") + 1
            anchor = depth
        elif number:
            # An appendix is top-level by definition, and anchors whatever
            # unnumbered headings follow it.
            depth = anchor = 1
        else:
            # An unnumbered heading in a numbered document is a sub-heading of
            # the numbered one above it. Treating it as top-level used to pop
            # every numbered ancestor off the stack: a blueprint's "Deployment"
            # under "4 SOLUTION DELIVERY APPROACH" left the next section's path
            # reading "Deployment › 4.2 Approach to Migration", with its real
            # parent gone from every citation until the next chapter number.
            depth = anchor + 1 if anchor else 1

        while stack and stack[-1][0] >= depth:
            stack.pop()
        stack.append((depth, f"{number} {title}".strip() if number else title))
        path = " › ".join([document_title, *(t for _, t in stack)])

        ordinal += 1
        current = Section(
            ordinal=ordinal,
            number_text=number,
            title=title,
            depth=depth,
            heading_path=path,
            page_start=line.page,
            page_end=line.page,
            y_start=line.y,
        )
        sections.append(current)

    return sections


def detect_profile(sections: list[Section]) -> str:
    """Which extraction shape this document uses.

    The three template documents in the sample corpus label their parts in prose
    (`Statement:` / `Rationale:` / `Requirements:`). The live customer document
    puts its principles in a four-column table instead. Both appear in the wild,
    so the shape is detected rather than assumed — and a document may be mixed,
    which the live one is.
    """
    prose = sum(1 for s in sections if re.search(r"\bStatement\s*:", s.text))
    if prose >= 3:
        return "prose-clause"
    if prose:
        return "mixed"
    return "table-principle"


def whole_document(lines: list[Line], *, document_title: str) -> list[Section]:
    """One section covering everything, for a document with no headings at all.

    The floor beneath every other strategy. Without it, a document whose
    typography carries no heading styles produces no sections, then no chunks,
    and the chunk stage fails the upload outright — so a perfectly readable
    standard becomes worth exactly nothing.

    One section is enough to make the text retrievable. It will rarely yield a
    clause, so the document cannot be assessed *against*; it can still be
    searched and cited as reference material, which is a great deal better than
    a rejected file. The parse stage raises `no_sections` regardless, so nobody
    mistakes this for a successful parse.
    """
    body = [line for line in lines if line.text.strip()]
    if not body:
        return []

    return [
        Section(
            ordinal=1,
            number_text=None,
            title=document_title,
            depth=1,
            heading_path=document_title,
            page_start=body[0].page,
            page_end=body[-1].page,
            lines=body,
        )
    ]


def from_outline(
    lines: list[Line],
    levels: dict[int, int],
    *,
    document_title: str,
) -> tuple[list[Section], list[int]]:
    """Sections from depths the document declared, rather than ones we inferred.

    `build` above has to defend a guess: typography said "this looks like a
    heading", so the shape rules exist to stop a bold sentence or a
    `Statement:` label being promoted. None of that applies here. A .docx
    states that a paragraph is a level-2 heading, and second-guessing a
    declaration would drop real headings — a heading legitimately reading
    "Scope: retail payments only" carries a colon and is still a heading.

    So the only thing borrowed from the inferred path is the numbering: a
    heading that spells its own number out ("5.2 Key Management") has it lifted
    for display and citation, and one relying on Word's automatic numbering
    simply has none in its text. Identity stays `(document_id, ordinal)` either
    way, for the reason given at the top of this module.

    Returns the sections and, for each line, the index of the section it falls
    in — which is how a table lands in the section it was written under rather
    than in whichever one a page number happens to hit.
    """
    sections: list[Section] = []
    owner = [-1] * len(lines)
    stack: list[tuple[int, str]] = []
    current: Section | None = None

    for index, line in enumerate(lines):
        depth = levels.get(index)
        if depth is None:
            if current is not None:
                current.lines.append(line)
                current.page_end = max(current.page_end, line.page)
                owner[index] = len(sections) - 1
            continue

        text = line.text.strip()
        number: str | None = None
        title = text
        if m := _NUMBERED.match(text):
            number, title = m.group("number"), m.group("title").strip()
        elif m := _APPENDIX.match(text):
            number = m.group("number").title()
            title = (m.group("title") or "").strip() or number

        while stack and stack[-1][0] >= depth:
            stack.pop()
        stack.append((depth, f"{number} {title}".strip() if number else title))

        current = Section(
            ordinal=len(sections) + 1,
            number_text=number,
            title=title,
            depth=depth,
            heading_path=" › ".join([document_title, *(t for _, t in stack)]),
            page_start=line.page,
            page_end=line.page,
            y_start=line.y,
        )
        sections.append(current)
        owner[index] = len(sections) - 1

    return sections, owner
