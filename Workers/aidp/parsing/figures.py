"""Figure extraction, including diagrams the text layer knows nothing about.

The sample corpus contains an Enterprise Context Diagram holding a customer's
entire application landscape — every system, and the integrations between them —
behind an empty text layer. For a question like "what does this customer run and
how is it connected?", that one page is the most valuable in the document, and a
text-only pipeline extracts precisely nothing from it.

Two sources, because `get_images()` only sees embedded rasters:

  - embedded images, placed via their xref rectangles
  - vector drawings, clustered by proximity and rendered to raster

Anything overlapping a detected table is dropped: tables are drawn with the same
primitives as diagrams, and a re-rendered table is noise that would be described
by the vision model as though it were a figure.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import fitz

# Below this fraction of the page, a graphic is a logo, a rule, or a bullet.
_MIN_AREA_RATIO = 0.035
# Above it, the "figure" is the page background or a full-page border.
_MAX_AREA_RATIO = 0.92

# Vector primitives closer than this are treated as one drawing.
_CLUSTER_GAP = 26.0

# How many shapes a cluster needs before its contents read as a diagram's
# labels rather than as prose. Two boxes and an arrow is a diagram; one shaded
# band behind a paragraph is a paragraph. See `label_regions_page`.
_MIN_DRAWN_SHAPES = 2

_RENDER_DPI = 170
_CAPTION_GAP = 46.0
_CAPTION = re.compile(r"^\s*(figure|fig\.?|diagram|exhibit)\b", re.IGNORECASE)


@dataclass
class Figure:
    page: int
    bbox: tuple[float, float, float, float]
    png: bytes
    caption: str | None = None
    # "raster" or "vector" — worth keeping, because vector figures are the ones
    # with no text layer and therefore the ones that most need describing.
    kind: str = "raster"
    # Drawing primitives plus text runs inside the region. A dense architecture
    # diagram — many small labels, many arrows — is where vision models actually
    # struggle; a three-box flow is not. Used to sort the review queue by risk
    # rather than by page order.
    complexity: int = 0


def _area(rect: fitz.Rect) -> float:
    return max(0.0, rect.width) * max(0.0, rect.height)


def _plausible(rect: fitz.Rect, page: fitz.Rect) -> bool:
    page_area = _area(page)
    if page_area <= 0:
        return False
    ratio = _area(rect) / page_area
    return _MIN_AREA_RATIO <= ratio <= _MAX_AREA_RATIO and rect.width > 60 and rect.height > 60


def _cluster(rects: list[fitz.Rect]) -> list[fitz.Rect]:
    """Merge nearby rectangles into candidate drawing regions."""
    clusters: list[fitz.Rect] = []
    for rect in sorted(rects, key=lambda r: (r.y0, r.x0)):
        placed = False
        for index, existing in enumerate(clusters):
            grown = fitz.Rect(existing)
            grown.x0 -= _CLUSTER_GAP
            grown.y0 -= _CLUSTER_GAP
            grown.x1 += _CLUSTER_GAP
            grown.y1 += _CLUSTER_GAP
            if grown.intersects(rect):
                clusters[index] = existing | rect
                placed = True
                break
        if not placed:
            clusters.append(fitz.Rect(rect))

    # One pass of coalescing: the first pass leaves neighbours that only became
    # adjacent after their own neighbours merged.
    changed = True
    while changed:
        changed = False
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                if clusters[i].intersects(clusters[j]):
                    clusters[i] |= clusters[j]
                    del clusters[j]
                    changed = True
                    break
            if changed:
                break
    return clusters


def _caption_for(page: fitz.Page, rect: fitz.Rect) -> str | None:
    """A caption printed directly above or below the figure, if there is one."""
    best: tuple[float, str] | None = None
    for block in page.get_text("blocks"):
        x0, y0, x1, y1, text = block[0], block[1], block[2], block[3], block[4]
        text = " ".join(str(text).split())
        if not text or len(text) > 220:
            continue
        below = y0 - rect.y1
        above = rect.y0 - y1
        gap = None
        if 0 <= below <= _CAPTION_GAP:
            gap = below
        elif 0 <= above <= _CAPTION_GAP:
            gap = above
        if gap is None:
            continue
        # Horizontal overlap, so a body paragraph beside the figure is ignored.
        if min(x1, rect.x1) - max(x0, rect.x0) <= 0:
            continue
        score = gap - (30 if _CAPTION.match(text) else 0)
        if best is None or score < best[0]:
            best = (score, text)
    return best[1] if best else None


#: A numbered section heading: "7 Acknowledgements", "6.2.3 Rationale". A
#: figure never continues past one, so it is where a crop stops.
_HEADING = re.compile(r"^\s*\d+(?:\.\d+)*\s+\S")


def _stop_at_next_heading(page: fitz.Page, rect: fitz.Rect) -> fitz.Rect:
    """Trim a cluster that ran on past the end of its own figure.

    Vector clusters grow by proximity, and `_CLUSTER_GAP` is wide enough to
    chain the rules and underlines of body text together. On page 26 of a
    customer's document that produced a single "figure" spanning the whole page
    — y 72 to 792 — whose crop carried the next section's prose and the page
    number into the review panel, where a reviewer saw the Acknowledgements
    section presented as a diagram.

    So a cluster is cut at the first numbered heading that starts below its top.
    A heading is the one landmark that reliably means the figure is over; a
    caption is not, since plenty of figures have none, and a blank band is not,
    since a diagram may contain several.

    The trim only ever shrinks a box, and only when real content remains above
    the heading. A figure that genuinely reaches the bottom of the page has no
    heading under it and is left alone.
    """
    try:
        blocks = page.get_text("blocks")
    except Exception:  # noqa: BLE001
        return rect

    cut: float | None = None
    for block in blocks:
        if len(block) < 5:
            continue
        top = float(block[1])
        text = str(block[4] or "")
        first = next((ln for ln in text.splitlines() if ln.strip()), "")
        if not _HEADING.match(first):
            continue
        # Below the cluster's top, and leaving something worth keeping above it.
        if top > rect.y0 + 24 and top < rect.y1:
            cut = top if cut is None else min(cut, top)

    if cut is None:
        return rect
    trimmed = fitz.Rect(rect)
    # A small gap, so the figure's own lowest stroke is not clipped.
    trimmed.y1 = max(rect.y0 + 24, cut - 4)
    return trimmed


def _primitives(page: fitz.Page) -> list[fitz.Rect]:
    """The page's drawn shapes, hairlines and the page border left out."""
    try:
        drawings = page.get_drawings()
    except Exception:  # noqa: BLE001
        return []
    page_area = max(_area(page.rect), 1.0)
    kept: list[fitz.Rect] = []
    for drawing in drawings:
        rect = fitz.Rect(drawing["rect"])
        area = _area(rect)
        # Skip hairlines and rules at one end, the page border at the other.
        if area > 120 and area / page_area < 0.95:
            kept.append(rect)
    return kept


