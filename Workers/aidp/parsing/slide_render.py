"""Pictures of slides whose diagrams are drawn in PowerPoint's own shapes.

A deck's architecture slide is usually not a picture at all. It is fifty boxes,
twenty arrows and a dozen text boxes laid out by hand — the LCL proposal's
"Proposed Logical Architecture" is exactly that. python-pptx reads the words in
those boxes, so the labels reach the index, but nothing in the library can draw
the slide, and the arrows — which box talks to which — are lost. On a design
review those arrows are the architecture.

So a slide that is a drawn diagram is photographed: LibreOffice, headless and
inside this container, turns the deck into a PDF with one page per slide, and
PyMuPDF renders the pages wanted to PNG, which then goes the way every other
figure goes — stored, described by the vision model, shown on the parsed page.
The deck itself is still read as a deck (slides.py); the PDF exists only for the
length of this call, to take the pictures.

Page numbers must mean slide numbers, or the picture of slide 15 would be filed
as slide 14. LibreOffice leaves hidden slides out of a PDF by default, which
shifts every later page, so they are exported too, and a PDF whose page count is
not the deck's slide count is refused rather than trusted.

Everything here fails by raising `RenderFailed` with a reason a person can act
on. The caller turns that into a note on the document; a deck is never refused
because a picture of it could not be taken.
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile

import fitz

# Long enough for a heavy deck on a busy container; short enough that a stuck
# LibreOffice cannot hold a parse lease for long.
TIMEOUT_SECONDS = 180

# The PDF path renders vector figures at this resolution (figures._RENDER_DPI),
# so a slide diagram reaches the vision model at the same detail.
RENDER_DPI = 170

# Export options for Impress's PDF filter, as the JSON form LibreOffice 7.4 and
# later accept after the filter name. Hidden slides keep their place, so page N
# is slide N.
_FILTER = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'


class RenderFailed(RuntimeError):
    """No pictures could be taken; the message says why."""


def binary() -> str | None:
    """LibreOffice's command, or None when it is not installed."""
    return shutil.which("soffice") or shutil.which("libreoffice")


def render(raw: bytes, slides: list[int], *, slide_count: int) -> dict[int, bytes]:
    """PNG pictures of the given slides of a .pptx, by slide number (from 1)."""
    if not slides:
        return {}
    command = binary()
    if command is None:
        raise RenderFailed("LibreOffice is not installed in this worker")

    with tempfile.TemporaryDirectory(prefix="aidp-slides-") as work:
        folder = pathlib.Path(work)
        source = folder / "deck.pptx"
        source.write_bytes(raw)
        try:
            result = subprocess.run(
                [
                    command,
                    # A profile of its own: two workers converting at once would
                    # otherwise fight over one, and the second would silently
                    # produce nothing.
                    f"-env:UserInstallation=file://{folder / 'profile'}",
                    "--headless",
                    "--norestore",
                    "--nologo",
                    "--convert-to",
                    _FILTER,
                    "--outdir",
                    str(folder),
                    str(source),
                ],
                capture_output=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RenderFailed(
                f"LibreOffice took longer than {TIMEOUT_SECONDS} seconds to convert the deck"
            ) from exc
        except OSError as exc:
            raise RenderFailed(f"LibreOffice could not be started: {exc}") from exc

        pdf = folder / "deck.pdf"
        if result.returncode != 0 or not pdf.exists():
            detail = (result.stderr or result.stdout or b"").decode("utf-8", "replace").strip()
            raise RenderFailed(
                f"LibreOffice could not convert the deck (exit {result.returncode})"
                + (f": {detail[:200]}" if detail else "")
            )

        document = fitz.open(pdf)
        try:
            if document.page_count != slide_count:
                raise RenderFailed(
                    f"the converted deck has {document.page_count} pages for {slide_count} "
                    "slides, so a page could not be matched to its slide"
                )
            pictures: dict[int, bytes] = {}
            for number in sorted(set(slides)):
                if 1 <= number <= document.page_count:
                    pixmap = document[number - 1].get_pixmap(dpi=RENDER_DPI, alpha=False)
                    pictures[number] = pixmap.tobytes("png")
            return pictures
        finally:
            document.close()
