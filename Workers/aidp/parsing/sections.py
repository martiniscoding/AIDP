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

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines).strip()

    @property
    def is_structural(self) -> bool:
        return self.title.strip().lower() in _SKIP_TITLES


def _classify(line: Line, profile: FontProfile) -> tuple[str | None, str] | None:
    """(number, title) when the line is a heading, else None."""
    if profile.level_of(line.sig) is None:
        return None

    text = line.text.strip()
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


def build(
    lines: list[Line],
    profile: FontProfile,
    *,
    document_title: str,
    skip_pages: set[int] | None = None,
) -> list[Section]:
    """Walk lines in reading order and cut them into sections.

    `skip_pages` drops the contents pages: they look like dense content and are
    entirely redundant, having already been consumed as ground truth by toc.py.
    """
    skip_pages = skip_pages or set()
    sections: list[Section] = []
    stack: list[tuple[int, str]] = []  # (depth, title) for the heading path
    current: Section | None = None
    ordinal = 0

    for line in lines:
        if line.page in skip_pages:
            continue

        heading = _classify(line, profile)
        if heading is None:
            if current is not None:
                current.lines.append(line)
                current.page_end = max(current.page_end, line.page)
            continue

        number, title = heading
        depth = (number.count(".") + 1) if number and number[0].isdigit() else 1

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
        )
        sections.append(current)
        owner[index] = len(sections) - 1

    return sections, owner
