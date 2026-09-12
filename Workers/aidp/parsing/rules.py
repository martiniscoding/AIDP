"""A standard's rules, read by a model and checked by code.

The rule-based parser in clauses.py finds rules by their shape — `Statement:`
labels, a principle grid, obligation words — and every house style it has not
seen is a shape it cannot find. That is the failure this module exists for: a
standard laid out a little differently parses without error and quietly yields
the wrong rules, and nothing downstream can tell.

So a model does the reading, and it is trusted with nothing but pointing.

1. **Code reads the text.** Every paragraph and every table row becomes one
   numbered source line (`L12`, `T3-r4`), stored as it stands whatever happens
   next — the document is searchable even if no model ever answers.
2. **The model points.** It sees the numbered lines and answers with numbers:
   which span is a rule, which lines are its statement, rationale and each
   requirement, and — for everything that is not a rule — a label and a reason.
   It never writes a word of any rule.
3. **Code checks the answer.** Every number must exist. The lines must be
   accounted for. A reply that fails is retried on smaller pieces, then refused,
   and a refused reading falls back to the parser rather than half-adopting.
4. **Code slices the text.** A rule's words come from the stored lines, so the
   worst a wrong answer can do is group real text badly — which a reviewer can
   see — and never invent, reword or drop a requirement.
5. **Two readings and the old parser cross-check it.** Lines stating an
   obligation that ended up outside a rule, lines the readings disagree on, and
   rules the parser found that the model did not are raised as review issues.
   Nothing is resolved silently.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field

from .. import logs
from ..ai import llm
from . import clauses as clause_parser
from . import sections as section_parser
from .clauses import Clause
from .sections import Section
from .spans import Line
from .tables import LOW_CONFIDENCE, Table

log = logs.get(__name__)

#: Stored on every extraction, so a reading can be traced to the instructions
#: that produced it after those instructions change.
PROMPT_VERSION = "rules-1"

LABELS = ("furniture", "scope", "reference", "process_rule", "guidance", "other")
STRENGTHS = ("must", "should", "may")

LABEL_WORDS = {
    "furniture": "document furniture",
    "scope": "scope or introduction",
    "reference": "reference material",
    "process_rule": "rules about running the standard itself",
    "guidance": "guidance",
    "other": "other material",
}

# Labels under which an obligation can legitimately sit outside a rule. "All
# exceptions must be approved by the CISO" is an obligation, but on the people
# running the standard rather than on a design, and no design can fail it.
_EXPLAINED = {"process_rule", "reference"}

# Lines per model call. Every client standard seen so far is 400–700 lines and
# reads in one call; the limit exists for the one that is not, and is set so a
# dense part's reply stays well inside the output budget and the HTTP timeout.
MAX_LINES_PER_CALL = 800
# Below this a failing range is retried once rather than split again. Smaller
# pieces lose the context that tells a rule from a description.
MIN_LINES_PER_CALL = 100
# A runaway ceiling: a reply that keeps failing is refused, not bisected forever.
MAX_CALLS_PER_READING = 16

# What a reply must reach to be believed. Below either, the reading is not
# "mostly right" — it answered a different question, or stopped part way.
MIN_COVERAGE = 0.85
MAX_INVALID_SHARE = 0.10

# A rule member this far outside the span the model gave is not a slip at the
# edge; it is a pointer into some other part of the document.
_SPAN_SLACK = 5

# Broader than the parser's `_NORMATIVE`, deliberately. That one decides what
# becomes a rule and has to be conservative; this one decides what a reviewer
# is shown, where a table cell reading "MFA required" is worth a look.
_OBLIGATION = re.compile(
    r"\b(?:must|shall|required|requires|prohibited|mandatory|may\s+not|never)\b",
    re.IGNORECASE,
)

# A list glyph is layout, not text. Numbered markers ("1.", "a)") are kept: in a
# standard they are often the rule's own citation.
_GLYPH = re.compile(r"^\s*[•▪◦‣·»–—-]\s+")

# Part labels a rule's text opens with. The model points at "Statement: All
# data must…"; the clause stores "All data must…", as the parser always has.
_PART_LABEL = re.compile(
    r"^\s*(?:statements?|rationales?|requirements?|implications?|guidance|notes?|"
    r"applicable\s+patterns?(?:\s*(?:/|and)\s*(?:technology\s+)?guidance)?)\s*:\s*",
    re.IGNORECASE,
)

# Column names that hold a row's own name, for titling a rule that is one row.
_NAME_COLUMN = re.compile(r"name|principle|control|title|rule|requirement\s*id", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Source lines
# ---------------------------------------------------------------------------


@dataclass
class SourceLine:
    """One numbered unit of the document, exactly as it was read."""

    #: Position in the document, from 0. The number the model sees and answers in.
    ordinal: int
    #: The same position for people: `L12` is the twelfth paragraph, `T3-r4`
    #: the fourth row of the third table and `T3-h` its column line.
    ref: str
    #: text | heading | bullet | table_header | table_row
    kind: str
    text: str
    page: int | None
    #: Index of the parse's section this line falls in.
    section: int
    #: Declared heading depth, when the format stated one.
    depth: int | None = None
    #: A table row's own name, when one of its cells holds it.
    name: str | None = None
    #: A table row's cells by column. The model can only point at a whole row,
    #: so when one row is a whole rule its parts come from these.
    cells: dict[str, str | None] | None = None


class _Builder:
    def __init__(self) -> None:
        self.lines: list[SourceLine] = []
        self._paragraphs = 0
        self._tables = 0

    def text(
        self,
        text: str,
        *,
        kind: str,
        page: int | None,
        section: int,
        depth: int | None = None,
    ) -> None:
        if kind != "heading" and _GLYPH.match(text):
            kind = "bullet"
            text = _GLYPH.sub("", text, count=1)
        text = " ".join(text.split())
        if not text:
            return
        self._paragraphs += 1
        self.lines.append(
            SourceLine(
                ordinal=len(self.lines),
                ref=f"L{self._paragraphs}",
                kind=kind,
                text=text,
                page=page,
                section=section,
                depth=depth,
            )
        )

    def table(self, table: Table, *, section: int) -> None:
        rows = [(_row_text(row), _row_name(row), row) for row in table.rows]
        rows = [(text, name, row) for text, name, row in rows if text]
        if not rows:
            return
        self._tables += 1
        number = self._tables
        columns = " | ".join(" ".join(str(c).split()) for c in table.columns if str(c).strip())
        if columns:
            self.lines.append(
                SourceLine(
                    ordinal=len(self.lines),
                    ref=f"T{number}-h",
                    kind="table_header",
                    text=columns,
                    page=table.page_start,
                    section=section,
                )
            )
        for index, (text, name, cells) in enumerate(rows, start=1):
            self.lines.append(
                SourceLine(
                    ordinal=len(self.lines),
                    ref=f"T{number}-r{index}",
                    kind="table_row",
                    text=text,
                    page=table.page_start,
                    section=section,
                    name=name,
                    cells=dict(cells),
                )
            )


def _row_text(row: dict[str, str | None]) -> str:
    """A row with every cell bound to its column, so a row read alone still
    says what each value is."""
    cells = []
    for column, value in row.items():
        value = " ".join(str(value or "").split())
        if not value:
            continue
        column = " ".join(str(column or "").split())
        cells.append(f"{column}: {value}" if column else value)
    return " | ".join(cells)


def _row_name(row: dict[str, str | None]) -> str | None:
    for column, value in row.items():
        value = " ".join(str(value or "").split())
        if value and len(value) <= 80 and _NAME_COLUMN.search(str(column or "")):
            return value
    for value in row.values():
        value = " ".join(str(value or "").split())
        # A bare row number is not a name.
        if value and len(value) <= 80 and not value.rstrip(".").isdigit():
            return value
    return None


def word_source(doc, owner: list[int]) -> list[SourceLine]:
    """Source lines for a .docx — its paragraphs, with each table's rows placed
    where the table was written.

    `owner` is `sections.from_outline`'s map from line to section. A table's
    anchor is the paragraph before it, and -1 for a table ahead of any text.
    """
    after: dict[int, list[Table]] = {}
    for anchor, table in doc.tables:
        after.setdefault(anchor, []).append(table)

    def section_at(index: int) -> int:
        for i in range(min(index, len(owner) - 1), -1, -1):
            if owner[i] >= 0:
                return owner[i]
        return 0

    out = _Builder()
    for table in after.get(-1, []):
        out.table(table, section=0)
    for index, line in enumerate(doc.lines):
        depth = doc.levels.get(index)
        out.text(
            line.text,
            kind="heading" if depth is not None else "text",
            page=line.page,
            section=section_at(index),
            depth=depth,
        )
        for table in after.get(index, []):
            out.table(table, section=section_at(index))
    return out.lines


def pdf_source(
    lines: list[Line],
    section_list: list[Section],
    found: list[Table],
    regions: dict[int, list],
    *,
    table_section: Callable[[Table], int],
) -> list[SourceLine]:
    """Source lines for a PDF — its lines in reading order, with tables as rows.

    A table's cells are also lines on the page, and giving the model both would
    have it read every table twice. So a table the extractor read well is given
    as rows, header bound to cell, and its cell lines are left out. A table it
    read badly, or a page whose tables cannot all be matched to extracted ones,
    keeps its raw lines instead — duplicated text costs tokens, while a table
    missing from both forms would cost a rule.
    """
    owner: dict[int, int] = {}
    for index, section in enumerate(section_list):
        for line in section.lines:
            owner[id(line)] = index

    # A heading is not among its own section's lines, and neither is a cover
    # or contents line. Each takes the section of the next line that has one:
    # a heading introduces what follows it.
    section_of: list[int | None] = [owner.get(id(line)) for line in lines]
    following: int | None = None
    for i in range(len(lines) - 1, -1, -1):
        if section_of[i] is None:
            section_of[i] = following
        else:
            following = section_of[i]
    preceding = 0
    for i, value in enumerate(section_of):
        if value is None:
            section_of[i] = preceding
        else:
            preceding = value

    # By title alone: a section stores "Governance Standards" for a line printed
    # "2. Governance Standards", and only lines no section claims are candidates.
    headings: dict[str, int] = {}
    for section in section_list:
        headings.setdefault(section.title.strip(), section.depth)

    def heading_depth(text: str) -> int | None:
        if text in headings:
            return headings[text]
        for pattern in (section_parser._NUMBERED, section_parser._APPENDIX):  # noqa: SLF001
            if match := pattern.match(text):
                return headings.get((match.group("title") or "").strip())
        return None

    usable = [t for t in found if t.rows and t.confidence >= LOW_CONFIDENCE]

    def touching(page: int, pool: list[Table]) -> int:
        return sum(1 for t in pool if t.page_start <= page <= t.page_end)

    def eligible(page: int) -> bool:
        return len(regions.get(page, [])) <= touching(page, usable)

    as_rows = [
        t for t in usable if all(eligible(p) for p in range(t.page_start, t.page_end + 1))
    ]
    replaced = {
        page
        for page, boxes in regions.items()
        if boxes and len(boxes) <= touching(page, as_rows)
    }

    pending = sorted(as_rows, key=lambda t: (t.page_start, t.bbox[1]))
    out = _Builder()
    for i, line in enumerate(lines):
        while pending and (pending[0].page_start, pending[0].bbox[1]) <= (line.page, line.bbox[1]):
            table = pending.pop(0)
            out.table(table, section=table_section(table))
        if line.page in replaced and section_parser._in_region(line, regions):  # noqa: SLF001
            continue
        text = line.text.strip()
        unowned = owner.get(id(line)) is None
        depth = heading_depth(text) if unowned else None
        out.text(
            text,
            kind="heading" if depth is not None else "text",
            page=line.page,
            section=section_of[i] or 0,
            depth=depth,
        )
    for table in pending:
        out.table(table, section=table_section(table))
    return out.lines


def render(source: list[SourceLine], first: int, last: int) -> str:
    """Lines `first`–`last`, one per row, each behind its number and tag."""
    rows: list[str] = []
    page: int | None = None
    for line in source[first : last + 1]:
        if line.page is not None and line.page != page:
            page = line.page
            rows.append(f"--- page {page} ---")
        rows.append(f"{line.ordinal}: {_tag(line)}{line.text}")
    return "\n".join(rows)


def _tag(line: SourceLine) -> str:
    table = line.ref.split("-")[0]
    if line.kind == "heading":
        return f"[heading {line.depth}] " if line.depth else "[heading] "
    if line.kind == "bullet":
        return "[bullet] "
    if line.kind == "table_header":
        return f"[{table} columns] "
    if line.kind == "table_row":
        return f"[{table} row] "
    return ""


# ---------------------------------------------------------------------------
# Reading and checking a reply
# ---------------------------------------------------------------------------


@dataclass
class Rule:
    start: int
    end: int
    heading: int | None
    statement: list[int]
    rationale: list[int]
    requirements: list[tuple[list[int], str]]
    guidance: list[int]
    references: list[int]


@dataclass
class Label:
    start: int
    end: int
    label: str
    reason: str


@dataclass
class Reading:
    rules: list[Rule] = field(default_factory=list)
    labels: list[Label] = field(default_factory=list)
    headings: dict[int, int] = field(default_factory=dict)
    #: Every line number the reply used, and how many of them were not lines.
    checked: int = 0
    invalid: int = 0

    def in_rules(self) -> set[int]:
        return {n for rule in self.rules for n in range(rule.start, rule.end + 1)}

    def covered(self) -> set[int]:
        lines = self.in_rules() | set(self.headings)
        for label in self.labels:
            lines.update(range(label.start, label.end + 1))
        return lines

    def label_of(self) -> dict[int, Label]:
        """The label on each line outside every rule. A rule wins an overlap:
        a line inside a rule is never reported as set aside."""
        ruled = self.in_rules()
        out: dict[int, Label] = {}
        for label in self.labels:
            for n in range(label.start, label.end + 1):
                if n not in ruled:
                    out.setdefault(n, label)
        return out


def _items(value) -> list:
    return value if isinstance(value, list) else []


def validate(raw: dict, first: int, last: int) -> Reading:
    """Keep what points at real lines in `first`–`last`; count what does not.

    Nothing is repaired into existence. A number outside the range is a model
    pointing at something that is not there, and it is dropped and counted —
    the count, not a guess at what was meant, decides whether the reply is
    believed at all.
    """
    reading = Reading()

    def line(value) -> int | None:
        if value is None:
            return None
        reading.checked += 1
        if isinstance(value, bool):
            reading.invalid += 1
            return None
        try:
            number = int(value)
        except (TypeError, ValueError):
            reading.invalid += 1
            return None
        if number != value and not isinstance(value, str):
            reading.invalid += 1
            return None
        if not first <= number <= last:
            reading.invalid += 1
            return None
        return number

    def lines_of(value) -> list[int]:
        values = value if isinstance(value, list) else ([] if value is None else [value])
        return sorted({n for n in (line(v) for v in values) if n is not None})

    for item in _items(raw.get("sections")):
        if not isinstance(item, dict):
            reading.invalid += 1
            continue
        number = line(item.get("line"))
        if number is None:
            continue
        try:
            depth = int(item.get("depth") or 1)
        except (TypeError, ValueError):
            depth = 1
        reading.headings[number] = max(1, min(depth, 6))

    for item in _items(raw.get("labels")):
        if not isinstance(item, dict):
            reading.invalid += 1
            continue
        start, end = line(item.get("from")), line(item.get("to"))
        if start is None and end is None:
            continue
        start = end if start is None else start
        end = start if end is None else end
        if start > end:
            start, end = end, start
        label = str(item.get("label") or "").strip().lower()
        reason = " ".join(str(item.get("reason") or "").split())[:300]
        if label not in LABELS:
            reason = f"{label}: {reason}".strip(": ") if label else reason
            label = "other"
        reading.labels.append(Label(start, end, label, reason))

    for item in _items(raw.get("rules")):
        if not isinstance(item, dict):
            reading.invalid += 1
            continue
        start, end = line(item.get("from")), line(item.get("to"))
        heading = line(item.get("heading"))

        statement = lines_of(item.get("statement"))
        rationale = lines_of(item.get("rationale"))
        guidance = lines_of(item.get("guidance"))
        references = lines_of(item.get("references"))
        requirements: list[tuple[list[int], str]] = []
        for requirement in _items(item.get("requirements")):
            if isinstance(requirement, dict):
                refs = lines_of(requirement.get("lines"))
                strength = str(requirement.get("strength") or "must").strip().lower()
            else:
                refs = lines_of(requirement)
                strength = "must"
            if refs:
                requirements.append((refs, strength if strength in STRENGTHS else "must"))

        # A member far outside the span it was given points somewhere else in
        # the document. Stretching the span to reach it would sweep everything
        # in between into the rule.
        if start is not None and end is not None:
            lo, hi = min(start, end) - _SPAN_SLACK, max(start, end) + _SPAN_SLACK

            def near(refs: list[int], lo: int = lo, hi: int = hi) -> list[int]:
                kept = [n for n in refs if lo <= n <= hi]
                reading.invalid += len(refs) - len(kept)
                return kept

            statement, rationale, guidance = near(statement), near(rationale), near(guidance)
            requirements = [(near(refs), s) for refs, s in requirements]
            requirements = [(refs, s) for refs, s in requirements if refs]
            if heading is not None and not lo <= heading <= hi:
                reading.invalid += 1
                heading = None

        if not statement and not requirements:
            reading.invalid += 1
            continue

        members = [
            *statement,
            *rationale,
            *guidance,
            *(n for refs, _ in requirements for n in refs),
        ]
        if heading is not None:
            members.append(heading)
        bounds = [n for n in (start, end) if n is not None] + members
        reading.rules.append(
            Rule(
                start=min(bounds),
                end=max(bounds),
                heading=heading,
                statement=statement,
                rationale=rationale,
                requirements=requirements,
                guidance=guidance,
                references=references,
            )
        )

    return reading


def refusal(reading: Reading, first: int, last: int) -> str | None:
    """Why a reply cannot be believed, or None when it can."""
    total = last - first + 1
    if reading.checked and reading.invalid / reading.checked > MAX_INVALID_SHARE:
        return (
            f"{reading.invalid} of {reading.checked} line numbers in the reply were not "
            f"lines {first}–{last}"
        )
    if not reading.rules and not reading.labels:
        return "the reply accounted for no lines"
    covered = len({n for n in reading.covered() if first <= n <= last})
    if covered / total < MIN_COVERAGE:
        return f"the reply accounted for only {covered} of {total} lines"
    return None


def _merge(parts: list[Reading]) -> Reading:
    merged = Reading()
    for part in parts:
        merged.rules.extend(part.rules)
        merged.labels.extend(part.labels)
        merged.headings.update(part.headings)
        merged.checked += part.checked
        merged.invalid += part.invalid
    return merged


def _cut(source: list[SourceLine], *, floor: int, target: int) -> int:
    """Where to divide the document near `target`, never before `floor`.

    At a heading when there is one in reach, so a rule is not split from its
    own requirements. Never between two rows of one table.
    """
    for n in range(target, floor, -1):
        if source[n].kind == "heading":
            return n
    cut = target
    while cut > floor and source[cut].kind == "table_row":
        cut -= 1
    return cut if cut > floor else target


def parts(source: list[SourceLine]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    start, total = 0, len(source)
    while start < total:
        if total - start <= MAX_LINES_PER_CALL:
            out.append((start, total - 1))
            break
        cut = _cut(source, floor=start + MAX_LINES_PER_CALL // 2, target=start + MAX_LINES_PER_CALL)
        out.append((start, cut - 1))
        start = cut
    return out


@dataclass
class Call:
    """One request to the model, kept whether or not it was believed."""

    first: int
    last: int
    status: str  # accepted | refused | failed | skipped
    error: str | None = None
    reply: str = ""

    def as_json(self) -> dict:
        return {
            "first": self.first,
            "last": self.last,
            "status": self.status,
            "error": self.error,
            # Line numbers, labels and short reasons, so this stays small. The
            # cap is for a reply that ran away; NUL is the one character a
            # Postgres jsonb value refuses.
            "reply": self.reply[:200_000].replace("\x00", ""),
        }


@dataclass
class Attempt:
    """One whole reading of the document."""

    number: int
    reading: Reading | None = None
    calls: list[Call] = field(default_factory=list)
    error: str | None = None
    adopted: bool = False

    @property
    def status(self) -> str:
        return "accepted" if self.reading is not None else "failed"


@dataclass
class Outcome:
    attempts: list[Attempt] = field(default_factory=list)

    @property
    def adopted(self) -> Attempt | None:
        return next((a for a in self.attempts if a.adopted), None)

    @property
    def reading(self) -> Reading | None:
        attempt = self.adopted
        return attempt.reading if attempt else None

    @property
    def error(self) -> str | None:
        return next((a.error for a in reversed(self.attempts) if a.error), None)


def _read_range(
    source: list[SourceLine],
    first: int,
    last: int,
    *,
    title: str,
    attempt: Attempt,
    heartbeat: Callable[[], None],
    whole: bool,
    retry: bool = True,
) -> Reading | None:
    if len(attempt.calls) >= MAX_CALLS_PER_READING:
        attempt.calls.append(Call(first, last, "skipped", "call limit for this reading reached"))
        attempt.error = "the model's replies kept failing checks, so the reading was abandoned"
        return None

    heartbeat()
    reply = ""
    reading: Reading | None = None
    try:
        reply = llm.read_rules(
            document=render(source, first, last),
            title=title,
            first=first,
            last=last,
            whole=whole,
            attempt=attempt.number,
        )
        reading = validate(llm.parse_json(reply), first, last)
        problem = refusal(reading, first, last)
        status = "refused" if problem else "accepted"
    except llm.QuotaExhausted:
        raise
    except Exception as exc:  # noqa: BLE001 — recorded, then retried or refused
        problem, status = str(exc)[:300], "failed"

    attempt.calls.append(Call(first, last, status, problem, reply))
    if problem is None:
        return reading

    logs.warn(log, "rule reading refused", first=first, last=last, reason=problem[:160])
    attempt.error = problem
    size = last - first + 1
    kwargs = {"title": title, "attempt": attempt, "heartbeat": heartbeat, "whole": False}
    if size >= 2 * MIN_LINES_PER_CALL:
        # Most refusals of a long range are a reply cut off at the output limit;
        # half the lines is half the reply.
        mid = _cut(source, floor=first + size // 4, target=first + size // 2)
        left = _read_range(source, first, mid - 1, **kwargs)
        if left is None:
            return None
        right = _read_range(source, mid, last, **kwargs)
        return None if right is None else _merge([left, right])
    if retry:
        return _read_range(source, first, last, **kwargs, retry=False)
    return None


def read(
    source: list[SourceLine],
    *,
    title: str,
    readings: int = 2,
    heartbeat: Callable[[], None] = lambda: None,
) -> Outcome:
    """Read the rules out of a standard. Never raises for a model failure.

    The first accepted reading is adopted. A second reading is the cross-check
    when the first succeeded, and the retry when it did not — so even with
    `readings=1` a failed reading gets one more try.
    """
    outcome = Outcome()
    if not source:
        return outcome

    whole = len(source) <= MAX_LINES_PER_CALL
    number = 0
    while True:
        number += 1
        attempt = Attempt(number=number)
        outcome.attempts.append(attempt)
        try:
            found: list[Reading] = []
            for first, last in parts(source):
                part = _read_range(
                    source, first, last, title=title, attempt=attempt,
                    heartbeat=heartbeat, whole=whole,
                )
                if part is None:
                    break
                found.append(part)
            else:
                attempt.reading = _merge(found)
                attempt.error = None
        except llm.QuotaExhausted as exc:
            attempt.error = str(exc)
            break

        if outcome.adopted is None and attempt.reading is not None:
            attempt.adopted = True
        wanted = readings if outcome.adopted is not None else 2
        if number >= max(wanted, 1):
            break

    logs.info(
        log,
        "rules read by model",
        attempts=len(outcome.attempts),
        adopted=outcome.adopted.number if outcome.adopted else None,
        rules=len(outcome.reading.rules) if outcome.reading else 0,
        lines=len(source),
    )
    return outcome


# ---------------------------------------------------------------------------
# From a reading to clauses
# ---------------------------------------------------------------------------


def _text(source: list[SourceLine], ordinals: list[int]) -> str:
    """The document's own words for these lines, joined as one passage."""
    parts: list[str] = []
    for n in sorted(set(ordinals)):
        line = source[n]
        text = line.text if line.kind == "table_row" else _PART_LABEL.sub("", line.text, count=1)
        if text.strip():
            parts.append(text.strip())
    return " ".join(" ".join(parts).split())


