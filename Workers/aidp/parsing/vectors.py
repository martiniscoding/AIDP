"""Office vector images, rasterised so a diagram is not lost with its format.

EMF and WMF are what Word and PowerPoint write when a drawing is pasted in from
Visio, from another Office document, or from the clipboard. They are vector
formats, and no Python library in this pipeline can draw one — so until now an
architecture diagram arriving that way was counted, reported and dropped.

On a Solution Architecture Blueprint that is the whole architecture. One real
submission lost its C1 context diagram, its C2 container diagram, its data model
and its network zoning that way, and four sections of the parse came out empty
because of it. The text and the tables were perfect; the thing the document
exists to communicate was gone.

LibreOffice can draw them, and it is already installed in this image for the
deck path (see slide_render.py). So this does what that module does, one image
at a time rather than a whole deck: convert to PDF, which keeps the drawing
vector, then let PyMuPDF render it at the resolution every other figure is
rendered at. The PNG then goes the way every figure goes — stored, described by
the vision model, shown on the parsed page.

Two details worth the lines they cost:

  * **The page is trimmed.** LibreOffice centres the drawing on an A4 page, and
    a diagram floating in half a page of white is a diagram a vision model reads
    worse and a reviewer squints at. The ink is found on a cheap thumbnail and
    the real render is clipped to it.
  * **Nothing here raises.** A document is never refused because a picture
    inside it could not be developed; the caller counts the failure and the
    parse reports it, exactly as before this module existed.
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile

import fitz

# Matches figures._RENDER_DPI and slide_render.RENDER_DPI. A figure's resolution
# should not depend on which door it came through.
RENDER_DPI = 170

# One drawing, not a deck. Long enough for the 2 MB network diagram in the
# sample corpus on a busy container, short enough that a stuck LibreOffice
# cannot hold a parse lease.
TIMEOUT_SECONDS = 120

# Past this many in one document, stop converting and let the rest be counted
# as undecodable. A document with forty pasted drawings is a slide deck in
# disguise, and two minutes of LibreOffice is already generous.
MAX_PER_DOCUMENT = 40

# Found on a thumbnail this many times smaller than the real render. Cheap
# enough to throw away, accurate enough to clip by.
_PROBE_DPI = 36

# Points of white left around the ink, so nothing sits flush against the edge.
_MARGIN = 6

# Anything paler than this on every channel is page, not drawing.
_WHITE = 248


def binary() -> str | None:
    """LibreOffice's command, or None when it is not installed."""
    return shutil.which("soffice") or shutil.which("libreoffice")


def kind(blob: bytes) -> str | None:
    """"emf", "wmf", or None — sniffed from the bytes rather than a filename.

    The deck path has the image's bytes and not its name, and a content type
    from a .pptx is not to be trusted: Office writes `image/x-emf` and
    `image/x-wmf` and occasionally neither.
    """
    if len(blob) >= 44 and blob[:4] == b"\x01\x00\x00\x00" and blob[40:44] == b" EMF":
        return "emf"
    # Placeable WMF carries Aldus' magic; the bare form starts with its header.
    if blob[:4] == b"\xd7\xcd\xc6\x9a":
        return "wmf"
    if blob[:4] in (b"\x01\x00\x09\x00", b"\x02\x00\x09\x00"):
        return "wmf"
    return None


def _ink(page: fitz.Page) -> fitz.Rect | None:
    """The drawing's own bounds on the page LibreOffice centred it on.

    Measured on a thumbnail, in pixels, then mapped back to page points. Done
    this way rather than from `page.get_drawings()` because an EMF out of Visio
    paints a white background rectangle over the whole page first — by that
    measure every one of them fills the sheet exactly.
    """
    probe = page.get_pixmap(dpi=_PROBE_DPI, alpha=False)
    width, height, n = probe.width, probe.height, probe.n
    data = probe.samples

    left, top = width, height
    right = bottom = -1
    for y in range(height):
        row = y * probe.stride
        for x in range(width):
            at = row + x * n
            if data[at] < _WHITE or data[at + 1] < _WHITE or data[at + 2] < _WHITE:
                if x < left:
                    left = x
                if x > right:
                    right = x
                if y < top:
                    top = y
                if y > bottom:
                    bottom = y
    if right < 0:
        return None  # A blank page. Nothing to clip to, and nothing worth keeping.

    scale = 72.0 / _PROBE_DPI
    rect = fitz.Rect(
        left * scale - _MARGIN,
        top * scale - _MARGIN,
        (right + 1) * scale + _MARGIN,
        (bottom + 1) * scale + _MARGIN,
    )
    return rect & page.rect


def rasterise(blob: bytes) -> bytes | None:
    """A PNG of one EMF or WMF, or None if it could not be drawn.

    None covers every failure there is — not a vector image, LibreOffice absent,
    LibreOffice refused it, it took too long, the PDF held nothing. The caller
    treats all of them the same way it treated every such image before: counted
    and reported, never fatal.
    """
    suffix = kind(blob)
    if suffix is None:
        return None
    command = binary()
    if command is None:
        return None

    with tempfile.TemporaryDirectory(prefix="aidp-vector-") as work:
        folder = pathlib.Path(work)
        source = folder / f"drawing.{suffix}"
        source.write_bytes(blob)
        try:
            result = subprocess.run(
                [
                    command,
                    # Its own profile, for the reason slide_render gives: two
                    # workers converting at once would otherwise fight over one
                    # and the loser would silently produce nothing.
                    f"-env:UserInstallation=file://{folder / 'profile'}",
                    "--headless",
                    "--norestore",
                    "--nologo",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(folder),
                    str(source),
                ],
                capture_output=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None

        pdf = folder / "drawing.pdf"
        if result.returncode != 0 or not pdf.exists():
            return None

        try:
            with fitz.open(pdf) as document:
                if document.page_count < 1:
                    return None
                page = document[0]
                clip = _ink(page)
                if clip is None or clip.is_empty:
                    return None
                return page.get_pixmap(dpi=RENDER_DPI, clip=clip, alpha=False).tobytes("png")
        except Exception:  # noqa: BLE001 — a drawing we cannot open is one we lose, not a failure
            return None
