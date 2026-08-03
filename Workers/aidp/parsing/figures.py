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


def extract_page(
    page: fitz.Page, exclude: list[tuple[float, float, float, float]] | None = None
) -> list[Figure]:
    exclusions = [fitz.Rect(*b) for b in (exclude or [])]
    page_rect = page.rect
    found: list[Figure] = []
    taken: list[fitz.Rect] = []

    def blocked(rect: fitz.Rect) -> bool:
        for other in exclusions + taken:
            overlap = _area(rect & other)
            if overlap and overlap / max(_area(rect), 1.0) > 0.5:
                return True
        return False

    def render(rect: fitz.Rect, kind: str) -> None:
        clipped = rect & page_rect
        if not _plausible(clipped, page_rect) or blocked(clipped):
            return
        pixmap = page.get_pixmap(clip=clipped, dpi=_RENDER_DPI)
        found.append(
            Figure(
                page=page.number + 1,
                bbox=(clipped.x0, clipped.y0, clipped.x1, clipped.y1),
                png=pixmap.tobytes("png"),
                caption=_caption_for(page, clipped),
                kind=kind,
            )
        )
        taken.append(clipped)

    # Embedded rasters first — they are unambiguous, and claiming their area
    # stops the vector pass from re-rendering the same region.
    for image in page.get_images(full=True):
        xref = image[0]
        try:
            rects = page.get_image_rects(xref)
        except Exception:  # noqa: BLE001
            continue
        for rect in rects:
            render(fitz.Rect(rect), "raster")

    # Then vector drawings, which is where diagrams with no text layer live.
    try:
        drawings = page.get_drawings()
    except Exception:  # noqa: BLE001
        drawings = []
    page_area = max(_area(page_rect), 1.0)
    primitives = []
    for drawing in drawings:
        rect = fitz.Rect(drawing["rect"])
        area = _area(rect)
        # Skip hairlines and rules at one end, the page border at the other.
        if area > 120 and area / page_area < 0.95:
            primitives.append(rect)
    for cluster in _cluster(primitives):
        render(cluster, "vector")

    found.sort(key=lambda f: f.bbox[1])
    return found


BoxesByPage = dict[int, list[tuple[float, float, float, float]]]


def extract(doc: fitz.Document, exclude_by_page: BoxesByPage | None = None) -> list[Figure]:
    exclude_by_page = exclude_by_page or {}
    figures: list[Figure] = []
    for index in range(doc.page_count):
        page = doc[index]
        figures.extend(extract_page(page, exclude_by_page.get(index + 1)))
    return figures
