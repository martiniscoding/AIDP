"""Structure read by a model, for documents whose own formatting says nothing.

The last rung. Typography, labels, principle tables and obligation words have
all returned nothing, and the alternative is a document worth zero.

**The model never sees or returns the document's text as text.** It receives
numbered lines and returns line numbers with a role attached. We then slice our
own copy. That is the whole safety property: a model cannot drop a word,
truncate a sentence or "tidy" a requirement it never held. Its entire output is
a handful of integers, and every one of them is checked against the source
before it is believed.

The worst it can do is point at the wrong line — which yields complete,
unaltered text grouped imperfectly. That is visible to a reviewer and caught by
the coverage checks in parse.py. It is a different class of failure from a rule
that silently lost half of itself.

Windowed rather than sent whole: accuracy degrades over long inputs, and one
call deciding a fifty-page document's entire structure is a single point of
failure. Windows overlap so a boundary falling on a seam is seen twice, and
disagreement between two views of the same line is a signal rather than a
coin toss.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .. import logs
from ..ai import llm
from .clauses import Clause
from .sections import Section
from .spans import Line

log = logs.get(__name__)

# Lines per request, and how much consecutive windows share. 120 keeps a call
# comfortably small; 15 is enough overlap that a heading and the clause beneath
# it are never split across two windows without one view seeing both.
WINDOW = 120
OVERLAP = 15

ROLES = ("heading", "statement", "rationale", "requirement", "guidance")

# A marker this far inside a window is a confident observation; one at the edge
# saw less context. Used to break disagreements between overlapping windows.
EDGE = 5


@dataclass
class Structure:
    """Shaped to drop straight into the parse stage's own fields."""

    sections: list[Section] = field(default_factory=list)
    clauses: dict[int, list[Clause]] = field(default_factory=dict)
    #: Lines belonging to no section, and windows that disagreed. Both are
    #: reported by the parse stage rather than silently accepted.
    orphan_lines: list[int] = field(default_factory=list)
    disputed_lines: list[int] = field(default_factory=list)


@dataclass
class _Marker:
    line: int
    role: str
    #: How far this marker sat from the edge of the window that produced it.
    depth: int


def _windows(total: int) -> list[tuple[int, int]]:
    if total <= WINDOW:
        return [(0, total)]
    spans: list[tuple[int, int]] = []
    start = 0
    while start < total:
        end = min(start + WINDOW, total)
        spans.append((start, end))
        if end == total:
            break
        start = end - OVERLAP
    return spans


_TAG_NOTE = """\

Some lines carry a [tag] before the text. It is what the source file called \
that line - "title" is a slide title, "L1"/"L2" are outline depth, "notes" is \
speaker notes, "table" is a row of a table. Weigh it, do not obey it: a slide \
title is often too thin to be a rule on its own, and a heading with no [title] \
tag is still a heading. The tag is not part of the text.
"""


def _numbered(lines: list[Line], start: int, end: int, hints: dict[int, str]) -> str:
    """The window, one line per row, each prefixed with its own line number.

    A hint is rendered as a bracketed tag ahead of the text. It is input only —
    the reply is still nothing but line numbers, and the text is still sliced
    from our copy, so a tag cannot put words into a clause.
    """
    rows = []
    for i in range(start, end):
        tag = hints.get(i)
        rows.append(f"{i}: [{tag}] {lines[i].text}" if tag else f"{i}: {lines[i].text}")
    return "\n".join(rows)


def _ask(lines: list[Line], start: int, end: int, hints: dict[int, str]) -> list[_Marker]:
    """One window. Returns only markers that survive validation."""
    numbered = _numbered(lines, start, end, hints)

    try:
        raw = llm.structure(
            numbered=numbered,
            first_line=start,
            last_line=end - 1,
            tags=_TAG_NOTE if hints else "",
        )
    except Exception as exc:  # noqa: BLE001 — one window must not sink the document
        logs.warn(log, "structure call failed for window", start=start, error=str(exc)[:160])
        return []

    kept: list[_Marker] = []
    for item in raw.get("markers") or []:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("line"))
        except (TypeError, ValueError):
            continue
        role = str(item.get("role", "")).strip().lower()

        # Every marker is checked against the document. A line number outside
        # this window, or a role we did not offer, is a model inventing
        # something; it is dropped rather than repaired.
        if role not in ROLES or not (start <= index < end):
            continue

        kept.append(_Marker(line=index, role=role, depth=min(index - start, end - 1 - index)))
    return kept


