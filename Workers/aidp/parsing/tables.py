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

Two things the finder gets wrong are repaired before a table is trusted, both
seen on a 96-page architecture blueprint exported from Word:

  · merged cells. A header cell spanning three grid columns leaves its name on a
    column holding no values and the values on a nameless neighbour, so every
    row of a revision history read "Version: not specified". Columns split that
    way are folded back together, and a column title wrapped onto a second row
    is folded back into the header.
  · outlines that are not tables. The finder outlines anything drawn with ruling
    lines, and an architecture diagram is mostly boxes. Scattered labels, and a
    paragraph that sits in a bordered box, are dropped rather than indexed as
    tables. Their text is not lost: a line inside a table region stays in its
    section's prose either way.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import fitz

# Below this, the extraction is reported for review rather than trusted.
LOW_CONFIDENCE = 0.6

# A continuation table must start near the top of the next page.
_TOP_MARGIN = 160.0
_BOTTOM_MARGIN = 160.0

# The key `_headers` gives a column whose header cell was blank.
_PLACEHOLDER = re.compile(r"^column \d+(?: \(\d+\))?$")

# Longer than this, a first-row cell is content, not the wrapped end of a title.
_CONTINUATION_MAX_CHARS = 60

# A column title wraps over at most this many rows under the header.
_CONTINUATION_MAX_ROWS = 3

# The suffix `_unique` gives a repeated name.
_UNIQUE_SUFFIX = re.compile(r"^(?P<base>.*) \((?P<n>\d+)\)$")

# Cell text that reads as a value wherever it appears, never as a column title.
_DATA_WORDS = {"n/a", "na", "yes", "no", "tbd", "none", "-", "—"}
_NUMERIC = re.compile(r"^[\d.,:/%()+\- ]+$")


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
    #: The finder's grid for this outline, header row included. Only `stitch`
    #: reads it: a page that repeats no header can be joined to the table before
    #: it only by position, cell for cell. Never persisted.
    raw: list[list[Any]] = field(default_factory=list, repr=False)

    @property
    def raw_width(self) -> int:
        return max((len(row) for row in self.raw), default=0)

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


def _is_placeholder(name: str) -> bool:
    return bool(_PLACEHOLDER.match(name))


def _unique(names: list[str]) -> list[str]:
    """Distinct keys, in order.

    Two columns called "Notes" would otherwise share one key, and the second
    would silently overwrite the first.
    """
    seen: dict[str, int] = {}
    unique: list[str] = []
    for name in names:
        if name in seen:
            seen[name] += 1
            unique.append(f"{name} ({seen[name]})")
        else:
            seen[name] = 1
            unique.append(name)
    return unique


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
    return _unique(names), body


def _confidence(columns: list[str], rows: list[dict[str, str | None]]) -> float:
    if not columns or not rows:
        return 0.0
    filled = sum(1 for r in rows for c in columns if r.get(c))
    density = filled / (len(rows) * len(columns))
    named = sum(1 for c in columns if not _is_placeholder(c)) / len(columns)
    # Density alone punishes legitimately sparse tables, so it is weighted
    # lightly against whether the header row was actually recognised.
    return round(0.35 * density + 0.65 * named, 3)


def _promote_header_continuation(
    names: list[str], grid: list[list[Any]]
) -> tuple[list[str], list[list[Any]]]:
    """Fold rows that are really the rest of the header into the header.

    A column title too long for its column wraps over one or more rows, and a
    header cell merged across rows splits the same way. The first body rows
    then carry only fragments of header text — "supports/impacts capability"
    under "How solution", or "Component" and then "hosted" under "App" — and the
    values below bind to the wrong names, or to none.

    The test is positional rather than textual, because header text looks like
    any other short text: continuation rows put text only in columns that no row
    after them ever fills. Rows of real data share their columns with the rows
    beneath them. The longest such block wins, up to `_CONTINUATION_MAX_ROWS`.
    """
    for k in range(min(_CONTINUATION_MAX_ROWS, len(grid) - 1), 0, -1):
        block, rest = grid[:k], grid[k:]
        cols = sorted({i for row in block for i, cell in enumerate(row) if _clean(cell)})
        if not cols:
            continue
        if any(len(_clean(row[i]) or "") > _CONTINUATION_MAX_CHARS for row in block for i in cols):
            continue
        if any(_clean(row[i]) for row in rest for i in cols):
            continue
        promoted = list(names)
        for i in cols:
            text = " ".join(t for t in (_clean(row[i]) for row in block) if t)
            promoted[i] = text if _is_placeholder(names[i]) else f"{names[i]} {text}"
        return promoted, rest
    return names, grid


