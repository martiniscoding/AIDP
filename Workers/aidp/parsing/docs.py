"""Paragraphs in, sections and tables out — the adapter for Word documents.

A .docx is the best-case input in this corpus, and the reason is worth stating:
it is the only format that still *has* its structure when it reaches us. A PDF
is a Word document whose structure was destroyed at export, which is why the
PDF path has to rebuild headings from font sizes and then defend that guess
with shape rules. A deck and a workbook never had a clause structure to state.
A .docx says, in the file, that this paragraph is a level-2 heading.

So this path infers nothing. There is no font profiling, no model pass, and no
`structure_inferred` flag, because nothing here is a proposal — it is what the
author declared.

Three things make that harder than reading `style.name`:

**Corporate templates rename the styles.** A customer's house template calls its
headings "AIDP Heading 2", not "Heading 2", and matching on the name alone
misses every one of them. The authority is `w:outlineLvl`, which is what Word
itself uses to build a navigation pane and a table of contents. It is usually
declared on the *style* rather than on the paragraph, and a custom style
inherits it from the built-in one it is based on — so the lookup walks the base
chain. A style named nothing recognisable still resolves to the right depth.

**Tables live between the paragraphs, not after them.** `document.tables` and
`document.paragraphs` are two flat lists, and reading them separately puts every
table at the end of the document and therefore in the wrong section. The body is
walked in document order instead, so a table lands in the section it was written
under.

**List glyphs are styling, not text.** A bulleted requirement in Word carries no
bullet character — the glyph is drawn from the numbering definition. The clause
parser splits a Requirements block on those glyphs, so without one every bullet
would be joined onto its predecessor and a clause stating four obligations would
be stored as one. Each list paragraph is emitted with a glyph restored.

Pages: a Word document has no pagination until something renders it, so `page`
counts explicit page breaks and is a floor rather than a page number. Nothing
depends on it — a chunk is cited by its heading path, which this format gives
us exactly.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

from docx import Document
from docx.oxml.ns import qn

from .figures import Figure
from .spans import Line
from .tables import Table

# Word's own outline levels run 0-8 for headings and 9 for body text.
_BODY_OUTLINE = 9

# Restored so `clauses._BULLET` can see a list item as a list item.
_BULLET_GLYPH = "• "

# Nominal sizes. Nothing reads them — the section tree comes from the outline,
# not from typography — but `Line` carries a signature and a heading that looks
# like a heading keeps debug output readable.
_HEADING_SIZE = 14.0
_BODY_SIZE = 11.0


@dataclass
class Doc:
    """Shaped to drop straight into the parse stage, like `slides.Deck`."""

    lines: list[Line] = field(default_factory=list)
    #: Index into `lines` -> heading depth, 1-based. Only headings appear.
    levels: dict[int, int] = field(default_factory=dict)
    #: (index into `lines` this followed, table). The index anchors it to a
    #: section without going through a page number the format does not have.
    tables: list[tuple[int, Table]] = field(default_factory=list)
    figures: list[tuple[int, Figure]] = field(default_factory=list)
    #: The document's own name for itself — its Title-styled paragraph.
    title: str | None = None
    page_count: int = 1
    #: Images in a format that could not be read, reported rather than dropped.
    undecodable_images: int = 0


def _sig(size: float, bold: bool) -> tuple[str, float, bool, bool, int]:
    return ("word", size, bold, False, 0)


def _style_outline(style) -> int | None:
    """The outline level a style declares, following what it is based on.

    A house style based on Heading 2 declares no level of its own and inherits
    one. Walking the chain is what makes a renamed heading still a heading.
    """
    seen: set[str] = set()
    while style is not None:
        key = getattr(style, "style_id", None) or str(id(style))
        if key in seen:
            break
        seen.add(key)
        element = style.element.find(qn("w:pPr"))
        if element is not None:
            level = element.find(qn("w:outlineLvl"))
            if level is not None:
                value = level.get(qn("w:val"))
                if value is not None and value.isdigit():
                    return int(value)
        style = getattr(style, "base_style", None)
    return None


def _paragraph_outline(paragraph) -> int | None:
    """A level set on the paragraph itself, which overrides its style."""
    properties = paragraph._p.find(qn("w:pPr"))  # noqa: SLF001 — no public accessor
    if properties is None:
        return None
    level = properties.find(qn("w:outlineLvl"))
    if level is None:
        return None
    value = level.get(qn("w:val"))
    return int(value) if value is not None and value.isdigit() else None


def _depth(paragraph) -> int | None:
    """Heading depth for a paragraph, or None when it is body text.

    Three sources, most authoritative first. The style name is last because it
    is the one a template renames.
    """
    for level in (_paragraph_outline(paragraph), _style_outline(paragraph.style)):
        if level is not None:
            return None if level >= _BODY_OUTLINE else level + 1

    name = (paragraph.style.name or "").strip().lower()
    if name == "title":
        return 1
    if name.startswith("heading"):
        tail = name.replace("heading", "", 1).strip()
        return int(tail) if tail.isdigit() else 1
    return None


def _is_list(paragraph) -> bool:
    """A list item, by numbering definition or by style name.

    Word marks a real list with `numPr`. Documents produced by exporters
    sometimes carry only the style, so both are accepted.
    """
    properties = paragraph._p.find(qn("w:pPr"))  # noqa: SLF001 — no public accessor
    if properties is not None and properties.find(qn("w:numPr")) is not None:
        return True
    return (paragraph.style.name or "").strip().lower().startswith("list")


def _page_breaks(paragraph) -> int:
    """Explicit page breaks inside a paragraph. See the note on pagination."""
    return sum(
        1
        for br in paragraph._p.iter(qn("w:br"))  # noqa: SLF001 — no public accessor
        if br.get(qn("w:type")) == "page"
    )


def _table(element, parent, page: int) -> Table | None:
    """One Word table, headers bound to cells.

    The first row is the header. An empty cell stays empty: a criticality row
    with no stated RPO means "not specified", and borrowing the value above it
    would deliver a wrong recovery objective with a citation.

    Duplicate column names are suffixed rather than collapsed, or the second
    column would silently overwrite the first.
    """
    from docx.table import Table as DocxTable

    table = DocxTable(element, parent)
    rows = [[cell.text.strip() for cell in row.cells] for row in table.rows]
    if len(rows) < 2:
        return None

    header = rows[0]
    columns: list[str] = []
    for index, name in enumerate(header):
        label = name or f"Column {index + 1}"
        if label in columns:
            label = f"{label} ({index + 1})"
        columns.append(label)

    width = len(columns)
    body: list[dict[str, str | None]] = []
    for row in rows[1:]:
        padded = list(row) + [""] * (width - len(row))
        body.append({columns[i]: (padded[i] or None) for i in range(width)})

    if not body:
        return None
    return Table(
        page_start=page,
        page_end=page,
        bbox=(0.0, 0.0, float(width), float(len(body))),
        columns=columns,
        rows=body,
        confidence=1.0,
    )


def _images(document, doc: Doc, anchor: int, page: int) -> None:
    """Inline pictures, as figures for the vision pass.

    Read from the package's relationships rather than by walking drawing XML:
    the bytes are what the describer needs and the position within a paragraph
    is not something a section tree cares about.
    """
    for rel in document.part.rels.values():
        if "image" not in rel.reltype:
            continue
        try:
            blob = rel.target_part.blob
        except Exception:  # noqa: BLE001 — a broken relationship is not fatal
            doc.undecodable_images += 1
            continue
        # EMF and WMF are vector formats out of Office that nothing here can
        # rasterise. Counted and reported, as on the deck path.
        if rel.target_ref.lower().endswith((".emf", ".wmf")):
            doc.undecodable_images += 1
            continue
        doc.figures.append(
            (anchor, Figure(page=page, bbox=(0.0, 0.0, 0.0, 0.0), png=blob, kind="raster"))
        )


def read(raw: bytes) -> Doc:
    """Parse a .docx into lines, heading levels, tables and figures."""
    document = Document(io.BytesIO(raw))
    doc = Doc()

    body = document.element.body
    paragraphs = {p._p: p for p in document.paragraphs}  # noqa: SLF001 — identity map
    page = 1

    for element in body:
        tag = element.tag.split("}")[-1]

        if tag == "tbl":
            table = _table(element, document, page)
            if table is not None:
                doc.tables.append((len(doc.lines) - 1, table))
            continue

        if tag != "p":
            continue

        paragraph = paragraphs.get(element)
        if paragraph is None:
            continue

        page += _page_breaks(paragraph)
        text = paragraph.text.strip()
        if not text:
            continue

        depth = _depth(paragraph)
        if depth is None and _is_list(paragraph):
            text = _BULLET_GLYPH + text

        # The Title style names the document; it is not a section of it.
        # Recording it as a heading as well would open an empty section on
        # every Word document — the title, immediately closed by the first real
        # heading — and `section_empty` would then fire on all of them.
        if doc.title is None and (paragraph.style.name or "").strip().lower() == "title":
            doc.title = text
            depth = None

        index = len(doc.lines)
        doc.lines.append(
            Line(
                text=text,
                page=page,
                y=float(index),
                x0=0.0,
                bbox=(0.0, float(index), 0.0, float(index)),
                sig=_sig(_HEADING_SIZE if depth else _BODY_SIZE, bool(depth)),
                has_bold=bool(depth),
            )
        )
        if depth is not None:
            doc.levels[index] = depth

    # The first heading stands in when the document has no Title style, which
    # most real documents do not.
    if doc.title is None and doc.levels:
        doc.title = doc.lines[min(doc.levels)].text

    _images(document, doc, max(len(doc.lines) - 1, 0), page)
    doc.page_count = page
    return doc