def regions_page(
    page: fitz.Page, exclude: list[tuple[float, float, float, float]] | None = None
) -> list[tuple[str, fitz.Rect]]:
    """Where this page's figures are, in reading order, rendering none of them.

    Kept apart from `extract_page` because the section tree has to be told where
    the pictures are *before* it is cut, and rendering is the expensive half.
    See `label_regions` for what the section tree is actually given.
    """
    exclusions = [fitz.Rect(*b) for b in (exclude or [])]
    page_rect = page.rect
    kept: list[tuple[str, fitz.Rect]] = []

    def blocked(rect: fitz.Rect) -> bool:
        for other in exclusions + [taken for _, taken in kept]:
            overlap = _area(rect & other)
            if overlap and overlap / max(_area(rect), 1.0) > 0.5:
                return True
        return False

    def keep(rect: fitz.Rect, kind: str) -> None:
        clipped = rect & page_rect
        if not _plausible(clipped, page_rect) or blocked(clipped):
            return
        kept.append((kind, clipped))

    # Embedded rasters first — they are unambiguous, and claiming their area
    # stops the vector pass from re-rendering the same region.
    for image in page.get_images(full=True):
        xref = image[0]
        try:
            rects = page.get_image_rects(xref)
        except Exception:  # noqa: BLE001
            continue
        for rect in rects:
            keep(fitz.Rect(rect), "raster")

    # Then vector drawings, which is where diagrams with no text layer live.
    for cluster in _cluster(_primitives(page)):
        # Cut at the next numbered heading: a cluster that chained body-text
        # rules together would otherwise crop the following section as though
        # it were part of the diagram.
        keep(_stop_at_next_heading(page, cluster), "vector")

    kept.sort(key=lambda item: item[1].y0)
    return kept