def _can_fold(a_name: str, a_cells: list[Any], b_name: str, b_cells: list[Any]) -> bool:
    """Whether two neighbouring columns are one column a merged cell split.

    Folding is only allowed where it cannot mislabel anything:

      · at most one of the two has a real name, so no header is ever dropped;
      · if both hold text, it is a merged cell repeating itself — the same text
        in both somewhere, and never different text in both;
      · otherwise one holds no text, and if that one is *named* the merge must be
        visible in the grid: every cell of it covered by a neighbour (None), not
        merely left blank (""). A deliberately empty "Comments" column beside an
        unlabelled one is left alone.
    """
    a_named, b_named = not _is_placeholder(a_name), not _is_placeholder(b_name)
    if a_named and b_named:
        return False

    a_text = [_clean(c) for c in a_cells]
    b_text = [_clean(c) for c in b_cells]
    a_has, b_has = any(a_text), any(b_text)
    if a_has and b_has:
        pairs = [(a_text[i], b_text[i]) for i in range(len(a_text))]
        if any(x and y and x != y for x, y in pairs):
            return False
        return any(x and y and x == y for x, y in pairs)

    empty_named, empty_cells = (a_named, a_cells) if not a_has else (b_named, b_cells)
    return not empty_named or all(c is None for c in empty_cells)


def _fold_cell(a: Any, b: Any) -> Any:
    if _clean(a):
        return a
    if _clean(b):
        return b
    return None if a is None and b is None else ""


def _collapse_merged_columns(
    names: list[str], grid: list[list[Any]]
) -> tuple[list[str], list[list[Any]]]:
    """Put back together columns that merged cells split apart. See `_can_fold`."""
    if len(names) < 2:
        return names, grid
    kept_names = [names[0]]
    kept_cols = [[row[0] for row in grid]]
    for i in range(1, len(names)):
        cells = [row[i] for row in grid]
        if _can_fold(kept_names[-1], kept_cols[-1], names[i], cells):
            if _is_placeholder(kept_names[-1]):
                kept_names[-1] = names[i]
            previous = kept_cols[-1]
            kept_cols[-1] = [_fold_cell(previous[r], cells[r]) for r in range(len(cells))]
        else:
            kept_names.append(names[i])
            kept_cols.append(cells)
    folded = [[col[r] for col in kept_cols] for r in range(len(grid))]
    return kept_names, folded


def _is_a_grid(columns: list[str], rows: list[dict[str, str | None]]) -> bool:
    """Whether an outline the finder drew is a table at all.

    On one blueprint a network diagram came out as nine "tables" of scattered
    labels, and a paragraph in a bordered box as a table of one column — each an
    index chunk of noise, and each raised for review. A grid has at least two
    columns holding values, and at least one row that fills two of them.
    """
    holding = sum(1 for c in columns if any(r.get(c) for r in rows))
    if holding < 2:
        return False
    return any(sum(1 for c in columns if r.get(c)) >= 2 for r in rows)


def shape(
    raw: list[list[Any]], finder_header: Any = None
) -> tuple[list[str], list[dict[str, str | None]]] | None:
    """Named columns and bound rows for one outline, or None if it is no table.

    Everything between the finder's raw grid and a table we trust happens here,
    kept apart from `extract_page` so it can be exercised with a grid written by
    hand rather than a PDF drawn to reproduce it.
    """
    columns, body = _headers(raw, finder_header)
    if not columns:
        return None

    # Pad short rows so a missing trailing cell stays missing rather than
    # silently vanishing. Cells stay raw until the repairs below: the finder
    # reports a cell covered by a merged neighbour as None and a real cell left
    # blank as "", and that difference decides what may be folded.
    width = len(columns)
    grid = [(list(r) + [None] * width)[:width] for r in body]
    grid = [row for row in grid if any(_clean(c) for c in row)]
    if not grid:
        return None

    columns, grid = _promote_header_continuation(columns, grid)
    columns, grid = _collapse_merged_columns(columns, grid)
    columns = _unique(columns)
    rows = [{col: _clean(row[i]) for i, col in enumerate(columns)} for row in grid]
    return (columns, rows) if _is_a_grid(columns, rows) else None