def _merge(views: list[list[_Marker]]) -> tuple[dict[int, str], list[int]]:
    """Fuse overlapping windows. Returns (line -> role) and disputed lines."""
    seen: dict[int, list[_Marker]] = {}
    for window in views:
        for marker in window:
            seen.setdefault(marker.line, []).append(marker)

    roles: dict[int, str] = {}
    disputed: list[int] = []
    for line, markers in seen.items():
        distinct = {m.role for m in markers}
        if len(distinct) > 1:
            # Two windows read the same line differently. Trust the one that saw
            # more context around it, and record the disagreement either way.
            disputed.append(line)
        roles[line] = max(markers, key=lambda m: m.depth).role
    return roles, sorted(disputed)


def _text_from(lines: list[Line], start: int, stop: int, roles: dict[int, str]) -> str:
    """A marked line plus the unmarked lines that continue it.

    A statement wrapped across three lines is marked once, on its first line.
    The lines after it carry no marker of their own, so they belong to it — this
    is what keeps a sentence whole without the model having to say so.
    """
    body = [lines[start].text]
    index = start + 1
    while index < stop and index not in roles:
        body.append(lines[index].text)
        index += 1
    return " ".join(part.strip() for part in body if part.strip())


def structure(
    lines: list[Line], *, document_title: str, hints: dict[int, str] | None = None
) -> Structure:
    """Read a document's structure with a model. Empty when it cannot.

    `hints` is what the source format already knew about each line — populated
    for a deck, empty for a PDF, where the format knew nothing and this pass is
    the last rung.
    """
    content = [i for i, line in enumerate(lines) if line.text.strip()]
    if not content or not llm.available():
        return Structure()

    marks = hints or {}
    views = [_ask(lines, start, end, marks) for start, end in _windows(len(lines))]
    roles, disputed = _merge(views)
    if not roles:
        return Structure()

    heads = sorted(i for i, role in roles.items() if role == "heading")
    if not heads:
        return Structure()

    out = Structure(disputed_lines=disputed)
    bounds = heads + [len(lines)]

    # Pairwise over the boundaries. Uneven by construction — the last heading
    # has no successor, which is what the trailing `len(lines)` stands in for —
    # so the shorter side is meant to end it.
    for ordinal, (start, stop) in enumerate(
        zip(bounds, bounds[1:], strict=False), start=1
    ):
        title = lines[start].text.strip()
        section = Section(
            ordinal=ordinal,
            number_text=None,
            title=title[:160],
            depth=1,
            heading_path=f"{document_title} › {title}"[:1000],
            page_start=lines[start].page,
            page_end=lines[stop - 1].page,
            lines=[lines[i] for i in range(start + 1, stop) if lines[i].text.strip()],
        )
        out.sections.append(section)

        statement = ""
        rationale = ""
        requirements: list[str] = []
        guidance: list[str] = []
        for index in range(start + 1, stop):
            role = roles.get(index)
            if role is None or role == "heading":
                continue
            body = _text_from(lines, index, stop, roles)
            if not body:
                continue
            if role == "statement" and not statement:
                statement = body
            elif role == "rationale" and not rationale:
                rationale = body
            elif role == "requirement":
                requirements.append(body)
            elif role == "guidance":
                guidance.append(body)

        clause = Clause(
            ordinal=1,
            title=title,
            statement=statement,
            rationale=rationale,
            requirements=requirements,
            guidance=guidance,
            page_start=section.page_start,
            page_end=section.page_end,
        )
        if not clause.is_empty:
            out.clauses[ordinal - 1] = [clause]

    # Lines before the first heading belong to nothing. Reported, not dropped
    # silently — a model that started marking halfway down a document has
    # skipped whatever came before it.
    out.orphan_lines = [i for i in content if i < heads[0]]

    logs.info(
        log,
        "structure read by model",
        sections=len(out.sections),
        clauses=len(out.clauses),
        disputed=len(out.disputed_lines),
        orphans=len(out.orphan_lines),
    )
    return out
