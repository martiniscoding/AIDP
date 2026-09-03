"""Smoke test for the slide path — no database, no network.

Builds a deck carrying the things that actually go wrong in one, then runs the
adapter and the structure pass over it and asserts on the result:

  · a title added after the body it introduces          → still read first,
    because shape order in the file is z-order, not reading order
  · a footer and a slide number placeholder             → dropped as furniture,
    named by PowerPoint rather than guessed at
  · nested bullets                                      → outline depth kept and
    carried into the hint as L1/L2
  · grouped shapes                                      → flattened, not skipped
  · speaker notes                                       → kept, tagged as notes
  · a table on a slide                                  → rows emitted as text
  · a logo on every slide and one large diagram         → the logo filtered out,
    the diagram kept and converted to PNG
  · a JPEG-encoded picture                              → re-encoded, because
    everything downstream stores and sends `image/png`

The model is stubbed. What is being tested is that the deck reaches it in the
right order with the right tags, and that its markers come back as clauses —
not the model's judgement, which no assertion here could pin down.

Run inside the worker image, which already has python-pptx and PyMuPDF:

    docker run --rm -v "$PWD":/w -w /w aidp-worker:dev \
        python scripts/smoke_slides.py
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import fitz
from pptx import Presentation
from pptx.util import Inches, Pt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aidp.ai import llm  # noqa: E402
from aidp.parsing import ai_structure, slides  # noqa: E402

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  {'PASS' if condition else 'FAIL'}  {label}{f'  — {detail}' if detail else ''}")
    if not condition:
        failures.append(label)


def _image(width: int, height: int, colour: tuple[int, int, int], fmt: str = "png") -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, width, height))
    pix.set_rect(pix.irect, colour)
    return pix.tobytes(fmt)


def build_deck() -> bytes:
    prs = Presentation()
    content = prs.slide_layouts[1]
    blank = prs.slide_layouts[6]
    logo = _image(60, 60, (200, 30, 30))
    diagram = _image(900, 600, (20, 80, 160))
    photo = _image(700, 500, (90, 160, 90), "jpg")

    # 1 — a normal clause slide, with nested bullets and a rationale in the notes.
    one = prs.slides.add_slide(content)
    one.shapes.title.text = "Encryption at Rest"
    body = one.placeholders[1].text_frame
    body.text = "All data at rest must be encrypted using organisation-managed keys."
    nested = body.add_paragraph()
    nested.text = "Keys are rotated every 90 days."
    nested.level = 1
    deeper = body.add_paragraph()
    deeper.text = "Rotation is evidenced in the key management log."
    deeper.level = 2
    one.notes_slide.notes_text_frame.text = (
        "A stolen disk must not become a reportable breach."
    )

    # 2 — body added before the title, plus a table and a grouped pair of boxes.
    two = prs.slides.add_slide(blank)
    late_body = two.shapes.add_textbox(Inches(1), Inches(3), Inches(6), Inches(1))
    late_body.text_frame.text = "Production workloads must sit in a dedicated VPC."
    title_box = two.shapes.add_textbox(Inches(1), Inches(0.4), Inches(6), Inches(1))
    title_box.text_frame.text = "Network Segmentation"
    title_box.text_frame.paragraphs[0].runs[0].font.size = Pt(32)

    table = two.shapes.add_table(2, 2, Inches(1), Inches(4.5), Inches(4), Inches(1)).table
    table.cell(0, 0).text = "Zone"
    table.cell(0, 1).text = "Egress"
    table.cell(1, 0).text = "Production"
    table.cell(1, 1).text = "Denied by default"

    group = two.shapes.add_group_shape()
    for offset, text in enumerate(("Grouped callout one", "Grouped callout two")):
        box = group.shapes.add_textbox(
            Inches(7), Inches(2 + offset), Inches(2.5), Inches(0.6)
        )
        box.text_frame.text = text

    # 3 — the diagram worth describing, and a JPEG that must be re-encoded.
    three = prs.slides.add_slide(blank)
    heading = three.shapes.add_textbox(Inches(1), Inches(0.4), Inches(6), Inches(1))
    heading.text_frame.text = "Reference Architecture"
    heading.text_frame.paragraphs[0].runs[0].font.size = Pt(32)
    three.shapes.add_picture(io.BytesIO(diagram), Inches(1), Inches(2), Inches(6), Inches(4))

    four = prs.slides.add_slide(blank)
    caption = four.shapes.add_textbox(Inches(1), Inches(0.4), Inches(6), Inches(1))
    caption.text_frame.text = "Data Centre Estate"
    four.shapes.add_picture(io.BytesIO(photo), Inches(1), Inches(2), Inches(6), Inches(4))

    # Branding on every slide, at logo size.
    for slide in prs.slides:
        slide.shapes.add_picture(
            io.BytesIO(logo), Inches(8.6), Inches(0.2), Inches(0.5), Inches(0.5)
        )

    buffer = io.BytesIO()
    prs.save(buffer)
    return buffer.getvalue()


def stub_model(seen: dict) -> None:
    """Mark every [title]-tagged line a heading and every other body line a rule."""

    def structure(*, numbered: str, first_line: int, last_line: int, tags: str = "") -> dict:
        seen["tags"] = tags
        seen.setdefault("windows", []).append(numbered)
        markers = []
        for row in numbered.split("\n"):
            index = int(row.split(":", 1)[0])
            if "[title]" in row or "[text]" in row:
                markers.append({"line": index, "role": "heading"})
            elif "[notes]" in row:
                markers.append({"line": index, "role": "rationale"})
            elif "L1" in row or "L2" in row:
                markers.append({"line": index, "role": "requirement"})
            elif "[body]" in row:
                markers.append({"line": index, "role": "statement"})
        return {"markers": markers}

    llm.structure = structure
    llm.available = lambda: True


def stub_model_starting_late(skip: int) -> None:
    """As above, but blind to the first `skip` headings.

    What a model reading a deck actually does when the opening slides carry no
    obvious heading: it starts marking partway down. Everything before the
    first mark used to be discarded, and on a deck that is the title slide and
    the agenda — the two slides that say what the deck is comparing and why.
    """
    marked = {"n": 0}

    def structure(*, numbered: str, first_line: int, last_line: int, tags: str = "") -> dict:
        markers = []
        for row in numbered.split("\n"):
            index = int(row.split(":", 1)[0])
            if "[title]" in row or "[text]" in row:
                marked["n"] += 1
                if marked["n"] <= skip:
                    continue
                markers.append({"line": index, "role": "heading"})
        return {"markers": markers}

    llm.structure = structure
    llm.available = lambda: True


def main() -> int:
    raw = build_deck()
    deck = slides.read(raw)
    tag_of = {index: deck.hints.get(index, "") for index in range(len(deck.lines))}
    texts = [line.text for line in deck.lines]

    print("Lines")
    check("every slide contributed", deck.slide_count == 4, f"{deck.slide_count} slides")
    check("deck title read off slide one", deck.title == "Encryption at Rest", str(deck.title))
    check(
        "no footer or slide number survived",
        not any("Page" in t or t.strip().isdigit() for t in texts),
    )

    print("\nReading order")
    seg_title = texts.index("Network Segmentation")
    seg_body = texts.index("Production workloads must sit in a dedicated VPC.")
    check("late-added title still comes first", seg_title < seg_body, f"{seg_title} < {seg_body}")
    check("grouped shapes flattened in", "Grouped callout one" in texts)
    check("both group members present", "Grouped callout two" in texts)

    print("\nTags")
    check("slide title tagged", tag_of[texts.index("Encryption at Rest")] == "title")
    check(
        "outline depth kept",
        tag_of[texts.index("Keys are rotated every 90 days.")] == "body L1",
        tag_of[texts.index("Keys are rotated every 90 days.")],
    )
    check(
        "second level kept",
        tag_of[texts.index("Rotation is evidenced in the key management log.")] == "body L2",
    )
    notes = "A stolen disk must not become a reportable breach."
    check("speaker notes kept", notes in texts and tag_of[texts.index(notes)] == "notes")
    check("table rows kept", "Zone | Egress" in texts)
    check("table rows tagged", tag_of[texts.index("Zone | Egress")] == "table")

    print("\nFigures")
    pages = sorted(figure.page for figure in deck.figures)
    check("logo on every slide filtered out", len(deck.figures) == 2, str(pages))
    check("the diagram was kept", 3 in pages)
    check("the JPEG was kept", 4 in pages)
    check(
        "everything stored is PNG",
        all(figure.png[:8] == b"\x89PNG\r\n\x1a\n" for figure in deck.figures),
    )
    check("nothing undecodable", deck.undecodable_images == 0)

    print("\nStructure pass")
    seen: dict = {}
    stub_model(seen)
    read = ai_structure.structure(deck.lines, document_title="Deck", hints=deck.hints)
    window = seen["windows"][0]
    check("tag note reached the prompt", "[tag]" in seen["tags"])
    check("lines carry their tag", "[title] Encryption at Rest" in window)
    check("untagged lines are not invented", "[] " not in window)
    check("sections built", len(read.sections) >= 3, str([s.title for s in read.sections]))

    first = read.clauses.get(0, [])
    check("clause built from slide one", bool(first))
    if first:
        clause = first[0]
        check(
            "statement is the slide's rule",
            clause.statement.startswith("All data at rest"),
            clause.statement[:60],
        )
        check("nested bullets became requirements", len(clause.requirements) == 2)
        check("notes became the rationale", clause.rationale.startswith("A stolen disk"))

    print("\nSafety")
    check("no line index outside the deck", all(i < len(deck.lines) for i in read.disputed_lines))
    sliced = " ".join(c.statement for group in read.clauses.values() for c in group)
    check("clause text came from the deck, not the model", "[title]" not in sliced)

    print("\nNothing before the first heading is thrown away")
    stub_model_starting_late(2)
    late = ai_structure.structure(deck.lines, document_title="Deck", hints=deck.hints)

    # Every section's own heading, plus every line under it. Anything in the
    # deck that appears in neither was discarded.
    kept = {section.title for section in late.sections}
    kept |= {line.text for section in late.sections for line in section.lines}
    lost = [line.text for line in deck.lines if line.text.strip() and line.text not in kept]

    check("the late start is reported", bool(late.orphan_lines))
    check("but no line is dropped", not lost, lost[:3])
    check("the deck's opening is indexed", deck.lines[0].text in kept)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
