"""Drawings pasted out of Office, rasterised rather than lost.

EMF and WMF are what Word and PowerPoint write when a diagram is pasted in from
Visio or another document. Nothing in Python here can draw one, so until
aidp/parsing/vectors.py they were counted and dropped — and on a Solution
Architecture Blueprint the dropped thing is the architecture. One real
submission lost its context diagram, its container diagram, its data model and
its network zoning that way, and four sections parsed empty because of it.

What this proves is the part that fails silently. A sniffer that says "wmf" to
a PNG would send every photograph through LibreOffice; one that says None to a
real EMF would lose the diagram exactly as before, with no error either way.
And a rasteriser that raises would take a whole document down for the sake of
one picture.

The conversion itself needs LibreOffice, which lives in the parse image rather
than the test image, so those checks skip where it is absent and say so:

    docker run --rm -v "$PWD":/w -w /w --entrypoint python \
      workers-parse tests/test_vector_images.py
"""

from __future__ import annotations

import pathlib
import struct
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp.parsing import vectors  # noqa: E402

passed = failed = skipped = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


def skip(name: str, why: str) -> None:
    global skipped
    skipped += 1
    print(f"  skip {name} — {why}")


# An EMF header: its record type, then the signature at byte 40. Enough of one
# for the sniffer; not enough to draw, which is the point of keeping the two
# apart.
EMF_HEAD = b"\x01\x00\x00\x00" + b"\x00" * 36 + b" EMF" + b"\x00" * 16
WMF_PLACEABLE = b"\xd7\xcd\xc6\x9a" + b"\x00" * 40
WMF_BARE = b"\x01\x00\x09\x00" + b"\x00" * 40
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


# ---------------------------------------------------------------------------
print("\n1. What is a drawing and what is a photograph")

ok("an EMF is recognised", vectors.kind(EMF_HEAD) == "emf")
ok("a placeable WMF is", vectors.kind(WMF_PLACEABLE) == "wmf")
ok("and a bare one", vectors.kind(WMF_BARE) == "wmf")

# The expensive mistake in the other direction: every screenshot in every deck
# would be handed to LibreOffice, one subprocess at a time.
ok("a PNG is not", vectors.kind(PNG) is None)
ok("a JPEG is not", vectors.kind(JPEG) is None)
ok("neither is empty input", vectors.kind(b"") is None)
ok("nor something shorter than the header it would need", vectors.kind(b"\x01\x00\x00\x00") is None)

# The signature sits at byte 40, so a file that merely opens like one is not an
# EMF — and reading past the end of a short file must not raise.
ok("nor a file that only starts like one", vectors.kind(b"\x01\x00\x00\x00" + b"\x00" * 60) is None)

ok("a non-vector image is refused without calling LibreOffice", vectors.rasterise(PNG) is None)


# ---------------------------------------------------------------------------
print("\n2. Drawing one")

if vectors.binary() is None:
    skip("an EMF becomes a PNG", "LibreOffice is not in this image")
    skip("the page's white margin is trimmed off", "LibreOffice is not in this image")
    skip("a corrupt drawing is lost, not fatal", "LibreOffice is not in this image")
else:
    sample = pathlib.Path(__file__).resolve().parent / "fixtures" / "diagram.emf"
    if not sample.exists():
        skip("an EMF becomes a PNG", f"no fixture at {sample}")
        skip("the page's white margin is trimmed off", "no fixture")
    else:
        png = vectors.rasterise(sample.read_bytes())
        ok("an EMF becomes a PNG", png is not None and png[:8] == b"\x89PNG\r\n\x1a\n")
        if png:
            width, height = struct.unpack(">II", png[16:24])
            print(f"       {width}x{height}, {len(png):,} bytes")
            ok("with pixels in it", width > 100 and height > 100, (width, height))
            # LibreOffice centres a drawing on A4 and renders at 170 DPI, which
            # is 1406x1988. Anything that size has not been trimmed, and a
            # diagram adrift in half a page of white is one a vision model
            # reads worse and a reviewer squints at.
            ok("the page's white margin is trimmed off", (width, height) != (1406, 1988), (width, height))

    # A header the sniffer believes and LibreOffice cannot open. The document
    # must survive it: this returns None and the caller counts it, which is
    # exactly what happened to every such image before this module existed.
    ok("a corrupt drawing is lost, not fatal", vectors.rasterise(EMF_HEAD) is None)


print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
sys.exit(1 if failed else 0)
