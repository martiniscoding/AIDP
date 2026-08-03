"""Clause extraction — the atomic unit of a standards document.

Every substantive rule in this corpus is the same three-part shape:

    Statement:    one sentence, the rule
    Rationale:    one or two sentences, the why
    Requirements: three or four bullets, the testable obligations

Solution Architecture adds a fourth part, *Applicable Patterns / Technology
Guidance* — the prescription attached to the diagnosis, which is why that
document has it and the others do not.

This is also the chunk boundary and, later, the query unit for gap analysis: the
analyse stage fires one clause at a time at a submitted design. A Requirements
bullet severed from its Statement is unusable in both roles — "Access must be
requested, approved, and periodically re-certified" means nothing without
knowing it sits under least privilege.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .sections import Section

_LABELS = {
    "statement": re.compile(r"\bStatement\s*:?\s*", re.IGNORECASE),
    "rationale": re.compile(r"\bRationale\s*:?\s*", re.IGNORECASE),
    "requirements": re.compile(r"\bRequirements\s*:?\s*", re.IGNORECASE),
    "guidance": re.compile(
        r"\bApplicable\s+Patterns?\s*(?:/|and)?\s*(?:Technology\s+)?Guidance\s*:?\s*",
        re.IGNORECASE,
    ),
}

# Word emits bullets as their own glyph; some exports fall back to a hyphen.
_BULLET = re.compile(r"^\s*(?:[•▪◦‣·»–—-]|\(?[a-z0-9]{1,3}[.)])\s+")


@dataclass
class Clause:
    ordinal: int
    title: str | None
    statement: str = ""
    rationale: str = ""
    requirements: list[str] = field(default_factory=list)
    guidance: list[str] = field(default_factory=list)
    page_start: int | None = None
    page_end: int | None = None

    @property
    def is_empty(self) -> bool:
        return not (self.statement or self.rationale or self.requirements or self.guidance)

    def render(self) -> str:
        """The chunk body. Order mirrors the document so citations read naturally."""
        parts: list[str] = []
        if self.statement:
            parts.append(f"Statement: {self.statement}")
        if self.rationale:
            parts.append(f"Rationale: {self.rationale}")
        if self.requirements:
            parts.append("Requirements:\n" + "\n".join(f"• {r}" for r in self.requirements))
        if self.guidance:
            parts.append(
                "Applicable patterns / technology guidance:\n"
                + "\n".join(f"• {g}" for g in self.guidance)
            )
        return "\n\n".join(parts)


def _bullets(block: str) -> list[str]:
    """Split a Requirements block into individual obligations.

    Continuation lines are joined back onto their bullet: PDF line breaks fall
    mid-sentence, and a requirement cut in half is a requirement that will not
    match at retrieval time.
    """
    items: list[str] = []
    for raw in block.splitlines():
        line = raw.strip()
        if not line:
            continue
        if _BULLET.match(line):
            items.append(_BULLET.sub("", line).strip())
        elif items:
            items[-1] = f"{items[-1]} {line}".strip()
        else:
            items.append(line)
    return [i for i in (i.strip(" ;.") for i in items) if i]


def from_prose(section: Section) -> list[Clause]:
    """Extract a clause from a section that labels its parts in prose."""
    text = section.text
    if not text:
        return []

    hits: list[tuple[int, int, str]] = []
    for name, pattern in _LABELS.items():
        for match in pattern.finditer(text):
            hits.append((match.start(), match.end(), name))
    if not hits:
        return []

    hits.sort()
    parts: dict[str, str] = {}
    for index, (_start, end, name) in enumerate(hits):
        stop = hits[index + 1][0] if index + 1 < len(hits) else len(text)
        # First label wins: a Rationale that mentions the word "requirements"
        # must not reopen a section that has already been closed.
        parts.setdefault(name, text[end:stop].strip())

    clause = Clause(
        ordinal=1,
        title=section.title,
        statement=" ".join(parts.get("statement", "").split()),
        rationale=" ".join(parts.get("rationale", "").split()),
        requirements=_bullets(parts.get("requirements", "")),
        guidance=_bullets(parts.get("guidance", "")),
        page_start=section.page_start,
        page_end=section.page_end,
    )
    return [] if clause.is_empty else [clause]


def from_table(section: Section, rows: list[dict[str, str | None]]) -> list[Clause]:
    """Extract clauses from a principle table — one row, one clause.

    The live customer document puts everything in a four-column grid
    (`# | Principle Name | Statement and Rationale | Implications`), with the
    statement and rationale sharing a cell and "Requirements" renamed to
    "Implications".
    """
    clauses: list[Clause] = []
    for index, row in enumerate(rows, start=1):
        cells = {(k or "").strip().lower(): (v or "") for k, v in row.items()}

        title = _first(cells, ("principle name", "principle", "name"))
        body = _first(cells, ("statement and rationale", "statement", "description"))
        implications = _first(cells, ("implications", "requirements", "implication"))
        if not (body or implications):
            continue

        statement, rationale = _split_statement_rationale(body)
        clause = Clause(
            ordinal=index,
            title=title or f"{section.title} — principle {index}",
            statement=statement,
            rationale=rationale,
            requirements=_bullets(implications),
            page_start=section.page_start,
            page_end=section.page_end,
        )
        if not clause.is_empty:
            clauses.append(clause)
    return clauses


def _first(cells: dict[str, str], keys: tuple[str, ...]) -> str:
    for key in keys:
        for actual, value in cells.items():
            if key in actual:
                return " ".join(value.split())
    return ""


def _split_statement_rationale(body: str) -> tuple[str, str]:
    """Cells label their two halves inconsistently — sometimes `Statement:` and
    `Rationale:`, sometimes neither. When there is no label, everything is the
    statement rather than being guessed at."""
    if not body:
        return "", ""
    match = _LABELS["rationale"].search(body)
    if not match:
        return " ".join(_LABELS["statement"].sub("", body, count=1).split()), ""
    statement = _LABELS["statement"].sub("", body[: match.start()], count=1)
    return " ".join(statement.split()), " ".join(body[match.end() :].split())
