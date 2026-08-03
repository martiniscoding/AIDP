"""Lines, font signatures, and the document's typographic profile.

Headings are found by typography, not by regex alone. `get_text("dict")` gives
every span with its font, size, weight and colour; grouping those into
signatures and counting how much text each one sets reveals the body style by
sheer mass. Anything meaningfully larger, bolder, or differently coloured is a
heading candidate.

This works on the sample corpus because all four documents are Word exports with
consistent styles. It is not a technique that survives arbitrary PDFs, which is
why `FontProfile.confident` exists and why a document that fails it raises an
issue rather than producing a confidently wrong section tree.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

import fitz

# (font family, size rounded to 0.5pt, bold, italic, colour)
FontSig = tuple[str, float, bool, bool, int]

_BOLD_FLAG = 1 << 4
_ITALIC_FLAG = 1 << 1
_WS = re.compile(r"\s+")


def _round_half(value: float) -> float:
    return round(value * 2) / 2


@dataclass
class Line:
    text: str
    page: int
    # Baseline-ish top edge, used for ordering and for furniture detection.
    y: float
    x0: float
    bbox: tuple[float, float, float, float]
    sig: FontSig
    # True when any span on the line is bold — a heading may mix weights.
    has_bold: bool = False

    @property
    def size(self) -> float:
        return self.sig[1]

    @property
    def is_blank(self) -> bool:
        return not self.text.strip()


@dataclass
class FontProfile:
    body: FontSig
    # Heading signatures, largest first. Index + 1 is the depth we assign.
    levels: list[FontSig] = field(default_factory=list)
    confident: bool = True
    note: str = ""

    def level_of(self, sig: FontSig) -> int | None:
        """Heading depth for a signature, or None if it is body text."""
        for i, level in enumerate(self.levels):
            if sig[1] == level[1] and sig[2] == level[2]:
                return i + 1
        return None


def extract_lines(doc: fitz.Document) -> list[Line]:
    """Every non-blank line in reading order, with its dominant font signature."""
    lines: list[Line] = []
    for page_index in range(doc.page_count):
        page = doc[page_index]
        data = page.get_text("dict")
        for block in data.get("blocks", []):
            # type 1 is an image block; those are handled in figures.py.
            if block.get("type") != 0:
                continue
            for raw in block.get("lines", []):
                spans = [s for s in raw.get("spans", []) if s.get("text", "").strip()]
                if not spans:
                    continue
                text = _WS.sub(" ", "".join(s["text"] for s in raw["spans"])).strip()
                if not text:
                    continue

                # The dominant signature is the one setting the most characters,
                # so a stray bold word in a sentence doesn't reclassify the line.
                weights: Counter[FontSig] = Counter()
                for s in spans:
                    sig: FontSig = (
                        s.get("font", ""),
                        _round_half(s.get("size", 0.0)),
                        bool(s.get("flags", 0) & _BOLD_FLAG),
                        bool(s.get("flags", 0) & _ITALIC_FLAG),
                        s.get("color", 0),
                    )
                    weights[sig] += len(s["text"].strip())

                x0, y0, x1, y1 = raw["bbox"]
                lines.append(
                    Line(
                        text=text,
                        page=page_index + 1,
                        y=y0,
                        x0=x0,
                        bbox=(x0, y0, x1, y1),
                        sig=weights.most_common(1)[0][0],
                        has_bold=any(s.get("flags", 0) & _BOLD_FLAG for s in spans),
                    )
                )
    return lines


def profile_fonts(lines: list[Line]) -> FontProfile:
    """Infer body text and heading levels from how much text each style sets."""
    if not lines:
        return FontProfile(body=("", 0.0, False, False, 0), confident=False, note="no text")

    mass: Counter[FontSig] = Counter()
    for line in lines:
        mass[line.sig] += len(line.text)

    body = mass.most_common(1)[0][0]
    body_size = body[1]
    total = sum(mass.values())
    body_share = mass[body] / total if total else 0

    # A heading is bigger than body, or the same size but bold when body isn't.
    # Colour alone is not enough — these documents set links and captions in
    # colour at body size.
    candidates: dict[tuple[float, bool], FontSig] = {}
    for sig, chars in mass.items():
        size, bold = sig[1], sig[2]
        bigger = size > body_size + 0.4
        emphasised = size >= body_size - 0.1 and bold and not body[2]
        if not (bigger or emphasised):
            continue
        # Headings are a small fraction of a document. Anything setting a fifth
        # of the text is a second body style, not a heading.
        if chars / total > 0.20:
            continue
        candidates.setdefault((size, bold), sig)

    levels = [candidates[k] for k in sorted(candidates, key=lambda k: (-k[0], not k[1]))]

    profile = FontProfile(body=body, levels=levels)
    if body_share < 0.25:
        profile.confident = False
        profile.note = (
            f"no dominant body style (largest sets {body_share:.0%} of text) — "
            "heading detection is unreliable for this document"
        )
    elif not levels:
        profile.confident = False
        profile.note = "no heading styles distinguishable from body text"
    return profile
