"""Running headers and footers — strip them, but read them first.

Every page of the sample corpus carries a header (`Data Standards | Page 7`) and
a footer (`SENSITIVITY CLASSIFICATION: Internal Use`): roughly a hundred
repetitions of the same two lines across four documents. Left in, that
boilerplate lands in every chunk and drags the whole corpus toward each other in
embedding space.

The classification has to be lifted before the strip, because it is governance
data rather than noise — Data Standards §8.1 defines handling rules per tier and
§8.2 keys access off them. It is the only place in these documents where the
sensitivity of the content is stated.
"""

from __future__ import annotations

import re
from collections import defaultdict

from .spans import Line

# Page numbers and dates vary line to line; normalise them away so the rest of
# the string can be compared across pages.
_VARIABLE = re.compile(r"\d+")
_WS = re.compile(r"\s+")

_SENSITIVITY = re.compile(
    r"SENSITIVITY\s+CLASSIFICATION\s*:?\s*(.+?)\s*$", re.IGNORECASE
)

# How much of the document a line must appear on to count as furniture. Low
# enough to catch documents whose first pages differ, high enough that a
# repeated bullet or a recurring table header is not swept up.
_REPEAT_RATIO = 0.6

# Vertical bands are coarse, because a header drifts a point or two between
# pages depending on what is under it.
_Y_BAND = 24.0


def _key(line: Line) -> tuple[str, int]:
    text = _WS.sub(" ", _VARIABLE.sub("#", line.text)).strip().lower()
    return text, int(line.y // _Y_BAND)


def detect(lines: list[Line], page_count: int) -> set[int]:
    """Indices of lines that are running furniture rather than content."""
    if page_count < 3:
        return set()

    groups: dict[tuple[str, int], list[int]] = defaultdict(list)
    for index, line in enumerate(lines):
        groups[_key(line)].append(index)

    furniture: set[int] = set()
    threshold = max(2, int(page_count * _REPEAT_RATIO))
    for (text, _band), indices in groups.items():
        if not text:
            continue
        pages = {lines[i].page for i in indices}
        if len(pages) >= threshold:
            furniture.update(indices)
    return furniture


def sensitivity(lines: list[Line]) -> str | None:
    """The classification printed on the page, e.g. 'Internal Use'.

    Read from the whole line list rather than only the furniture set, because
    the cover page states it once outside the running footer.
    """
    counts: dict[str, int] = defaultdict(int)
    for line in lines:
        match = _SENSITIVITY.search(line.text)
        if match:
            value = match.group(1).strip(" :.-")
            if value:
                counts[value] += 1
    if not counts:
        return None
    # The running footer wins over a one-off mention in body text.
    return max(counts.items(), key=lambda kv: kv[1])[0]


def strip(lines: list[Line], page_count: int) -> tuple[list[Line], str | None]:
    """Content lines and the document's sensitivity, in one pass."""
    classification = sensitivity(lines)
    furniture = detect(lines, page_count)
    return [line for i, line in enumerate(lines) if i not in furniture], classification