def extract_page(
    page: fitz.Page, exclude: list[tuple[float, float, float, float]] | None = None
) -> list[Figure]:
    page_rect = page.rect

    def complexity_of(rect: fitz.Rect, kind: str) -> int:
        """How risky this figure is to trust a model's reading of.

        Counted from the page's own structures — cheap and deterministic. Labels
        count double: a diagram's difficulty tracks the number of small text runs
        a model has to read and associate, more than the number of boxes.

        A raster gets a floor instead, and a high one. Counting page structures
        inside an embedded image returns zero, because there are none — which
        scored the single hardest case in the sample corpus, a context diagram
        with no text layer at all, as the *safest* thing in the document. Exactly
        backwards: an opaque image is the case where nothing but the vision model
        can check the reading, so it is the one most worth a human's eye.
        """
        score = 0
        try:
            for drawing in page.get_drawings():
                if rect.intersects(fitz.Rect(drawing["rect"])):
                    score += 1
        except Exception:  # noqa: BLE001
            pass
        try:
            for block in page.get_text("blocks"):
                if rect.intersects(fitz.Rect(block[:4])) and str(block[4]).strip():
                    score += 2
        except Exception:  # noqa: BLE001
            pass

        if kind == "raster" and score == 0:
            # Scale with how much of the page it occupies: a full-width diagram
            # carries more unverifiable claim than a small logo.
            share = _area(rect) / max(_area(page_rect), 1.0)
            return 50 + int(min(share, 1.0) * 50)
        return score

    return [
        Figure(
            page=page.number + 1,
            bbox=(rect.x0, rect.y0, rect.x1, rect.y1),
            png=page.get_pixmap(clip=rect, dpi=_RENDER_DPI).tobytes("png"),
            caption=_caption_for(page, rect),
            kind=kind,
            complexity=complexity_of(rect, kind),
        )
        for kind, rect in regions_page(page, exclude)
    ]


BoxesByPage = dict[int, list[tuple[float, float, float, float]]]


def label_regions_page(
    page: fitz.Page, exclude: list[tuple[float, float, float, float]] | None = None
) -> list[tuple[float, float, float, float]]:
    """The shapes a diagram's own labels sit inside, on one page.

    Not the figure outlines, for two reasons, and they pull in opposite
    directions — which is why this asks its own question rather than reusing
    `regions_page`. "Is this text inside something drawn?" is not "is this
    drawing worth rendering for a reviewer?".

    Too wide: a vector figure's outline is a cluster grown by proximity, and on
    a page mixing a diagram with shaded prose it reaches far past the diagram —
    page 3 of one sample runs 50–632 of an 842pt page and would take a real
    "Leg-by-leg classification" subsection with it. The shapes the diagram is
    drawn from stop where the drawing does, and that heading sits in open space
    between two of them.

    Too narrow: `_plausible` holds a figure to 60pt in each direction, because
    anything smaller is a logo or a rule as far as rendering goes. A single row
    of boxes is 45pt tall, so a one-row sketch is no figure at all and its
    labels would keep opening sections.

    So the clustering is borrowed and the size test is not. A cluster of at
    least `_MIN_DRAWN_SHAPES` shapes is a drawing, and the shapes in it are
    where its labels sit. One shaded band behind a paragraph is not a drawing,
    and the words in it are prose. An embedded raster contributes all of itself,
    since nothing inside a picture can be read as structure.
    """
    exclusions = [fitz.Rect(*b) for b in (exclude or [])]
    primitives = _primitives(page)

    def on_a_table(rect: fitz.Rect) -> bool:
        return any(_area(rect & other) / max(_area(rect), 1.0) > 0.5 for other in exclusions)

    boxes = [rect for kind, rect in regions_page(page, exclude) if kind == "raster"]
    for cluster in _cluster(primitives):
        held = [rect for rect in primitives if cluster.contains(rect)]
        if len(held) < _MIN_DRAWN_SHAPES:
            continue
        boxes.extend(rect for rect in held if not on_a_table(rect))
    return [(rect.x0, rect.y0, rect.x1, rect.y1) for rect in boxes]


def label_regions(doc: fitz.Document, exclude_by_page: BoxesByPage | None = None) -> BoxesByPage:
    """Where a line of text is a picture's own label rather than a heading.

    The parse stage asks for this before cutting the section tree and then
    extracts the figures themselves afterwards, so the drawings are read twice.
    It is page geometry either way — `get_drawings` and some rectangle
    arithmetic — and sharing one definition of where the pictures are matters
    more than saving that, because the two answers drifting apart would suppress
    a heading under a figure that no reviewer is ever shown.
    """
    exclude_by_page = exclude_by_page or {}
    found: BoxesByPage = {}
    for index in range(doc.page_count):
        page_number = index + 1
        boxes = label_regions_page(doc[index], exclude_by_page.get(page_number))
        if boxes:
            found[page_number] = boxes
    return found


def extract(doc: fitz.Document, exclude_by_page: BoxesByPage | None = None) -> list[Figure]:
    exclude_by_page = exclude_by_page or {}
    figures: list[Figure] = []
    for index in range(doc.page_count):
        page = doc[index]
        figures.extend(extract_page(page, exclude_by_page.get(index + 1)))
    return figures
