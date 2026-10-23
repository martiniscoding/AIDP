"""A diagram submitted on its own: what is read from it, and what is withheld.

The brief asks for an architecture diagram as a first-class submission. A
diagram has no text, no headings and no tables, so nothing is detected — the
file *is* the figure, and `_parse_image` says so directly rather than converting
it to a PDF and hoping the figure extractor finds it again. (It would not:
`_plausible` drops anything covering more than 92% of its page, and a converted
image covers all of it. That is the bug this test would have shipped.)

What this proves:

  · an image of any supported format opens, and is rendered to one PNG the
    vision model can read, at a size worth paying for;
  · it produces exactly one section and one figure, so the figure has a heading
    path to be cited by and the chunk stage has something to turn into a chunk;
  · an image too small to be a diagram is refused with a sentence, rather than
    described as though a logo were an architecture;
  · a file that is not the format it claims fails with a message naming the
    format, not a stack trace;
  · the document carries the one thing a reviewer has to know before the report
    does — that everything here rests on a model's reading of a picture;
  · and no other format is now mistaken for an image.

No database, no model, no network: the parse stage's own function is called.

    python tests/test_image_submission.py
"""

from __future__ import annotations

import io
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pymupdf as fitz  # noqa: E402

from aidp.stages import parse  # noqa: E402

passed = 0
failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name}", extra)


def diagram(width: int = 1600, height: int = 900, fmt: str = "png") -> bytes:
    """An architecture-diagram-shaped image, drawn rather than fetched."""
    doc = fitz.open()
    page = doc.new_page(width=width / 2, height=height / 2)
    boxes = [
        (30, 30, 130, 70, "Portal"),
        (175, 30, 275, 70, "API"),
        (320, 30, 420, 70, "Billing"),
        (175, 120, 275, 160, "Sessions"),
    ]
    for x0, y0, x1, y1, label in boxes:
        page.draw_rect(fitz.Rect(x0, y0, x1, y1), color=(0.1, 0.1, 0.3), width=1)
        page.insert_textbox(fitz.Rect(x0 + 2, y0 + 12, x1 - 2, y1), label, fontsize=8)
    page.draw_line(fitz.Point(130, 50), fitz.Point(175, 50))
    # The page is half the requested size, so a scale of 2 lands on it exactly.
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2))
    doc.close()
    return pixmap.tobytes(fmt)


def beat() -> None:
    return None


print("\nAn ordinary diagram")

png = diagram()
result = parse._parse_image(png, {"mimeType": "image/png", "title": "Context Diagram"}, beat)

ok("it parses", result is not None)
ok("as one page", result.page_count == 1, result.page_count)
ok("with the profile recorded", result.profile == "image", result.profile)
ok("named after the document", result.title == "Context Diagram", result.title)

ok("one section", len(result.sections) == 1, len(result.sections))
section = result.sections[0]
ok("which a citation can print a path for", section.heading_path == "Context Diagram", section.heading_path)
ok("and which carries no text, because there is none", section.text == "", repr(section.text))

ok("one figure, hung on that section", list(result.figures) == [0], list(result.figures))
figure = result.figures[0][0]
ok("it is a raster", figure.kind == "raster", figure.kind)
ok("the bytes are a PNG whatever came in", figure.png[:8] == b"\x89PNG\r\n\x1a\n")
ok("and there are some", len(figure.png) > 1000, len(figure.png))
# The floor `complexity_of` gives an opaque raster, for the reason it gives: an
# image is the case where nothing but the vision model can check the reading.
ok("graded as needing a human's eye", figure.complexity >= 50, figure.complexity)

print("\nIt is rendered, not passed through")

big = diagram(width=4000, height=2250)
rendered = parse._parse_image(big, {"mimeType": "image/png", "title": "Big"}, beat)
shot = fitz.open(stream=rendered.figures[0][0].png, filetype="png")
edge = max(shot[0].rect.width, shot[0].rect.height)
shot.close()
ok(
    "a photograph-sized image is capped",
    edge <= parse._IMAGE_MAX_EDGE + 1,
    edge,
)

small = diagram(width=900, height=500)
kept = parse._parse_image(small, {"mimeType": "image/png", "title": "Small"}, beat)
shot = fitz.open(stream=kept.figures[0][0].png, filetype="png")
kept_edge = max(shot[0].rect.width, shot[0].rect.height)
shot.close()
# Never enlarged: scaling a small image up invents detail that was not there.
ok("but a smaller one is not enlarged", kept_edge <= 901, kept_edge)

print("\nOther formats of the same picture")

for fmt, mime in (("jpg", "image/jpeg"), ("jpeg", "image/jpeg")):
    try:
        raw = diagram(fmt=fmt)
    except Exception:  # noqa: BLE001 — not every build writes every format
        print(f"  SKIP {fmt} (this PyMuPDF build cannot write it)")
        continue
    out = parse._parse_image(raw, {"mimeType": mime, "title": f"A {fmt}"}, beat)
    ok(f"a {fmt} is read", len(out.figures[0]) == 1)
    ok(f"and comes out as PNG", out.figures[0][0].png[:8] == b"\x89PNG\r\n\x1a\n")

print("\nWhat is refused")

try:
    parse._parse_image(diagram(width=120, height=90), {"mimeType": "image/png", "title": "Icon"}, beat)
    ok("an image too small to be a diagram is refused", False, "it was accepted")
except RuntimeError as exc:
    ok("an image too small to be a diagram is refused", "too small" in str(exc), exc)
    ok("and the message says what to do instead", "Upload the diagram itself" in str(exc), exc)

try:
    parse._parse_image(b"this is not an image at all", {"mimeType": "image/png", "title": "Junk"}, beat)
    ok("a file that is not the format it claims fails", False, "it was accepted")
except RuntimeError as exc:
    ok("a file that is not the format it claims fails", "could not be opened" in str(exc), exc)
    ok("naming the format it was recorded as", "png" in str(exc), exc)

print("\nWhat the document says about itself")

kinds = [issue["kind"] for issue in result.issues]
ok("it raises one notice", kinds == ["image_only"], kinds)
detail = result.issues[0]["detail"]
ok(
    "saying the evidence is a reading of a picture",
    "a model's reading of a picture" in detail,
    detail,
)
ok(
    "and that settling verdicts is withheld on it",
    "withheld" in detail,
    detail,
)
ok("and what to do about that", "alongside it" in detail, detail)
# Not "high": this is a supported submission, not a broken one, and a high
# notice on every diagram would teach reviewers to skip the ones that matter.
ok("as a notice, not a fault", result.issues[0]["severity"] == "medium", result.issues[0]["severity"])

print("\nNo other format is mistaken for an image")

ok("a PDF is not", not parse._is_image({"mimeType": "application/pdf", "storageKey": "a/b.pdf"}))
ok("a Word document is not", not parse._is_image({"mimeType": parse._DOCX_MIME, "storageKey": "a/b.docx"}))
ok("a deck is not", not parse._is_image({"mimeType": parse._PPTX_MIME, "storageKey": "a/b.pptx"}))
ok("a workbook is not", not parse._is_image({"mimeType": parse._XLSX_MIME, "storageKey": "a/b.xlsx"}))
# And an image is, by either route, because a row written before images were
# supported carries the old hardcoded PDF default in `mimeType`.
ok("an image is, by type", parse._is_image({"mimeType": "image/webp", "storageKey": ""}))
ok("an image is, by key", parse._is_image({"mimeType": "application/pdf", "storageKey": "a/b.PNG"}))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