def _passages(source: list[SourceLine], ordinals: list[int]) -> list[list[int]]:
    """Consecutive lines as one passage, broken where a new item plainly starts.

    A PDF wraps one guidance sentence over three lines, and those are one item;
    three bullets or three table rows are three.
    """
    groups: list[list[int]] = []
    for n in sorted(set(ordinals)):
        starts_item = source[n].kind in ("bullet", "table_row", "heading")
        if groups and groups[-1][-1] == n - 1 and not starts_item:
            groups[-1].append(n)
        else:
            groups.append([n])
    return groups


def _title(line: SourceLine) -> str:
    if line.kind == "table_row":
        return line.name or ""
    text = line.text.strip()
    for pattern in (section_parser._NUMBERED, section_parser._APPENDIX):  # noqa: SLF001
        if match := pattern.match(text):
            return (match.group("title") or "").strip() or text
    return text


def to_clauses(
    source: list[SourceLine], reading: Reading, section_list: list[Section]
) -> dict[int, list[Clause]]:
    """Clauses by section index, in reading order, every word sliced from source."""
    out: dict[int, list[Clause]] = {}
    if not section_list:
        return out

    for found in sorted(reading.rules, key=lambda r: (r.start, r.end)):
        rule = _without_repeats(found)

        anchor = (rule.statement or [refs[0] for refs, _ in rule.requirements] or [rule.start])[0]
        index = max(0, min(source[anchor].section, len(section_list) - 1))
        section = section_list[index]

        statement = _text(source, rule.statement)
        rationale = _text(source, rule.rationale)
        requirements = [t for t in (_text(source, refs) for refs, _ in rule.requirements) if t]
        guidance = [
            t for t in (_text(source, group) for group in _passages(source, rule.guidance)) if t
        ]
        rationale_lines = rule.rationale
        requirement_lines = list(rule.requirements)

        title = _title(source[rule.heading]) if rule.heading is not None else ""
        if rule.heading is not None and source[rule.heading].kind == "table_row" and title:
            title = f"{section.title} — {title}"

        row = _row_parts(source, rule, section)
        if row is not None:
            line = rule.statement[0]
            strength = next(
                (s for refs, s in found.requirements if line in refs), "must"
            )
            statement = row.statement
            if row.rationale:
                rationale, rationale_lines = row.rationale, [line]
            requirements = row.requirements + requirements
            requirement_lines = [([line], strength)] * len(row.requirements) + requirement_lines
            if rule.heading is None and row.title:
                title = row.title

        if not statement and not requirements:
            continue
        title = (title or section.title)[:500]

        pages = [
            source[n].page for n in range(rule.start, rule.end + 1) if source[n].page is not None
        ]

        def refs(ordinals: list[int]) -> list[str]:
            return [source[n].ref for n in ordinals]

        clauses = out.setdefault(index, [])
        clauses.append(
            Clause(
                ordinal=len(clauses) + 1,
                title=title,
                statement=statement,
                rationale=rationale,
                requirements=requirements,
                guidance=guidance,
                page_start=min(pages) if pages else section.page_start,
                page_end=max(pages) if pages else section.page_end,
                origin="model",
                source={
                    "span": [source[rule.start].ref, source[rule.end].ref],
                    "heading": source[rule.heading].ref if rule.heading is not None else None,
                    "statement": refs(rule.statement),
                    "rationale": refs(rationale_lines),
                    "requirements": [
                        {"refs": refs(r), "strength": strength}
                        for r, strength in requirement_lines
                    ],
                    "guidance": refs(rule.guidance),
                    "references": refs(rule.references),
                },
            )
        )
    return out


