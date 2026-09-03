"""Slides in, lines out — the adapter for PowerPoint decks.

A PDF is a rendering format: whatever structure the author had was destroyed at
export, and `spans.py` reconstructs it by clustering font signatures. A .pptx
never lost it. The file says outright which shape is the title and how deep each
bullet sits, so this module reads that instead of inferring it.

What it does *not* do is decide the document's structure. Slide titles are
frequently not clause headings — a deck says "Encryption at rest ✓" where a
standard says "All data at rest must be encrypted using organisation-managed
keys" — so the same model pass that rescues a formatless PDF (`ai_structure`)
decides here too. This module's job is to hand that pass the cleanest possible
input: reading order restored, furniture removed, and each line tagged with what
PowerPoint already knew about it.

The tags are input, never output. The model still replies with nothing but line
numbers, and the text is still sliced from our own copy — see the docstring in
ai_structure.py for why that property is the one worth protecting.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field
from typing import Any

import fitz
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER

from .. import logs
from .figures import Figure
from .spans import Line

log = logs.get(__name__)

# DrawingML text run. Every shape that holds words holds them in one of these.
_DRAWING_TEXT = "{http://schemas.openxmlformats.org/drawingml/2006/main}t"

# PowerPoint names its own furniture, so none of the page-repetition heuristics
# in furniture.py are needed here — these are simply not content.
_FURNITURE = {PP_PLACEHOLDER.FOOTER, PP_PLACEHOLDER.SLIDE_NUMBER, PP_PLACEHOLDER.DATE}

_TITLE_PLACEHOLDERS = {
    PP_PLACEHOLDER.TITLE,
    PP_PLACEHOLDER.CENTER_TITLE,
    PP_PLACEHOLDER.VERTICAL_TITLE,
}

# EMU is PowerPoint's internal unit. Points keep `Line.y`/`x0` on the same scale
# as the PDF path, which matters only for legibility in logs — nothing
# downstream compares a slide coordinate to a page one.
_EMU_PER_POINT = 12700

# Synthetic point sizes, so a Line carries a font signature that orders the way
# the deck reads. Nothing on the slide path consults these to find headings —
# the tags do that — but a degenerate signature on every line would make any
# future reuse of the typographic tools silently meaningless.
_SIZE_TITLE = 32.0
_SIZE_SUBTITLE = 24.0
_SIZE_BODY = 18.0
_SIZE_NOTES = 12.0

# A picture smaller than this fraction of the slide is a logo, an icon or a
# decorative rule. Describing those costs a vision call each and puts a
# meaningless entry in the figure review queue.
_MIN_FIGURE_AREA = 0.04

# An image repeated across this share of the deck is branding, however large it
# is. Same reasoning as furniture.strip's page-repetition test, applied to
# blobs rather than to text.
_REPEAT_SHARE = 0.30


@dataclass
class Deck:
    """Shaped to drop straight into the parse stage, like `ai_structure.Structure`."""

    lines: list[Line] = field(default_factory=list)
    #: Line index -> what PowerPoint called it. Passed to the structure pass as
    #: a hint; see `_tagged` in ai_structure.py.
    hints: dict[int, str] = field(default_factory=dict)
    #: Keyed by slide number, matching `Figure.page` on the PDF path.
    figures: list[Figure] = field(default_factory=list)
    slide_count: int = 0
    #: The deck's own name for itself — the title of slide one, when it has one.
    title: str | None = None
    #: Pictures that could not be converted to PNG, reported rather than dropped
    #: in silence.
    undecodable_images: int = 0


def _points(emu) -> float:
    return float(emu) / _EMU_PER_POINT if emu is not None else 0.0


def _sig(size: float, bold: bool) -> tuple[str, float, bool, bool, int]:
    return ("slide", size, bold, False, 0)


def _shapes_in_reading_order(shapes) -> list:
    """Flatten groups, then order the way a person reads a slide.

    Shape order in the XML is z-order — the sequence they were drawn in, which
    for an edited deck is arbitrary. A title added last would otherwise arrive
    after the bullets it introduces, and the structure pass would read the slide
    inside out.

    Groups are flattened rather than skipped: a grouped set of callout boxes is
    ordinary content that happens to have been grouped so it could be dragged
    around together.
    """
    flat: list = []
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            flat.extend(_shapes_in_reading_order(shape.shapes))
        else:
            flat.append(shape)

    def key(shape):
        placeholder = _placeholder_type(shape)
        # Titles first regardless of where they sit. A title placed below the
        # body — common on section-divider layouts — is still the heading.
        return (0 if placeholder in _TITLE_PLACEHOLDERS else 1, shape.top or 0, shape.left or 0)

    return sorted(flat, key=key)


def _placeholder_type(shape):
    """The placeholder role, or None. Guarded: not every shape has the attribute."""
    try:
        if shape.is_placeholder:
            return shape.placeholder_format.type
    except (AttributeError, ValueError, KeyError):
        return None
    return None


def _emit(
    deck: Deck, text: str, *, slide: int, hint: str, size: float, bold: bool, y: float, x0: float
) -> None:
    body = " ".join(text.split())
    if not body:
        return
    index = len(deck.lines)
    deck.lines.append(
        Line(
            text=body,
            page=slide,
            y=y,
            x0=x0,
            bbox=(x0, y, x0, y),
            sig=_sig(size, bold),
            has_bold=bold,
        )
    )
    deck.hints[index] = hint


def _read_text_frame(deck: Deck, shape, *, slide: int, hint: str, size: float) -> None:
    """One paragraph per line, carrying its outline depth into the hint.

    A bullet's `level` is the one piece of hierarchy a deck states explicitly,
    and it is exactly what separates a top-level obligation from a sub-point
    elaborating it. Flattening it would throw away the only structural signal
    the file gives below the title.
    """
    top = _points(shape.top)
    left = _points(shape.left)
    for offset, para in enumerate(shape.text_frame.paragraphs):
        text = "".join(run.text for run in para.runs)
        if not text.strip():
            continue
        bold = any(run.font.bold for run in para.runs if run.font.bold is not None)
        level = para.level or 0
        tag = hint if level == 0 else f"{hint} L{level}"
        _emit(
            deck,
            text,
            slide=slide,
            hint=tag,
            # Nested bullets step down a point per level, so the signature keeps
            # the outline's shape rather than flattening it.
            size=max(size - level * 2.0, 8.0),
            bold=bold,
            y=top + offset,
            x0=left + level * 12.0,
        )


def _read_table(deck: Deck, shape, *, slide: int) -> None:
    """Table cells, one line per row.

    Tagged so the structure pass can leave them unmarked — a table row is not a
    heading and rarely a standalone requirement. They are still emitted, because
    a policy matrix on a slide is frequently where the actual thresholds live,
    and a line that is never emitted is a line that can never be retrieved.
    """
    top = _points(shape.top)
    left = _points(shape.left)
    for offset, row in enumerate(shape.table.rows):
        cells = [" ".join(cell.text.split()) for cell in row.cells]
        text = " | ".join(cell for cell in cells if cell)
        _emit(
            deck,
            text,
            slide=slide,
            hint="table",
            size=_SIZE_BODY,
            bold=False,
            y=top + offset,
            x0=left,
        )


def _read_chart(deck: Deck, shape, *, slide: int) -> None:
    """A chart's data, as lines.

    A chart carries no text frame, so the shape loop skipped it entirely and
    everything it said went with it. On a commercials or comparison slide the
    chart *is* the content — "Solution A 120, 130, 140 against Solution B 200,
    90, 80" is the cost case, and a deck assessed without it has had its
    numbers removed.

    Read through the chart API rather than by scraping XML, because the values
    live in a separate part of the package and are not in the shape's markup.
    Each series becomes one line with its categories bound to its values, for
    the same reason a table row carries its headers: the binding is the meaning,
    and "120, 130, 140" on its own says nothing.
    """
    try:
        chart = shape.chart
        plot = chart.plots[0]
        categories = [str(c) for c in plot.categories]
    except Exception as exc:  # noqa: BLE001 — an unreadable chart is not fatal
        logs.warn(log, "could not read a chart", slide=slide, error=str(exc)[:160])
        return

    top = _points(shape.top)
    left = _points(shape.left)
    offset = 0

    title = ""
    try:
        if chart.has_title:
            title = chart.chart_title.text_frame.text.strip()
    except Exception:  # noqa: BLE001 — titles are optional and sometimes broken
        title = ""
    if title:
        _emit(deck, title, slide=slide, hint="chart", size=_SIZE_BODY,
              bold=False, y=top + offset, x0=left)
        offset += 1

    for series in plot.series:
        try:
            values = list(series.values)
        except Exception:  # noqa: BLE001
            continue
        pairs = ", ".join(
            f"{category} {value:g}"
            # Not strict: a series legitimately carries fewer points than the
            # chart has categories, and half a series beats none of it.
            for category, value in zip(categories, values, strict=False)
            if value is not None
        )
        if not pairs:
            continue
        name = (series.name or "Series").strip()
        _emit(deck, f"{name}: {pairs}", slide=slide, hint="chart",
              size=_SIZE_BODY, bold=False, y=top + offset, x0=left)
        offset += 1


def _read_remaining_text(deck: Deck, shape, *, slide: int) -> None:
    """Any text in a shape none of the readers above understood.

    The last net. SmartArt, embedded objects, ink annotations and whatever
    PowerPoint adds next all arrive as shapes with no text frame and no table,
    and the loop's `continue` used to be the end of them. Their text still sits
    in the drawing markup as `a:t` runs, so it is scraped rather than lost.

    Deliberately unstructured and tagged as such: this says a slide contains
    these words, not what role they play. Better a line the structure pass has
    to think about than a line nobody ever sees.
    """
    top = _points(shape.top)
    left = _points(shape.left)
    seen: set[str] = set()
    offset = 0
    for element in shape._element.iter(_DRAWING_TEXT):  # noqa: SLF001 — no public walk
        text = (element.text or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        _emit(deck, text, slide=slide, hint="shape", size=_SIZE_BODY,
              bold=False, y=top + offset, x0=left)
        offset += 1


def _read_notes(deck: Deck, slide_obj, *, slide: int) -> None:
    """Speaker notes.

    Kept because a standards deck routinely states the rule on the slide and its
    reasoning in the notes — dropping them would discard the rationale for every
    clause in the document. Tagged distinctly so the structure pass treats them
    as supporting text rather than as obligations in their own right.
    """
    if not slide_obj.has_notes_slide:
        return
    frame = slide_obj.notes_slide.notes_text_frame
    if frame is None:
        return
    for offset, para in enumerate(frame.paragraphs):
        text = "".join(run.text for run in para.runs)
        _emit(
            deck,
            text,
            slide=slide,
            hint="notes",
            size=_SIZE_NOTES,
            bold=False,
            y=1000.0 + offset,
            x0=0.0,
        )


def _to_png(blob: bytes) -> bytes | None:
    """Normalise an embedded image to PNG, or give up.

    Decks embed JPEG, PNG, GIF and — from pasted Office drawings — EMF/WMF.
    Everything downstream stores `image/png` and sends that media type to the
    vision model, so a JPEG passed through unconverted would be labelled wrongly
    at the API boundary. PyMuPDF is already a dependency and decodes the raster
    formats; the vector ones it cannot, and those are counted and reported.
    """
    try:
        pix = fitz.Pixmap(io.BytesIO(blob))
        if pix.alpha:
            pix = fitz.Pixmap(pix, 0)
        return pix.tobytes("png")
    except Exception:  # noqa: BLE001 — an undecodable image must not sink the deck
        return None


def _read_pictures(prs, deck: Deck) -> None:
    """Slide images worth describing, with branding filtered out.

    Two passes, because the repetition test needs the whole deck: an image is
    only branding once you know it appears on a third of the slides. A logo
    described by a vision model on every slide is forty pointless API calls and
    forty entries in a review queue meant for architecture diagrams.
    """
    slide_area = _points(prs.slide_width) * _points(prs.slide_height)
    # python-pptx ships no type stubs, so a shape is Any wherever one is held.
    found: list[tuple[int, Any, bytes, str]] = []
    # Distinct slides per image, not occurrences: a logo placed twice on one
    # slide is still one slide's worth of evidence that it is branding.
    appears_on: dict[str, set[int]] = {}

    for number, slide_obj in enumerate(prs.slides, start=1):
        for shape in _shapes_in_reading_order(slide_obj.shapes):
            if shape.shape_type != MSO_SHAPE_TYPE.PICTURE:
                continue
            try:
                blob = shape.image.blob
            except (AttributeError, ValueError, KeyError):
                continue
            digest = hashlib.sha256(blob).hexdigest()
            appears_on.setdefault(digest, set()).add(number)
            found.append((number, shape, blob, digest))

    total = max(deck.slide_count, 1)
    for number, shape, blob, digest in found:
        width = _points(shape.width)
        height = _points(shape.height)
        if slide_area and (width * height) / slide_area < _MIN_FIGURE_AREA:
            continue
        # An image used once is never branding, whatever share of a short deck
        # that one slide represents. Without this floor a lone diagram in a
        # two-slide deck reads as appearing on 50% of it and is thrown away.
        slides_used = appears_on[digest]
        if len(slides_used) > 1 and len(slides_used) / total >= _REPEAT_SHARE:
            continue
        png = _to_png(blob)
        if png is None:
            deck.undecodable_images += 1
            continue
        left = _points(shape.left)
        top = _points(shape.top)
        deck.figures.append(
            Figure(
                page=number,
                bbox=(left, top, left + width, top + height),
                png=png,
                caption=(shape.name or "").strip() or None,
                kind="raster",
                # The PDF path counts drawing primitives inside the region to
                # rank review by risk. A slide picture is one opaque blob with
                # no primitives to count, so the queue falls back to slide
                # order for decks.
                complexity=0,
            )
        )


def read(raw: bytes) -> Deck:
    """Parse a .pptx into lines, hints and figures."""
    prs = Presentation(io.BytesIO(raw))
    deck = Deck()
    deck.slide_count = len(prs.slides._sldIdLst)  # noqa: SLF001 — no public length

    for number, slide_obj in enumerate(prs.slides, start=1):
        for shape in _shapes_in_reading_order(slide_obj.shapes):
            placeholder = _placeholder_type(shape)
            if placeholder in _FURNITURE:
                continue

            if getattr(shape, "has_table", False):
                _read_table(deck, shape, slide=number)
                continue

            if getattr(shape, "has_chart", False):
                _read_chart(deck, shape, slide=number)
                continue

            if not getattr(shape, "has_text_frame", False):
                # Not a shape any reader above understood. Scrape whatever text
                # it holds rather than dropping it — see _read_remaining_text.
                _read_remaining_text(deck, shape, slide=number)
                continue

            if placeholder in _TITLE_PLACEHOLDERS:
                hint, size = "title", _SIZE_TITLE
            elif placeholder == PP_PLACEHOLDER.SUBTITLE:
                hint, size = "subtitle", _SIZE_SUBTITLE
            else:
                # A text box that is not a placeholder at all. Extremely common
                # in decks built by dragging boxes around, and the reason the
                # structure pass still has to decide rather than trusting tags.
                hint, size = ("body" if placeholder is not None else "text"), _SIZE_BODY

            _read_text_frame(deck, shape, slide=number, hint=hint, size=size)

            if deck.title is None and hint == "title" and number == 1:
                deck.title = deck.lines[-1].text[:160] if deck.lines else None

        _read_notes(deck, slide_obj, slide=number)

    _read_pictures(prs, deck)

    logs.info(
        log,
        "deck read",
        slides=deck.slide_count,
        lines=len(deck.lines),
        figures=len(deck.figures),
        undecodable=deck.undecodable_images,
    )
    return deck
