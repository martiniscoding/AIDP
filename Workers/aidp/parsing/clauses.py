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

# The label set has to match `_CLAUSE_LABEL` in sections.py, which already knew
# about singular forms and about "Implications" — the word TOGAF actually
# specifies for this field. This module did not, so a TOGAF-worded document
# produced a clause with no requirements at all and the obligations silently
# absorbed into the rationale: a clause that looks extracted and is missing its
# testable half.
_LABELS = {
    "statement": re.compile(r"^\s*Statements?\s*:?\s*", re.IGNORECASE | re.MULTILINE),
    "rationale": re.compile(r"^\s*Rationales?\s*:?\s*", re.IGNORECASE | re.MULTILINE),
    # "Implications" is TOGAF's own term for this field; both land here.
    "requirements": re.compile(
        r"^\s*(?:Requirements?|Implications?)\s*:?\s*", re.IGNORECASE | re.MULTILINE
    ),
    "guidance": re.compile(
        r"^\s*Applicable\s+Patterns?\s*(?:/|and)?\s*(?:Technology\s+)?Guidance\s*:?\s*",
        re.IGNORECASE | re.MULTILINE,
    ),
    # Recognised only so it acts as a boundary. Nothing reads this field — the
    # point is that a trailing note stops being swallowed by the field above it.
    "note": re.compile(r"^\s*Notes?\s*:", re.IGNORECASE | re.MULTILINE),
}

# Word emits bullets as their own glyph; some exports fall back to a hyphen.
_BULLET = re.compile(r"^\s*(?:[•▪◦‣·»–—-]|\(?[a-z0-9]{1,3}[.)])\s+")

# ...and some put the glyph on a line of its own, with the text on the next one.
# PyMuPDF reports those as two lines, so the bullet arrives with no text after it
# and `_BULLET` — which requires trailing whitespace — never matches. Every
# requirement in the document then glues onto its predecessor as a continuation,
# and a clause that states four separate obligations is stored as one.
_BULLET_ALONE = re.compile(r"^\s*[•▪◦‣·»–—-]\s*$")


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
    #: "parser" when this module found the clause by its shape, "model" when
    #: rules.py read it. Stored, so a reviewer knows which kind they are trusting.
    origin: str = "parser"
    #: For a model-read clause, the source line refs each part was sliced from.
    source: dict | None = None

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
    # Set when a glyph arrived alone: the next line with text opens a new item
    # rather than continuing the previous one.
    opening = False

    for raw in block.splitlines():
        line = raw.strip()
        if not line:
            continue
        if _BULLET_ALONE.match(line):
            opening = True
            continue
        if _BULLET.match(line):
            items.append(_BULLET.sub("", line).strip())
            opening = False
        elif opening:
            items.append(line)
            opening = False
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
        # Line by line, not collapsed. A Word cell puts "Statement" and
        # "Rationale" on lines of their own and lists its implications one per
        # line with no glyph; joined into one run, every rationale in a client's
        # principle grid stayed inside its statement, and three implications
        # became a single requirement that no design could half-meet.
        body = _first(cells, ("statement and rationale", "statement", "description"), lines=True)
        implications = _first(cells, ("implications", "requirements", "implication"), lines=True)
        if not (body or implications):
            continue
        # A row is a rule only when it carries an obligation: a column for one,
        # or obligation language in its text. A Description column alone
        # describes. Without this, every catalogue with a Description column
        # became rules — a patterns reference ("Separates presentation, business
        # logic, and data access") and an ADR template ("A short, descriptive
        # title for the decision") turned into eighteen clauses that every
        # submitted design would then have been assessed against.
        if not implications and not _NORMATIVE.search(body):
            continue

        if not title:
            # The row's own name beats "principle 3" — a classification grid
            # names each row in its first column.
            first = " ".join(str(next(iter(row.values()), "") or "").split())
            if first and first != " ".join(body.split()) and len(first) <= 80:
                title = f"{section.title} — {first}"

        statement, rationale = _split_statement_rationale(body)
        clause = Clause(
            ordinal=index,
            title=title or f"{section.title} — principle {index}",
            statement=statement,
            rationale=rationale,
            requirements=_items(implications),
            page_start=section.page_start,
            page_end=section.page_end,
        )
        if not clause.is_empty:
            clauses.append(clause)
    return clauses


def _first(cells: dict[str, str], keys: tuple[str, ...], *, lines: bool = False) -> str:
    """The first cell whose column name contains one of `keys`.

    Whitespace is collapsed, within each line only when `lines` is set — a
    cell's line breaks are sometimes the only thing separating its parts.
    """
    for key in keys:
        for actual, value in cells.items():
            if key in actual:
                if not lines:
                    return " ".join(value.split())
                return "\n".join(
                    " ".join(part.split()) for part in value.splitlines() if part.strip()
                )
    return ""