def _without_repeats(rule: Rule) -> Rule:
    """Each line in at most one part of a rule.

    A model sometimes points at one line for two parts — most often a table row,
    which it cannot divide. Kept in both, the same words became the statement,
    the rationale and a requirement, and a design would be assessed against the
    one sentence three times. The first claim wins, in the order a rule reads:
    statement, requirements, rationale, guidance.
    """
    taken = set(rule.statement)
    requirements: list[tuple[list[int], str]] = []
    for refs, strength in rule.requirements:
        kept = [n for n in refs if n not in taken]
        if kept:
            requirements.append((kept, strength))
            taken.update(kept)
    rationale = [n for n in rule.rationale if n not in taken]
    taken.update(rationale)
    return Rule(
        start=rule.start,
        end=rule.end,
        heading=rule.heading,
        statement=list(rule.statement),
        rationale=rationale,
        requirements=requirements,
        guidance=[n for n in rule.guidance if n not in taken],
        references=list(rule.references),
    )


def _row_parts(source: list[SourceLine], rule: Rule, section: Section) -> Clause | None:
    """The parts of a rule that is one row of a principle grid, from its cells.

    The model can point at a row but not inside it. `clauses.from_table` already
    knows how such a row divides — a name column, a statement-and-rationale
    cell, an implications cell — and divides the row's own text, so every word
    is still the document's. Anything else is left to the caller: a row that is
    not grid-shaped reads as itself.
    """
    if len(rule.statement) != 1:
        return None
    line = source[rule.statement[0]]
    if line.kind != "table_row" or not line.cells:
        return None
    found = clause_parser.from_table(section, [line.cells])
    return found[0] if found else None


