"""Table extraction, with headers bound to cells and empty cells kept.

This is where a compliance tool is most likely to be confidently wrong.

The live customer document's criticality-tier table has six columns and, on its
Tier 4 row, four values — RPO and RTO are blank. Flatten that row and every
later value shifts one column left, so "not specified" silently becomes the
previous tier's "4 to 8 hours". A wrong recovery objective delivered with
citations is worse than no answer.

So: every cell is bound to its column header, and an empty cell is stored as
None rather than omitted. Rows that span a page break are rejoined, because two
tables in the sample corpus do.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import fitz

# Below this, the extraction is reported for review rather than trusted.
LOW_CONFIDENCE = 0.6

# A continuation table must start near the top of the next page.
_TOP_MARGIN = 160.0
_BOTTOM_MARGIN = 160.0


@dataclass
class Table:
    page_start: int
    page_end: int
    bbox: tuple[float, float, float, float]
    columns: list[str]
    # Column header -> cell. None means the cell was empty in the source, which
    # is a fact about the document and never dropped.
    rows: list[dict[str, str | None]] = field(default_factory=list)
    confidence: float = 1.0
    caption: str | None = None

    @property
    def is_empty(self) -> bool:
        return not self.rows or not self.columns

    def render_row(self, row: dict[str, str | None]) -> str:
        """A row as a sentence, headers included.

        This is what gets embedded. Losing the visual grid is fine; losing the
        header-to-cell binding is not, because the binding is the meaning.
        """
        first = self.columns[0] if self.columns else ""
        lead = (row.get(first) or "").strip()
        rest = [
            f"{col}: {(row.get(col) or 'not specified').strip()}"
            for col in self.columns[1:]
        ]
        head = f"{lead} — " if lead else ""
        return head + ". ".join(rest) + "."

    def render(self) -> str:
        lines = [" | ".join(self.columns)]
        for row in self.rows:
            lines.append(" | ".join((row.get(c) or "—") for c in self.columns))
        return "\n".join(lines)


def _clean(value: Any) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text or None


def _headers(raw: list[list[Any]], finder_header: Any) -> tuple[list[str], list[list[Any]]]:
    """Column names and the data rows beneath them."""
    names: list[str] = []
    body = raw

    if finder_header is not None and getattr(finder_header, "names", None):
        names = [(_clean(n) or "") for n in finder_header.names]
        # `external` means the header sits above the grid and is not part of
        # extract()'s output; otherwise the first row is the header.
        if not getattr(finder_header, "external", False) and raw:
            body = raw[1:]
    elif raw:
        names = [(_clean(c) or "") for c in raw[0]]
        body = raw[1:]

    # Unnamed columns still need a stable key, or their cells become
    # unaddressable and effectively lost.
    names = [n if n else f"column {i + 1}" for i, n in enumerate(names)]
    seen: dict[str, int] = {}
    unique: list[str] = []
    for name in names:
        if name in seen:
            seen[name] += 1
            unique.append(f"{name} ({seen[name]})")
        else:
            seen[name] = 1
            unique.append(name)
    return unique, body


def _confidence(columns: list[str], rows: list[dict[str, str | None]]) -> float:
    if not columns or not rows:
        return 0.0
    filled = sum(1 for r in rows for c in columns if r.get(c))
    density = filled / (len(rows) * len(columns))
    named = sum(1 for c in columns if not c.startswith("column ")) / len(columns)
    # Density alone punishes legitimately sparse tables, so it is weighted
    # lightly against whether the header row was actually recognised.
    return round(0.35 * density + 0.65 * named, 3)


def extract_page(
    page: fitz.Page, regions: list[tuple[float, float, float, float]] | None = None
) -> list[Table]:
    """Tables on one page, in reading order.

    `regions`, when given, collects the outline of every table the finder saw —
    including ones discarded below for holding no usable rows. The two answer
    different questions. A table with a header and nothing under it contributes
    no chunk, but it is still a table, and its bold header cell is still not a
    section heading. Record only the tables that survived and that header walks
    out of the region and into the section tree.
    """
    try:
        finder = page.find_tables()
    except Exception:  # noqa: BLE001 — a page that defeats the finder is not fatal
        return []

    out: list[Table] = []
    for found in getattr(finder, "tables", []):
        if regions is not None:
            regions.append(tuple(found.bbox))  # type: ignore[arg-type]
        try:
            raw = found.extract()
        except Exception:  # noqa: BLE001
            continue
        if not raw:
            continue

        columns, body = _headers(raw, getattr(found, "header", None))
        if not columns:
            continue

        rows: list[dict[str, str | None]] = []
        for raw_row in body:
            # Pad short rows so a missing trailing cell stays missing rather
            # than silently vanishing from the mapping.
            padded = list(raw_row) + [None] * (len(columns) - len(raw_row))
            row = {col: _clean(padded[i]) for i, col in enumerate(columns)}
            if any(v for v in row.values()):
                rows.append(row)

        if not rows:
            continue

        bbox = tuple(found.bbox)  # type: ignore[assignment]
        out.append(
            Table(
                page_start=page.number + 1,
                page_end=page.number + 1,
                bbox=bbox,
                columns=columns,
                rows=rows,
                confidence=_confidence(columns, rows),
            )
        )

    out.sort(key=lambda t: t.bbox[1])
    return out


def stitch(tables: list[Table], page_heights: dict[int, float]) -> list[Table]:
    """Rejoin tables broken across a page boundary.

    A continuation carries the same column names, starts near the top of the
    following page, and its predecessor ends near the bottom of the previous
    one. All three must hold — matching on headers alone would merge the four
    separate `Term | Definition` glossary tables that appear in every document.
    """
    if not tables:
        return []

    merged: list[Table] = [tables[0]]
    for table in tables[1:]:
        previous = merged[-1]
        page_height = page_heights.get(previous.page_end, 842.0)

        continues = (
            table.page_start == previous.page_end + 1
            and table.columns == previous.columns
            and table.bbox[1] <= _TOP_MARGIN
            and previous.bbox[3] >= page_height - _BOTTOM_MARGIN
        )
        if continues:
            previous.rows.extend(table.rows)
            previous.page_end = table.page_end
            previous.confidence = min(previous.confidence, table.confidence)
        else:
            merged.append(table)
    return merged


BoxesByPage = dict[int, list[tuple[float, float, float, float]]]


def extract_with_regions(doc: fitz.Document) -> tuple[list[Table], BoxesByPage]:
    """Every table, page breaks rejoined, plus where each one sits on each page.

    The regions are taken per page, before stitching. A table rejoined across a
    page break keeps only its first page's outline, so reading regions off the
    stitched result would place every continuation in the wrong spot.
    """
    tables: list[Table] = []
    heights: dict[int, float] = {}
    regions: BoxesByPage = {}
    for index in range(doc.page_count):
        page = doc[index]
        heights[index + 1] = page.rect.height
        tables.extend(extract_page(page, regions.setdefault(index + 1, [])))
    return stitch(tables, heights), regions


def extract(doc: fitz.Document) -> list[Table]:
    """Every table in the document, page breaks already rejoined."""
    return extract_with_regions(doc)[0]
