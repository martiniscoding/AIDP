"""The whole submitted document, for an assessment that reads all of it.

Retrieval shows the judge eight passages a search chose for each clause. On a
five-page design that is half the document and the search rarely misses; on a
96-page blueprint it is under one percent of it, and a requirement answered by
a paragraph on page 23 and a table on page 57 needs both to win the search. A
miss there does not look like a miss — it looks like "absent".

This module is the other way: the complete document, page by page, exactly as
the parse stage read it into `source_line`, so the judge reads everything and
cites what it read. Two things make that trustworthy rather than merely larger:

- **The text is the document's own.** Every paragraph and table row as read,
  not the chunks, which are reassembled and duplicated for search. Figure
  descriptions go alongside, labelled as a model's reading of an image.
- **A quote is only evidence if it is in the document word for word.**
  `verify` checks every one, on the page the model named or any other. A quote
  that is nowhere in the document is how an invented requirement would reach a
  report, and it is refused.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from . import db

# English prose in a byte-pair vocabulary averages about four characters a
# token. Only used to decide whether a document fits; the provider bills exact.
CHARS_PER_TOKEN = 4

# A quote shorter than this identifies nothing: "must be encrypted" is on half
# the pages of a security design, so finding it proves the model read nothing.
MIN_QUOTE_WORDS = 4

# Quotes are compared on words alone. Typography differs between what the file
# holds and what a model writes back — curly quotes, dashes, a line break
# inside a sentence, a bullet glyph — and none of it changes what was said.
_TYPOGRAPHY = str.maketrans(
    {
        "‘": "'",
        "’": "'",
        "“": '"',
        "”": '"',
        "–": "-",
        "—": "-",
        " ": " ",
    }
)
_WORD = re.compile(r"[^\W_]+")
_ELLIPSIS = re.compile(r"\.\.\.|…")


def normalise(text: str) -> str:
    """Lower-case words separated by single spaces, and nothing else."""
    folded = unicodedata.normalize("NFKC", text or "").translate(_TYPOGRAPHY).lower()
    return " ".join(_WORD.findall(folded))


@dataclass
class Check:
    """Whether a quote is in the document, and where."""

    verified: bool
    page: int | None
    reason: str = ""


@dataclass
class WholeDocument:
    title: str
    #: Pages in reading order, each with its lines as they will be shown.
    pages: list[tuple[int | None, list[str]]] = field(default_factory=list)
    #: (page, description) for every figure a model described.
    figures: list[tuple[int | None, str]] = field(default_factory=list)
    text: str = ""
    _order: list[int | None] = field(default_factory=list)
    _normal: dict[int | None, str] = field(default_factory=dict)

    @property
    def tokens(self) -> int:
        return len(self.text) // CHARS_PER_TOKEN

    def verify(self, quote: str, page: int | None) -> Check:
        """Find a quote in the document, preferring the page the model named.

        A quote may carry an ellipsis where the model skipped words; each part
        must then be found, in order, within the same stretch. A stretch is one
        page and the page after it, because a sentence that runs over a page
        break is one passage in the document and two in the page list.
        """
        parts = [normalise(part) for part in _ELLIPSIS.split(quote or "")]
        parts = [part for part in parts if part]
        if not parts:
            return Check(False, page, "the quote is empty")
        if sum(len(part.split()) for part in parts) < MIN_QUOTE_WORDS:
            return Check(False, page, "the quote is too short to identify a passage")
        if len(parts) > 1 and any(len(part.split()) < 2 for part in parts):
            return Check(False, page, "a fragment of the quote is too short to identify")

        indices = list(range(len(self._order)))
        if page in self._normal:
            # The named page first; it is usually right, and cheapest to check.
            first = self._order.index(page)
            indices.remove(first)
            indices.insert(0, first)
        for index in indices:
            found = self._locate(index, parts)
            if found is not None:
                reason = (
                    f"found on page {found}, not page {page}"
                    if page is not None and found != page
                    else ""
                )
                return Check(True, found, reason)
        return Check(False, page, "the quoted words are not in the document")

    def _locate(self, index: int, parts: list[str]) -> int | None:
        """The page a quote sits on, looking at one page and the page after it.

        A quote wholly on the later page belongs to that page — reporting the
        earlier one sent a reviewer to page 2 for a sentence printed on page 3.
        Only a quote that truly runs over the break is given the page it starts on.
        """
        page = self._order[index]
        if _in_order(self._normal[page], parts):
            return page
        if index + 1 >= len(self._order):
            return None
        following = self._order[index + 1]
        if _in_order(self._normal[following], parts):
            return following
        if _in_order(self._stretch(index), parts):
            return page
        return None

    @staticmethod
    def sentences(quote: str) -> list[str]:
        """A quote divided at its sentence ends."""
        return [part for part in re.split(r"(?<=[.!?;])\s+", quote or "") if part.strip()]

    def _stretch(self, index: int) -> str:
        current = self._normal[self._order[index]]
        if index + 1 < len(self._order):
            return f"{current} {self._normal[self._order[index + 1]]}"
        return current


def _in_order(haystack: str, parts: list[str]) -> bool:
    """Every part present as whole words, each after the one before."""
    padded = f" {haystack} "
    position = 0
    for part in parts:
        found = padded.find(f" {part} ", position)
        if found == -1:
            return False
        position = found + len(part) + 1
    return True


def build(title: str, lines: list[dict], figures: list[dict]) -> WholeDocument:
    """The document as the judge reads it, from `source_line` and `figure` rows.

    Lines keep the page they were read on. A heading is marked as one, because
    where a statement sits in the document can change what it commits to; a
    table row arrives already bound to its columns. Rejected figure readings are
    left out, and a reviewer's correction replaces the model's reading.
    """
    document = WholeDocument(title=title)
    for row in lines:
        text = " ".join(str(row.get("text") or "").split())
        if not text:
            continue
        page = row.get("page")
        if not document.pages or document.pages[-1][0] != page:
            document.pages.append((page, []))
        kind = row.get("kind")
        prefix = "## " if kind == "heading" else "- " if kind == "bullet" else ""
        document.pages[-1][1].append(prefix + text)

    for row in figures:
        if row.get("reviewState") == "rejected":
            continue
        description = " ".join(
            str(row.get("correctedDescription") or row.get("description") or "").split()
        )
        if description:
            document.figures.append((row.get("page"), description))

    for page, page_lines in document.pages:
        joined = normalise(" ".join(page_lines))
        if page in document._normal:
            document._normal[page] = f"{document._normal[page]} {joined}"
        else:
            document._order.append(page)
            document._normal[page] = joined

    document.text = render(document)
    return document


def render(document: WholeDocument) -> str:
    safe_title = document.title.replace('"', "'")
    out = [f'<design_document title="{safe_title}">']
    for page, page_lines in document.pages:
        out.append(f"=== page {page if page is not None else '?'} ===")
        out.extend(page_lines)
    out.append("</design_document>")
    if document.figures:
        out.append("")
        out.append("<figure_descriptions>")
        out.append(
            "Written by a model from the diagrams in this document. They are not the "
            "document's own words: use them to understand a diagram, never quote them."
        )
        for page, description in document.figures:
            out.append(f"[figure on page {page if page is not None else '?'}] {description}")
        out.append("</figure_descriptions>")
    return "\n".join(out)


def load(conn, document_id: str, title: str) -> WholeDocument | None:
    """The stored document, or None when its pages were never stored.

    None is the answer for a document processed before page text was kept; the
    caller falls back to search and says why, rather than reading nothing.
    """
    lines = db.query(
        conn,
        'SELECT "page", "kind", "text" FROM "source_line" '
        'WHERE "documentId" = %s ORDER BY "ordinal"',
        (document_id,),
    )
    if not lines:
        return None
    figures = db.query(
        conn,
        """
        SELECT f."page", f."description", f."correctedDescription", f."reviewState"
          FROM "figure" f
          JOIN "document_section" s ON s."id" = f."sectionId"
         WHERE s."documentId" = %s
         ORDER BY f."page", f."ordinal"
        """,
        (document_id,),
    )
    return build(title, lines, figures)
