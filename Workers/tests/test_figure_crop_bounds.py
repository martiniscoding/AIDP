"""A figure crop must not carry the next section into the review panel.

On page 26 of a real 28-page architecture document, one detected "figure"
spanned the whole page — y 72 to 792 of a 792pt page. Its crop was rendered
beside a finding, so a reviewer was shown the document's `7 Acknowledgements`
section and the page number as though they were part of a diagram.

The cause is that vector clusters grow by proximity, and `_CLUSTER_GAP` is wide
enough to chain the rules and underlines of ordinary body text together down a
page. A numbered heading is the one landmark that reliably means the figure is
over — a caption is not, since many figures have none, and a blank band is not,
since a diagram may contain several — so a cluster is now cut at the first
numbered heading below its top.

Checked against the real file rather than a synthetic page, because the geometry
is the whole point and a fabricated page would prove nothing about it. The test
skips if that document is not present.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_figure_crop_bounds.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


try:
    import fitz
except ImportError:  # pragma: no cover
    print("  .... skipped — pymupdf not installed")
    sys.exit(0)

from aidp.parsing import figures  # noqa: E402


# ---------------------------------------------------------------------------
print("\n1. A cluster is cut at the heading that follows it")

# A page built to the shape that failed: a drawing at the top, then a numbered
# heading, then prose. Drawn with real strokes so the clusterer sees primitives.
doc = fitz.open()
page = doc.new_page()  # 612 x 792
page.draw_rect(fitz.Rect(80, 90, 520, 300), color=(0, 0, 0), width=1.5)
page.draw_line(fitz.Point(100, 150), fitz.Point(500, 150))
page.draw_circle(fitz.Point(300, 240), 40)
page.insert_text((72, 360), "7 Acknowledgements", fontsize=14)
page.insert_text((72, 400), "The team would like to thank their sponsors.", fontsize=11)
page.insert_text((72, 430), "Further prose that is not part of any figure.", fontsize=11)

rects = [fitz.Rect(d["rect"]) for d in page.get_drawings()]
cluster = rects[0]
for r in rects[1:]:
    cluster = cluster | r

# The bug is a cluster that has ALREADY over-extended past the heading, which
# is what proximity chaining produces on a real page. Simulated directly, since
# reproducing the chaining needs a page of underlined body text.
over = fitz.Rect(cluster.x0, cluster.y0, cluster.x1, 700.0)
trimmed = figures._stop_at_next_heading(page, over)
ok("the trim shrinks an over-extended box", trimmed.y1 < over.y1, (over.y1, trimmed.y1))
ok("it stops above the heading", trimmed.y1 < 360, trimmed.y1)
ok("and keeps the drawing itself", trimmed.y1 > 290, trimmed.y1)
ok("the top is untouched", trimmed.y0 == over.y0, (over.y0, trimmed.y0))

# A figure with nothing below it keeps its full height.
clean = fitz.open()
lone = clean.new_page()
lone.draw_rect(fitz.Rect(80, 90, 520, 700), color=(0, 0, 0), width=1.5)
only = fitz.Rect(lone.get_drawings()[0]["rect"])
ok(
    "a figure with no heading under it is left alone",
    figures._stop_at_next_heading(lone, only).y1 == only.y1,
)
clean.close()

# Unnumbered prose is not a heading, so it must not cut anything.
plain = fitz.open()
pp = plain.new_page()
pp.draw_rect(fitz.Rect(80, 90, 520, 300), color=(0, 0, 0), width=1.5)
pp.insert_text((72, 360), "Acknowledgements without a number", fontsize=14)
box = fitz.Rect(pp.get_drawings()[0]["rect"])
ok(
    "an unnumbered line does not cut the crop",
    figures._stop_at_next_heading(pp, box).y1 == box.y1,
)
plain.close()
doc.close()


# ---------------------------------------------------------------------------
print("\n2. The real document that produced the bug")

REAL = pathlib.Path(r"C:\Users\PC\Downloads\SoftwareArchitectureDocumentation.pdf")
if not REAL.exists():
    print("  .... skipped — the source document is not on this machine")
else:
    d = fitz.open(REAL)
    found = figures.extract(d)
    page26 = [f for f in found if f.page == 26]
    ok("page 26 still yields a figure", len(page26) >= 1, len(page26))
    if page26:
        height = d[25].rect.height
        tallest = max(page26, key=lambda f: f.bbox[3] - f.bbox[1])
        share = (tallest.bbox[3] - tallest.bbox[1]) / height
        ok(
            "its crop no longer spans the whole page",
            share < 0.75,
            f"{share:.0%} of {height:.0f}pt",
        )
        # "7 Acknowledgements" sits at y≈608 on that page.
        ok(
            "and stops above the Acknowledgements heading",
            tallest.bbox[3] < 608,
            tallest.bbox[3],
        )
    # Nothing else regressed: the document still yields its diagrams.
    ok("the document's figures are still found", len(found) >= 30, len(found))
    d.close()


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