# ---------------------------------------------------------------------------
# Cross-checks, as review issues
# ---------------------------------------------------------------------------


@dataclass
class Finding:
    severity: str
    kind: str
    detail: str
    page: int | None = None
    ref: str | None = None


def _quote(line: SourceLine, limit: int = 90) -> str:
    text = line.text if len(line.text) <= limit else line.text[: limit - 1].rstrip() + "…"
    return f"{line.ref} “{text}”"


def _normal(text: str) -> str:
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text.lower()).split())


def stats(source: list[SourceLine], reading: Reading, clauses: dict[int, list[Clause]]) -> dict:
    labelled: dict[str, int] = dict.fromkeys(LABELS, 0)
    for label in reading.label_of().values():
        labelled[label.label] += 1
    covered = len(reading.covered() & set(range(len(source))))
    return {
        "lines": len(source),
        "covered": covered,
        "inRules": len(reading.in_rules()),
        "rules": sum(len(c) for c in clauses.values()),
        "requirements": sum(len(cl.requirements) for c in clauses.values() for cl in c),
        "labelledLines": labelled,
        "numbersChecked": reading.checked,
        "numbersInvalid": reading.invalid,
    }


def summary(source: list[SourceLine], reading: Reading, clauses: dict[int, list[Clause]]) -> str:
    figures = stats(source, reading, clauses)
    set_aside = ", ".join(
        f"{LABEL_WORDS[label]} ({count})"
        for label, count in figures["labelledLines"].items()
        if count
    )
    return (
        f"This standard's rules were read by a model and checked line by line against "
        f"the source: {figures['rules']} rules carrying {figures['requirements']} "
        f"requirements, with {figures['covered']} of {figures['lines']} lines accounted "
        f"for. "
        + (f"Set aside as not rules, each with a stated reason: {set_aside}. " if set_aside else "")
        + "Every word of every rule is the document's own. Confirm the rules before "
        "assessing anything against them."
    )


