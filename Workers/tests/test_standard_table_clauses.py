"""A standard's rules table must not be swallowed by its own preamble.

The reported failure was a whole enterprise standard arriving as one clause.
The extractors were all present and all correct; what was wrong was the order
they ran in.

`parse.py` asked `from_prose` first and only read the section's tables when
prose found nothing. `from_prose` returns *at most one* clause — it assembles a
single Clause from the section's `Statement:` / `Rationale:` / `Requirements:`
labels — so a section that opened with one labelled paragraph and then listed
its forty rules in a table yielded exactly one clause and dropped the forty
without a word. Enterprise standards are written in exactly that shape: a prose
preamble over a `Domain | Rule | Rationale | Implication` grid.

So the two now run together, and normative prose stays the fallback it was —
that one *infers* rules from unlabelled sentences, and running it alongside the
others would report the same rule twice.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_standard_table_clauses.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp.parsing import clauses as clause_parser  # noqa: E402
from aidp.parsing.sections import Section  # noqa: E402
from aidp.parsing.spans import Line  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


def line(text: str, page: int = 4) -> Line:
    """A positioned line, which is what Section.text is built from."""
    return Line(
        text=text,
        page=page,
        y=100.0,
        x0=72.0,
        bbox=(72.0, 100.0, 520.0, 112.0),
        sig=("Body", 11.0, False, False, 0),
    )


def section(title: str, text: str, *, number: str = "3.1") -> Section:
    """A section carrying real lines, so `.text` reads back what was passed."""
    return Section(
        ordinal=1,
        number_text=number,
        title=title,
        depth=2,
        heading_path=f"Standards > {title}",
        page_start=4,
        page_end=5,
        lines=[line(part) for part in text.strip().split(chr(10)) if part.strip()],
    )


# A real enterprise shape: a labelled preamble, then the rules in a grid.
PREAMBLE = section(
    "Integration Standards",
    "Statement: Integration between systems follows the enterprise patterns.\n"
    "Rationale: Consistent integration keeps interfaces supportable.\n",
)

GRID = [
    {
        "Principle Name": "API Exposure",
        "Statement and Rationale": "All external APIs are exposed through Apigee.",
        "Implications": "Direct service exposure is not permitted.\nAll traffic is logged at the gateway.",
    },
    {
        "Principle Name": "Asynchronous Messaging",
        "Statement and Rationale": "Event-driven integration must use the enterprise broker.",
        "Implications": "Point-to-point queues are retired.",
    },
    {
        "Principle Name": "Data Residency",
        "Statement and Rationale": "Customer data must remain within the Canadian region.",
        "Implications": "Cross-border replication requires an approved exception.",
    },
    # A description with no obligation and no implications is a catalogue row,
    # not a rule, and must still be refused — the guard that stops a patterns
    # reference becoming eighteen clauses.
    {
        "Principle Name": "Layered Pattern",
        "Statement and Rationale": "Separates presentation, business logic and data access.",
        "Implications": "",
    },
]


# ---------------------------------------------------------------------------
print("\n1. Each extractor on its own")

prose = clause_parser.from_prose(PREAMBLE)
ok("prose finds its one labelled clause", len(prose) == 1, len(prose))

table = clause_parser.from_table(PREAMBLE, GRID)
ok("the grid yields one clause per rule row", len(table) == 3, [c.title for c in table])
ok(
    "a catalogue row with no obligation is refused",
    all("Layered Pattern" not in (c.title or "") for c in table),
    [c.title for c in table],
)
ok(
    "a row's implications become its requirements",
    any(len(c.requirements) == 2 for c in table),
    [(c.title, len(c.requirements)) for c in table],
)
ok(
    "and the rule's own words are kept",
    any("Apigee" in c.statement for c in table),
    [c.statement[:48] for c in table],
)


# ---------------------------------------------------------------------------
print("\n2. The cascade that caused the bug")

# What parse.py used to do: tables only when prose found nothing.
old = clause_parser.from_prose(PREAMBLE)
if not old:
    old = clause_parser.from_table(PREAMBLE, GRID)
ok(
    "the old order yielded ONE clause from a four-row standard",
    len(old) == 1,
    len(old),
)

# What it does now: both.
new = clause_parser.from_prose(PREAMBLE)
for _ in (1,):
    new = new + clause_parser.from_table(PREAMBLE, GRID)
ok("the new order yields the preamble and every rule", len(new) == 4, len(new))
ok(
    "which is more than the old order found",
    len(new) > len(old),
    (len(old), len(new)),
)

# Re-numbering, since both extractors number from one.
for ordinal, clause in enumerate(new, start=1):
    clause.ordinal = ordinal
ok(
    "the combined clauses are numbered without a collision",
    [c.ordinal for c in new] == [1, 2, 3, 4],
    [c.ordinal for c in new],
)


# ---------------------------------------------------------------------------
print("\n3. parse.py itself reads both")

import inspect  # noqa: E402

from aidp.stages import parse as parse_stage  # noqa: E402

src = inspect.getsource(parse_stage)
ok(
    "the table loop is no longer guarded by 'if not found'",
    "if not found:\n            for table in out.tables.get(index, []):" not in src,
)
ok(
    "tables are read for every section",
    src.count("for table in out.tables.get(index, []):\n            found.extend(") == 2,
    src.count("for table in out.tables.get(index, []):"),
)
ok(
    "normative prose is still the fallback, not an addition",
    src.count("found = clause_parser.from_normative_prose(section)") == 2
    and src.count("if not found:\n            found = clause_parser.from_normative_prose") == 2,
)
ok("and the combined clauses are re-numbered", "clause.ordinal = ordinal" in src)


# ---------------------------------------------------------------------------
print("\n4. A prose-only standard is unchanged")

# No table, so the section behaves exactly as it did before the fix.
only_prose = clause_parser.from_prose(PREAMBLE)
for table_rows in ([],):
    only_prose = only_prose + [
        c for t in [table_rows] for c in clause_parser.from_table(PREAMBLE, t)
    ]
ok("a section with no table still yields its prose clause", len(only_prose) == 1, len(only_prose))

# A section with neither falls through to the inference pass.
bare = section("Scope", "This document describes the integration standards.")
ok("a section with nothing to state yields nothing from prose", clause_parser.from_prose(bare) == [])
ok(
    "and nothing from an empty table",
    clause_parser.from_table(bare, []) == [],
)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