def _items(text: str) -> list[str]:
    """Separate obligations from one cell.

    A cell with bullets divides at its bullets. One without divides at its line
    breaks, which in a Word cell are paragraphs, each its own item. A single run
    of prose — a PDF cell, whose breaks the extractor has already flattened —
    divides into its sentences, so "Keys must be rotated. Keys must never be
    shared." is two things a design can each fail.
    """
    if not text:
        return []
    parts = [line for line in text.splitlines() if line.strip()]
    if any(_BULLET.match(line) or _BULLET_ALONE.match(line) for line in parts):
        return _bullets(text)
    if len(parts) == 1:
        parts = _sentences(parts[0])
    return [item for item in (" ".join(p.split()).strip(" ;.") for p in parts) if item]


# "…built. Rationale: Reuse lowers cost." — the label mid-line, after a sentence
# ends. The colon is required here, unlike at a line start, so a sentence that
# merely mentions a rationale is never cut in two.
_INLINE_RATIONALE = re.compile(r"(?<=[.;!?])\s*\bRationales?\s*:\s*", re.IGNORECASE)


def _split_statement_rationale(body: str) -> tuple[str, str]:
    """Cells label their two halves inconsistently — sometimes `Statement:` and
    `Rationale:`, sometimes neither. When there is no label, everything is the
    statement rather than being guessed at."""
    if not body:
        return "", ""
    match = _LABELS["rationale"].search(body) or _INLINE_RATIONALE.search(body)
    if not match:
        return " ".join(_LABELS["statement"].sub("", body, count=1).split()), ""
    statement = _LABELS["statement"].sub("", body[: match.start()], count=1)
    return " ".join(statement.split()), " ".join(body[match.end() :].split())


# Words that make a sentence an obligation rather than a description. Kept
# narrow on purpose: "should" and "may" are advisory in every standards document
# in this corpus, and admitting them would turn commentary into requirements.
_NORMATIVE = re.compile(
    r"\b(?:must|shall|is\s+required\s+to|are\s+required\s+to|is\s+prohibited|"
    r"are\s+prohibited|may\s+not|must\s+not|shall\s+not)\b",
    re.IGNORECASE,
)

# A line that is really a table cell — a bare label with no verb. Classification
# grids arrive as one short line per cell once the table extractor has declined
# them, and stitching those into a statement produces nonsense.
_MAX_SENTENCE_CHARS = 400
_MIN_SENTENCE_CHARS = 25


def _sentences(text: str) -> list[str]:
    """Split prose into sentences, tolerating PDF line breaks mid-sentence.

    Lines are joined first: a sentence broken across two lines by the PDF is one
    sentence, and splitting on the newline would leave half an obligation.

    Bullets are boundaries in their own right. A bulleted list carries no full
    stop between its items, so joining every line and splitting on punctuation
    fused a whole list into one "sentence". In every standard of a client's set
    the Compliance section's four obligations became a single 557-character run,
    failed the length check below, and produced no clause at all.
    """
    units: list[list[str]] = [[]]
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if _BULLET_ALONE.match(line):
            units.append([])
        elif _BULLET.match(line):
            units.append([_BULLET.sub("", line, count=1)])
        else:
            # A continuation joins whatever unit it belongs to: the bullet above
            # it, or the running paragraph when there is no bullet.
            units[-1].append(line)

    out: list[str] = []
    for unit in units:
        joined = " ".join(unit)
        if not joined:
            continue
        parts = re.split(r"(?<=[.;])\s+(?=[A-Z(])", joined)
        out.extend(" ".join(part.split()) for part in parts if part.strip())
    return out


def from_normative_prose(section: Section) -> list[Clause]:
    """Last resort: a section that states obligations without labelling them.

    The two labelled shapes — `Statement:`/`Rationale:`/`Requirements:` prose and
    the principle grid — cover the documents this was built against, and nothing
    else. A standard written as ordinary numbered prose ("6.1 Data
    Classification: All data assets must be classified…") matched neither, so it
    produced no clause, was never fired at a submitted design, and raised no
    warning: the section had prose, so it did not look empty.

    That is the worst failure this system can have. A missed clause is not a
    wrong answer a reviewer can catch — it is a question nobody was asked.

    Deliberately conservative. It fires only on sentences carrying a real
    obligation (`must`, `shall`, `is required to`, prohibitions), because a
    fabricated requirement is as damaging as a missed one, and "should"/"may"
    are advisory throughout this corpus. Sections yielding nothing here are
    reported by the parse stage rather than passed over.
    """
    if section.is_structural:
        return []

    candidates = [
        s
        for s in _sentences(section.text)
        if _MIN_SENTENCE_CHARS <= len(s) <= _MAX_SENTENCE_CHARS and _NORMATIVE.search(s)
    ]
    if not candidates:
        return []

    # The first obligation is the rule; the rest are the obligations it carries.
    # That ordering matches how these sections are written — a lead sentence
    # stating the rule, then its specifics.
    clause = Clause(
        ordinal=1,
        title=section.title,
        statement=candidates[0],
        requirements=candidates[1:9],
        page_start=section.page_start,
        page_end=section.page_end,
    )
    return [] if clause.is_empty else [clause]


def has_unextracted_obligation(section: Section) -> bool:
    """True when a section states an obligation that no extractor turned into a
    clause. Drives the review issue — the point is that this is never silent."""
    return bool(not section.is_structural and _NORMATIVE.search(section.text or ""))