def review(
    source: list[SourceLine],
    outcome: Outcome,
    parser_clauses: dict[int, list[Clause]],
    section_list: list[Section],
) -> list[Finding]:
    reading = outcome.reading
    if reading is None:
        return []
    findings: list[Finding] = []
    total = len(source)
    obligations = {line.ordinal for line in source if _OBLIGATION.search(line.text)}
    ruled = reading.in_rules()
    labels = reading.label_of()

    # 1. Lines nothing accounted for.
    uncovered = [n for n in range(total) if n not in reading.covered()]
    if uncovered:
        stated = [n for n in uncovered if n in obligations]
        share = len(uncovered) / total
        findings.append(
            Finding(
                "high" if stated or share >= 0.02 else "low",
                "rules_lines_unread",
                f"{len(uncovered)} of {total} lines were not accounted for by the model"
                + (f", {len(stated)} of them stating an obligation" if stated else "")
                + ". They are still indexed as text, but no rule was taken from them. "
                + "First: "
                + "; ".join(_quote(source[n]) for n in (stated or uncovered)[:3]),
                page=source[(stated or uncovered)[0]].page,
            )
        )

    # 2. Obligations set aside. Grouped by label: one issue per kind of reason,
    # not one per line, or a standard's compliance chapter buries everything.
    set_aside: dict[str, list[int]] = {}
    for n in sorted(obligations - ruled):
        if n in labels:
            set_aside.setdefault(labels[n].label, []).append(n)
    for label, lines in set_aside.items():
        examples = "; ".join(
            f"{_quote(source[n])} — {labels[n].reason or 'no reason given'}" for n in lines[:3]
        )
        findings.append(
            Finding(
                "medium" if label in _EXPLAINED else "high",
                "rules_obligation_set_aside",
                f"{len(lines)} line(s) stating an obligation were set aside as "
                f"{LABEL_WORDS[label]} rather than read as rules of this standard. "
                f"{examples}. If any of these is something a design must meet, it is "
                "missing from every assessment.",
                page=source[lines[0]].page,
            )
        )

    # 3. The second reading — or the lack of one. A cross-check that never ran
    # is not a cross-check that agreed, and the two must not look the same.
    unfinished = next(
        (a for a in outcome.attempts if a.reading is None and not a.adopted), None
    )
    if unfinished is not None:
        findings.append(
            Finding(
                "medium",
                "rules_cross_check_missing",
                "The second, independent reading of this standard did not complete "
                f"({(unfinished.error or 'no reply')[:200]}), so these rules were read "
                "once and not cross-checked. Re-parse once the model is available to have "
                "them checked.",
            )
        )
    other = next(
        (a.reading for a in outcome.attempts if a.reading is not None and not a.adopted), None
    )
    if other is not None:
        theirs = other.in_rules()
        only_other = sorted((obligations & theirs) - ruled)
        only_ours = sorted((obligations & ruled) - theirs)
        if only_other or only_ours:
            parts_: list[str] = []
            if only_other:
                parts_.append(
                    f"{len(only_other)} were part of a rule only in the second reading "
                    f"(first: {_quote(source[only_other[0]])})"
                )
            if only_ours:
                parts_.append(
                    f"{len(only_ours)} only in the reading that was used "
                    f"(first: {_quote(source[only_ours[0]])})"
                )
            findings.append(
                Finding(
                    "high" if only_other else "medium",
                    "rules_readings_differ",
                    f"Two independent readings of this standard disagreed about "
                    f"{len(only_other) + len(only_ours)} line(s) stating an obligation: "
                    + "; ".join(parts_)
                    + f". The first reading found {len(reading.rules)} rules, the second "
                    f"{len(other.rules)}.",
                    page=source[(only_other or only_ours)[0]].page,
                )
            )

    # 4. What the rule-based parser found and the model did not.
    spans = "\n".join(
        _normal(" ".join(source[n].text for n in range(rule.start, rule.end + 1)))
        for rule in reading.rules
    )
    missed: list[Finding] = []
    for index, found in parser_clauses.items():
        section = section_list[index] if index < len(section_list) else None
        for clause in found:
            text = clause.statement or next(iter(clause.requirements), "") or ""
            key = _normal(text)
            if len(key) < 20 or key[:100] in spans:
                continue
            where = next(
                (
                    line.ordinal
                    for line in source
                    if len(_normal(line.text)) >= 20
                    and (_normal(line.text) in key or key[:60] in _normal(line.text))
                ),
                None,
            )
            label = labels.get(where) if where is not None else None
            if label is not None:
                fate = (
                    f"The model set it aside as {LABEL_WORDS[label.label]}: "
                    f"{label.reason or 'no reason given'}."
                )
            elif where is not None and where in ruled:
                continue
            else:
                fate = "The model did not account for it."
            missed.append(
                Finding(
                    "medium" if label is not None and label.label in _EXPLAINED else "high",
                    "rules_parser_only",
                    f"The rule-based parser read a rule here that the model did not: "
                    f"'{clause.title or (section.title if section else '')}' — "
                    f"“{text[:140]}{'…' if len(text) > 140 else ''}”. {fate} Check whether "
                    "it belongs among this standard's rules.",
                    page=clause.page_start,
                    ref=section.heading_path if section else None,
                )
            )
    findings.extend(missed[:12])
    if len(missed) > 12:
        findings.append(
            Finding(
                "high",
                "rules_parser_only",
                f"…and {len(missed) - 12} more rules the rule-based parser read that the "
                "model did not.",
            )
        )

    return findings
