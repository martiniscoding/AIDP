"""The Table of Contents, used as ground truth.

Every document in the sample corpus opens with a ToC carrying dotted leaders and
page numbers. Parsing it first gives an independent list of what the body parse
*should* find, and reconciling the two afterwards converts silent parse failures
into reported ones.

Twenty lines of code, and nothing else in the pipeline buys that much assurance
that cheaply. It also catches the numbering drift already present in the corpus —
one sample document has two sections both numbered 9.1.1.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .spans import Line

# "1.1. Purpose ......... 5"  ·  "Appendix B: Glossary of Terms ....... 27"
# The leader may be dots, spaces, or a mix, and some exports lose it entirely.
_ENTRY = re.compile(r"^(?P<title>.+?)[\s.]{2,}(?P<page>\d{1,4})$")
_NUMBER = re.compile(r"^(?P<number>\d+(?:\.\d+)*)\.?\s+(?P<rest>\S.*)$")
_APPENDIX = re.compile(r"^(?P<number>Appendix\s+[A-Z])\s*[:.]?\s*(?P<rest>.*)$", re.IGNORECASE)

_HEADING = re.compile(r"table\s+of\s+contents", re.IGNORECASE)


@dataclass(frozen=True)
class TocEntry:
    number: str | None
    title: str
    page: int
    depth: int

    @property
    def key(self) -> str:
        """Normalised for matching against a parsed section title."""
        return normalise(self.title)


def normalise(title: str) -> str:
    text = re.sub(r"[^\w\s]", " ", title.lower())
    return re.sub(r"\s+", " ", text).strip()


def parse(lines: list[Line]) -> list[TocEntry]:
    """Entries from the document's ToC, or [] when it has none.

    A ToC page is identified by density rather than by its heading: five or more
    leader lines on one page is a contents page and nothing else. That survives
    documents whose ToC heading was missed by font profiling.
    """
    by_page: dict[int, list[Line]] = {}
    for line in lines:
        by_page.setdefault(line.page, []).append(line)

    entries: list[TocEntry] = []
    saw_heading = False

    for page in sorted(by_page):
        page_lines = by_page[page]
        if any(_HEADING.search(ln.text) for ln in page_lines):
            saw_heading = True

        hits = [e for e in (_entry(ln.text) for ln in page_lines) if e]
        if len(hits) >= 5:
            entries.extend(hits)
        elif entries:
            # Contents finished; the body starts here.
            break

    if not entries and saw_heading:
        return []
    return entries


def _entry(text: str) -> TocEntry | None:
    match = _ENTRY.match(text.strip())
    if not match:
        return None
    title = match.group("title").strip(" .")
    page = int(match.group("page"))
    if not title or page > 5000:
        return None

    number: str | None = None
    depth = 1
    if m := _NUMBER.match(title):
        number = m.group("number")
        title = m.group("rest").strip()
        depth = number.count(".") + 1
    elif m := _APPENDIX.match(title):
        number = m.group("number").title()
        title = (m.group("rest") or "").strip() or number
        depth = 1

    if not title:
        return None
    return TocEntry(number=number, title=title, page=page, depth=depth)


@dataclass
class Reconciliation:
    matched: int
    missing: list[TocEntry]
    unexpected: list[str]
    page_drift: list[tuple[str, int, int]]

    @property
    def coverage(self) -> float:
        total = self.matched + len(self.missing)
        return self.matched / total if total else 1.0


def reconcile(
    entries: list[TocEntry], sections: list[tuple[str, int]]
) -> Reconciliation:
    """Compare ToC entries against parsed sections as (title, page_start).

    Matching is on normalised titles, not numbers: numbers repeat and drift,
    titles do not. Page comparison allows one page of slack, since a heading
    near a page boundary is legitimately reported either side.
    """
    parsed = {normalise(title): page for title, page in sections}
    missing: list[TocEntry] = []
    drift: list[tuple[str, int, int]] = []
    matched = 0

    for entry in entries:
        found = parsed.get(entry.key)
        if found is None:
            # A ToC title is sometimes truncated; accept a prefix match before
            # calling it missing.
            found = next(
                (p for key, p in parsed.items() if key.startswith(entry.key[:40]) and entry.key),
                None,
            )
        if found is None:
            missing.append(entry)
            continue
        matched += 1
        if abs(found - entry.page) > 1:
            drift.append((entry.title, entry.page, found))

    expected_keys = {e.key for e in entries}
    unexpected = [t for t, _ in sections if normalise(t) not in expected_keys]

    return Reconciliation(matched=matched, missing=missing, unexpected=unexpected, page_drift=drift)
