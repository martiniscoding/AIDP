"""A small PDF typesetter, so the sample corpus looks like the real one.

The parser finds headings by typography, tables by ruled lines, and figures by
clustered vector drawings. A sample corpus written with a naive generator would
exercise none of that, so this lays out real page furniture, a dotted-leader
table of contents, ruled tables, and a diagram rasterised to strip its text
layer — which is the hardest figure case and the one the real corpus contains.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import fitz

# Matching the real corpus: a serif-free body with a navy heading scale.
BODY, BOLD, ITALIC = "helv", "hebo", "heit"

NAVY = (0.11, 0.20, 0.42)
BLACK = (0.08, 0.08, 0.09)
GREY = (0.42, 0.42, 0.45)
RULE = (0.72, 0.74, 0.78)
HEADER_FILL = (0.11, 0.20, 0.42)
BAND = (0.87, 0.87, 0.88)

MARGIN_X = 68.0
TOP = 92.0
BOTTOM = 754.0
WIDTH = 595.0
HEIGHT = 842.0
TEXT_W = WIDTH - 2 * MARGIN_X

SIZE = {"title": 26, "subtitle": 12, "h1": 16.5, "h2": 12.5, "body": 10, "small": 8.2}
LEADING = {"h1": 26, "h2": 20, "body": 14.2, "small": 11.5}


def wrap(text: str, font: str, size: float, width: float) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        current = ""
        for word in paragraph.split():
            trial = f"{current} {word}".strip()
            if fitz.get_text_length(trial, fontname=font, fontsize=size) <= width:
                current = trial
            else:
                if current:
                    lines.append(current)
                current = word
        lines.append(current)
    return lines


@dataclass
class Table:
    columns: list[str]
    rows: list[list[str]]
    caption: str | None = None
    widths: list[float] | None = None


@dataclass
class Clause:
    title: str
    statement: str
    rationale: str
    requirements: list[str]
    guidance: list[str] = field(default_factory=list)


class Builder:
    """Flowing layout with automatic page breaks and running furniture."""

    def __init__(self, running_title: str, classification: str) -> None:
        self.doc = fitz.open()
        self.running_title = running_title
        self.classification = classification
        self.page: fitz.Page | None = None
        self.y = TOP
        self.toc_entries: list[tuple[str, int, int]] = []  # (label, depth, page)

    # -- page management ----------------------------------------------------
    def new_page(self) -> fitz.Page:
        self.page = self.doc.new_page(width=WIDTH, height=HEIGHT)
        self.y = TOP
        return self.page

    def space(self, amount: float) -> None:
        self.y += amount

    def ensure(self, needed: float) -> None:
        if self.page is None or self.y + needed > BOTTOM:
            self.new_page()

    def finish(self) -> None:
        """Running header and footer on every content page.

        Written last so the page count is known. Roughly a hundred repetitions
        across a corpus this size — which is what furniture.py exists to strip,
        and where the sensitivity classification is read from.
        """
        # By index, not by held Page objects: inserting the contents page at
        # index 1 invalidates every reference taken before it, and a stale one
        # reports `number` as None rather than failing loudly.
        total = self.doc.page_count
        for index in range(total):
            page = self.doc[index]
            n = index + 1
            label = f"{self.running_title}   |   Page {n} of {total}"
            width = fitz.get_text_length(label, fontname=BODY, fontsize=SIZE["small"])
            page.insert_text(
                (WIDTH - MARGIN_X - width, 58), label, fontsize=SIZE["small"],
                fontname=BODY, color=GREY,
            )
            page.draw_line(
                fitz.Point(MARGIN_X, 68), fitz.Point(WIDTH - MARGIN_X, 68),
                color=RULE, width=0.6,
            )

            footer = f"SENSITIVITY CLASSIFICATION: {self.classification}"
            page.draw_rect(
                fitz.Rect(MARGIN_X, BOTTOM + 22, WIDTH - MARGIN_X, BOTTOM + 40),
                color=BAND, fill=BAND,
            )
            fw = fitz.get_text_length(footer, fontname=BODY, fontsize=SIZE["small"])
            page.insert_text(
                ((WIDTH - fw) / 2, BOTTOM + 34), footer,
                fontsize=SIZE["small"], fontname=BODY, color=BLACK,
            )

    # -- blocks -------------------------------------------------------------
    def cover(self, eyebrow: str, title: str, subtitle: str, code: str, effective: str) -> None:
        page = self.new_page()
        page.draw_rect(fitz.Rect(MARGIN_X - 14, 150, MARGIN_X - 10, 520), color=NAVY, fill=NAVY)
        page.insert_text((MARGIN_X, 300), eyebrow, fontsize=11.5, fontname=BODY, color=NAVY)
        page.insert_text((MARGIN_X, 344), title, fontsize=SIZE["title"], fontname=BOLD, color=BLACK)
        page.insert_text(
            (MARGIN_X, 372), subtitle, fontsize=SIZE["subtitle"], fontname=BODY, color=BLACK
        )
        page.insert_text((MARGIN_X, 410), code, fontsize=9.5, fontname=BODY, color=BLACK)
        page.insert_text(
            (MARGIN_X, 424), f"Effective Date: {effective}", fontsize=9.5,
            fontname=BODY, color=BLACK,
        )
        page.draw_rect(fitz.Rect(MARGIN_X, 444, WIDTH - MARGIN_X, 464), color=BAND, fill=BAND)
        page.insert_text(
            (MARGIN_X + 6, 458), f"SENSITIVITY CLASSIFICATION:  {self.classification}",
            fontsize=9, fontname=BOLD, color=BLACK,
        )
        self.y = BOTTOM

    def h1(self, number: str, text: str) -> None:
        self.ensure(72)
        label = f"{number} {text}".strip()
        self.space(10)
        self.page.insert_text(
            (MARGIN_X, self.y), label, fontsize=SIZE["h1"], fontname=BOLD, color=NAVY
        )
        self.y += 8
        self.page.draw_line(
            fitz.Point(MARGIN_X, self.y), fitz.Point(WIDTH - MARGIN_X, self.y),
            color=NAVY, width=1.1,
        )
        self.y += LEADING["h1"] - 8
        self.toc_entries.append((label, 1, self.page.number + 1))

    def h2(self, number: str, text: str) -> None:
        self.ensure(52)
        label = f"{number} {text}".strip()
        self.space(8)
        self.page.insert_text(
            (MARGIN_X, self.y), label, fontsize=SIZE["h2"], fontname=BOLD, color=BLACK
        )
        self.y += LEADING["h2"]
        self.toc_entries.append((label, 2, self.page.number + 1))

    def body(self, text: str, indent: float = 0.0) -> None:
        for line in wrap(text, BODY, SIZE["body"], TEXT_W - indent):
            self.ensure(LEADING["body"])
            self.page.insert_text(
                (MARGIN_X + indent, self.y), line, fontsize=SIZE["body"],
                fontname=BODY, color=BLACK,
            )
            self.y += LEADING["body"]

    def labelled(self, label: str, text: str) -> None:
        """`Statement: …` — bold label, regular body, sharing the first line.

        The real documents set them exactly this way, and it is what the clause
        parser keys on.
        """
        self.ensure(LEADING["body"] * 2)
        lead = f"{label}: "
        lead_w = fitz.get_text_length(lead, fontname=BOLD, fontsize=SIZE["body"])
        lines = wrap(text, BODY, SIZE["body"], TEXT_W - lead_w)

        self.page.insert_text(
            (MARGIN_X, self.y), lead, fontsize=SIZE["body"], fontname=BOLD, color=BLACK
        )
        self.page.insert_text(
            (MARGIN_X + lead_w, self.y), lines[0], fontsize=SIZE["body"],
            fontname=BODY, color=BLACK,
        )
        self.y += LEADING["body"]

        for line in wrap(" ".join(lines[1:]), BODY, SIZE["body"], TEXT_W) if lines[1:] else []:
            self.ensure(LEADING["body"])
            self.page.insert_text(
                (MARGIN_X, self.y), line, fontsize=SIZE["body"], fontname=BODY, color=BLACK
            )
            self.y += LEADING["body"]
        self.space(3)

    def bullets(self, items: list[str], label: str | None = None) -> None:
        if label:
            self.ensure(LEADING["body"])
            self.page.insert_text(
                (MARGIN_X, self.y), f"{label}:", fontsize=SIZE["body"],
                fontname=BOLD, color=BLACK,
            )
            self.y += LEADING["body"]
        for item in items:
            lines = wrap(item, BODY, SIZE["body"], TEXT_W - 22)
            for i, line in enumerate(lines):
                self.ensure(LEADING["body"])
                if i == 0:
                    self.page.insert_text(
                        (MARGIN_X + 8, self.y), "•", fontsize=SIZE["body"],
                        fontname=BODY, color=BLACK,
                    )
                self.page.insert_text(
                    (MARGIN_X + 22, self.y), line, fontsize=SIZE["body"],
                    fontname=BODY, color=BLACK,
                )
                self.y += LEADING["body"]
        self.space(4)

    def clause(self, clause: Clause) -> None:
        self.labelled("Statement", clause.statement)
        self.labelled("Rationale", clause.rationale)
        self.bullets(clause.requirements, "Requirements")
        if clause.guidance:
            self.ensure(LEADING["body"])
            self.page.insert_text(
                (MARGIN_X, self.y), "Applicable Patterns / Technology Guidance:",
                fontsize=SIZE["body"], fontname=ITALIC, color=BLACK,
            )
            self.y += LEADING["body"]
            self.bullets(clause.guidance)

    def table(self, spec: Table) -> None:
        """A ruled table. Empty cells stay empty — that is the point of one."""
        cols = spec.columns
        widths = spec.widths or [TEXT_W / len(cols)] * len(cols)
        scale = TEXT_W / sum(widths)
        widths = [w * scale for w in widths]
        xs = [MARGIN_X]
        for w in widths:
            xs.append(xs[-1] + w)

        def row_lines(cells: list[str], font: str) -> list[list[str]]:
            return [
                wrap(cell or "", font, SIZE["small"] + 0.4, widths[i] - 12)
                for i, cell in enumerate(cells)
            ]

        def emit(cells: list[str], header: bool) -> None:
            font = BOLD if header else BODY
            lines = row_lines(cells, font)
            height = max(len(cell) for cell in lines) * 12.4 + 9
            self.ensure(height + 4)
            top = self.y - 10
            if header:
                self.page.draw_rect(
                    fitz.Rect(xs[0], top, xs[-1], top + height),
                    color=HEADER_FILL, fill=HEADER_FILL,
                )
            for i, cell_lines in enumerate(lines):
                for j, line in enumerate(cell_lines):
                    self.page.insert_text(
                        (xs[i] + 6, self.y + j * 12.4),
                        line,
                        fontsize=SIZE["small"] + 0.4,
                        fontname=font,
                        color=(1, 1, 1) if header else BLACK,
                    )
            # Ruled on all four sides: find_tables() needs the grid.
            for x in xs:
                self.page.draw_line(
                    fitz.Point(x, top), fitz.Point(x, top + height), color=RULE, width=0.7
                )
            self.page.draw_line(
                fitz.Point(xs[0], top), fitz.Point(xs[-1], top), color=RULE, width=0.7
            )
            self.page.draw_line(
                fitz.Point(xs[0], top + height), fitz.Point(xs[-1], top + height),
                color=RULE, width=0.7,
            )
            self.y += height

        if spec.caption:
            self.body(spec.caption)
            self.space(2)
        self.space(12)
        emit(cols, header=True)
        for row in spec.rows:
            emit(row, header=False)
        self.space(14)

    def diagram(self, caption: str, boxes: list[tuple[str, list[str]]]) -> None:
        """A context diagram, rasterised so its labels leave no text layer.

        This is the hard figure case and the one the real corpus contains: the
        page carries the customer's whole application landscape and a text-only
        parser extracts nothing from it.
        """
        scratch = fitz.open()
        w, h = 900, 480
        canvas = scratch.new_page(width=w, height=h)
        canvas.draw_rect(fitz.Rect(0, 0, w, h), color=(1, 1, 1), fill=(1, 1, 1))
        canvas.insert_text((24, 34), "ENTERPRISE CONTEXT", fontsize=15, fontname=BOLD, color=NAVY)

        band_h = (h - 70) / max(len(boxes), 1)
        for bi, (band, systems) in enumerate(boxes):
            top = 56 + bi * band_h
            canvas.draw_rect(
                fitz.Rect(16, top, w - 16, top + band_h - 10),
                color=(0.85, 0.87, 0.92), fill=(0.96, 0.97, 0.99),
            )
            canvas.insert_text((26, top + 20), band, fontsize=10.5, fontname=BOLD, color=NAVY)
            span = (w - 80) / max(len(systems), 1)
            for si, system in enumerate(systems):
                x = 40 + si * span
                rect = fitz.Rect(x, top + 30, x + span - 26, top + band_h - 24)
                canvas.draw_rect(rect, color=NAVY, fill=(1, 1, 1), width=1.1)
                for li, line in enumerate(wrap(system, BODY, 8.6, rect.width - 10)[:3]):
                    canvas.insert_text(
                        (rect.x0 + 5, rect.y0 + 15 + li * 10), line,
                        fontsize=8.6, fontname=BODY, color=BLACK,
                    )
                if si:
                    canvas.draw_line(
                        fitz.Point(x - 24, rect.y0 + 16), fitz.Point(x - 2, rect.y0 + 16),
                        color=NAVY, width=0.9,
                    )

        pixmap = canvas.get_pixmap(dpi=150)
        scratch.close()

        self.ensure(330)
        image_rect = fitz.Rect(MARGIN_X, self.y, WIDTH - MARGIN_X, self.y + 280)
        self.page.insert_image(image_rect, pixmap=pixmap)
        self.y += 288
        self.body(caption)
        self.space(8)

    def revision_history(self, rows: list[list[str]]) -> None:
        self.h1("", "Revision History")
        self.table(Table(["Version", "Date", "Changed By", "Description"], rows))

    def table_of_contents(self) -> None:
        """Inserted at page 2 once the body is laid out, so the numbers are real.

        The parser reads this before the body and reconciles the two, which is
        what turns a silent parse failure into a reported one — so it has to be
        genuinely correct here.
        """
        entries = list(self.toc_entries)
        page = self.doc.new_page(pno=1, width=WIDTH, height=HEIGHT)
        y = TOP
        page.insert_text((MARGIN_X, y), "Table of Contents", fontsize=SIZE["h1"],
                         fontname=BOLD, color=NAVY)
        y += 8
        page.draw_line(fitz.Point(MARGIN_X, y), fitz.Point(WIDTH - MARGIN_X, y),
                       color=NAVY, width=1.1)
        y += 24

        for label, depth, page_no in entries:
            if y > BOTTOM - 20:
                break
            indent = 0 if depth == 1 else 18
            # +1 because inserting this page shifted everything after it.
            number = str(page_no + 1)
            left_w = fitz.get_text_length(label, fontname=BODY, fontsize=SIZE["body"])
            num_w = fitz.get_text_length(number, fontname=BODY, fontsize=SIZE["body"])
            dot_w = fitz.get_text_length(".", fontname=BODY, fontsize=SIZE["body"])
            available = TEXT_W - indent - left_w - num_w - 8
            dots = "." * max(3, int(available / dot_w))

            page.insert_text((MARGIN_X + indent, y), label, fontsize=SIZE["body"],
                             fontname=BODY, color=BLACK)
            page.insert_text((MARGIN_X + indent + left_w + 4, y), dots,
                             fontsize=SIZE["body"], fontname=BODY, color=GREY)
            page.insert_text((WIDTH - MARGIN_X - num_w, y), number,
                             fontsize=SIZE["body"], fontname=BODY, color=BLACK)
            y += 17.5

    def save(self, path: str) -> None:
        self.table_of_contents()
        self.finish()
        self.doc.save(path, deflate=True)
        self.doc.close()