def extract_page(
    page: fitz.Page, regions: list[tuple[float, float, float, float]] | None = None
) -> list[Table]:
    """Tables on one page, in reading order.

    `regions`, when given, collects the outline of every table the finder saw —
    including ones discarded below for holding no usable rows, or for not being
    a table at all. The two answer different questions. A table with a header
    and nothing under it contributes no chunk, but it is still a table, and its
    bold header cell is still not a section heading. Record only the tables that
    survived and that header walks out of the region and into the section tree.
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

        shaped = shape(raw, getattr(found, "header", None))
        if shaped is None:
            continue
        columns, rows = shaped

        bbox = tuple(found.bbox)  # type: ignore[assignment]
        out.append(
            Table(
                page_start=page.number + 1,
                page_end=page.number + 1,
                bbox=bbox,
                columns=columns,
                rows=rows,
                confidence=_confidence(columns, rows),
                raw=raw,
            )
        )

    out.sort(key=lambda t: t.bbox[1])
    return out


def _datalike(cells: list[Any], previous: Table) -> int:
    """How many cells read as values: numbers, N/A-like words, or text the
    previous table already holds in that same column."""
    seen = [{(row.get(col) or "").lower() for row in previous.rows} for col in previous.columns]
    count = 0
    for i, raw in enumerate(cells):
        cell = _clean(raw)
        if not cell:
            continue
        if _NUMERIC.match(cell) or cell.lower() in _DATA_WORDS or (
            i < len(seen) and cell.lower() in seen[i]
        ):
            count += 1
    return count


def _head_values(table: Table) -> list[str | None]:
    """A table's column names read back as the row they were taken from.

    A placeholder was a blank cell, and a " (2)" that `_unique` added to a value
    repeated along the row is taken off again.
    """
    values: list[str | None] = []
    for name in table.columns:
        if _is_placeholder(name):
            values.append(None)
            continue
        match = _UNIQUE_SUFFIX.match(name)
        values.append(match.group("base") if match and match.group("base") in values else name)
    return values


def _positional_rows(previous: Table, table: Table) -> list[list[str | None]] | None:
    """`table`'s rows, by position under `previous`'s columns — or None when
    `table` is not a headerless continuation of it.

    Word repeats a header on the next page only when asked to, and most authors
    never ask. The page after a break then opens with a data row, or with the
    tail of the last cell before the break, and the finder takes it for a header
    — on one blueprint "Node 39", "Virtual" and "8" became column names, and
    every server after the first page of the inventory bound to them.

    Cells are matched by position: by the finder's grid when neither table was
    reshaped by merged cells, otherwise by the shaped columns when both came out
    the same width. Then either the first row reads as data, or it is mostly
    empty — a wrapped tail — and the row under it reads as data. A real header
    of words passes neither, so a new table that happens to start a page stays
    a new table.
    """
    width = len(previous.columns)
    if table.raw and table.raw_width == previous.raw_width == width:
        rows = [[_clean(c) for c in (list(r) + [None] * width)[:width]] for r in table.raw]
    elif len(table.columns) == width:
        rows = [_head_values(table)] + [[r.get(c) for c in table.columns] for r in table.rows]
    else:
        return None
    if not rows:
        return None
    if _datalike(rows[0], previous) * 3 >= width:
        return rows
    mostly_empty = sum(1 for c in rows[0] if not c) * 2 >= width
    if mostly_empty and len(rows) > 1 and _datalike(rows[1], previous) * 3 >= width:
        return rows
    return None


def _continue(previous: Table, table: Table, rows: list[list[str | None]]) -> None:
    """Append a headerless continuation's rows to `previous`, cell by cell."""
    columns = previous.columns
    width = len(columns)
    for index, cells in enumerate(rows):
        if not any(cells):
            continue
        # A mostly empty first row is the tail of a cell that wrapped over the
        # break. It belongs to that cell, not to a row of its own.
        if index == 0 and previous.rows and sum(1 for c in cells if not c) * 2 >= width:
            last = previous.rows[-1]
            for i, cell in enumerate(cells):
                if cell:
                    key = columns[i]
                    last[key] = f"{last[key]} {cell}" if last.get(key) else cell
            continue
        previous.rows.append({columns[i]: cells[i] for i in range(width)})
    previous.page_end = table.page_end
    previous.bbox = (previous.bbox[0], previous.bbox[1], previous.bbox[2], table.bbox[3])
    previous.confidence = _confidence(columns, previous.rows)


def stitch(tables: list[Table], page_heights: dict[int, float]) -> list[Table]:
    """Rejoin tables broken across a page boundary.

    A continuation starts near the top of the following page, and its
    predecessor ends near the bottom of the previous one. Beyond that, either it
    carries the same column names — matching on headers alone would merge the
    four separate `Term | Definition` glossary tables in every document — or it
    repeats no header at all and its first row reads as data, cells matched by
    position (see `_positional_rows`).

    A joined table keeps its first page's top and takes its last page's bottom,
    so a third page is judged against where the table really ended.
    """
    if not tables:
        return []

    merged: list[Table] = [tables[0]]
    for table in tables[1:]:
        previous = merged[-1]
        page_height = page_heights.get(previous.page_end, 842.0)
        across_break = (
            table.page_start == previous.page_end + 1
            and table.bbox[1] <= _TOP_MARGIN
            and previous.bbox[3] >= page_height - _BOTTOM_MARGIN
        )
        if across_break and table.columns == previous.columns:
            previous.rows.extend(table.rows)
            previous.page_end = table.page_end
            previous.bbox = (previous.bbox[0], previous.bbox[1], previous.bbox[2], table.bbox[3])
            previous.confidence = min(previous.confidence, table.confidence)
        elif across_break and (rows := _positional_rows(previous, table)) is not None:
            _continue(previous, table, rows)
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
