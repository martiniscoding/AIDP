"""One passage per thing the document says, before the judge ever sees them.

A table reaches the index up to four ways — as a `table` chunk, as one
`table_row` chunk per row, and again inside the `clause` and `section` chunks
that carry the same cells flattened into a line. In this workspace one table on
one page of one design is nine chunks. Fusion has no reason to prefer any of
them, so a single table can take most of a window meant to hold the document's
eight best passages: the judge reads the same rows three times, and whatever
was pushed out of the window it never sees at all.

`_fold_duplicates` collapses them on the way out of retrieval, by the
`TableBlock` id where there is one and by what the passage says where there is
not. What it must never do is fold two passages that are genuinely different
evidence, so the cases below are as much about what survives as what goes.

    docker run --rm -v "$PWD":/w -w /w -e PYTHONPATH=/w \\
      --entrypoint python aidp-worker-test tests/test_retrieval_fold.py
"""

from __future__ import annotations

import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import retrieval  # noqa: E402
from aidp.retrieval import Candidate, _fold_duplicates  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


def chunk(
    chunk_id: str,
    kind: str,
    source_id: str | None,
    text: str,
    score: float,
    document_id: str = "design-1",
) -> Candidate:
    return Candidate(
        chunk_id=chunk_id,
        heading_path="4 Application and infrastructure decisions",
        text=text,
        page_start=1,
        score=score,
        vector_rank=1,
        lexical_rank=1,
        source_kind=kind,
        source_id=source_id,
        document_id=document_id,
        document_title="Customer Order Platform (COP)",
    )


# The real shape: a decisions grid, and one of its rows on its own.
TABLE = (
    "Area Decision current choice Rationale or issue Application pattern Modular monolith "
    "with catalogue order payment adapter notification modules Clear functional boundaries "
    "without premature service proliferation External boundary API gateway authentication "
    "rate limiting request validation Governed entry point for internet-facing traffic"
)
ROW = (
    "Application pattern Modular monolith with catalogue order payment adapter "
    "notification modules Clear functional boundaries without premature service proliferation"
)
OTHER = (
    "Retention periods per data category are defined in the data catalogue, with certified "
    "destruction schedules applied to every archived backup set and recorded against it"
)

print("\n1. The same table, however many ways it was indexed")
got = _fold_duplicates([chunk("row", "table_row", "tbl", ROW, 9.0), chunk("all", "table", "tbl", TABLE, 5.0)])
ok("the whole table displaces a row of it", [c.chunk_id for c in got] == ["all"], [c.chunk_id for c in got])
got = _fold_duplicates(
    [chunk("r1", "table_row", "tbl", ROW, 9.0), chunk("r2", "table_row", "tbl", ROW + " extra", 8.0)]
)
ok("two rows of one table become one passage", len(got) == 1, len(got))
got = _fold_duplicates([chunk("all", "table", "tbl", TABLE, 9.0), chunk("sec", "section", "sct", TABLE, 8.0)])
ok("the flattened twin goes, the drawing stays", [c.chunk_id for c in got] == ["all"], [c.chunk_id for c in got])

print("\n2. What must survive")
got = _fold_duplicates([chunk("all", "table", "tbl", TABLE, 9.0), chunk("p", "clause", "cls", OTHER, 8.0)])
ok("a passage about something else is kept", len(got) == 2, len(got))
got = _fold_duplicates(
    [chunk("a", "table", "tbl", TABLE, 9.0), chunk("b", "table", "tbl2", TABLE, 8.0, document_id="design-2")]
)
ok("another design's table is not this one", len(got) == 2, len(got))
got = _fold_duplicates(
    [chunk("a", "clause", "c1", "Backups run nightly.", 9.0), chunk("b", "clause", "c2", "Backups run nightly.", 8.0)]
)
ok("two short lines are never folded on overlap", len(got) == 2, len(got))
got = _fold_duplicates([chunk("all", "table", "tbl", TABLE, 9.0), chunk("fig", "figure", "f1", TABLE, 8.0)])
ok("a diagram's reading is never folded away", len(got) == 2, len(got))

print("\n3. The window is still filled by score")
ordered = _fold_duplicates(
    [chunk("a", "clause", "c1", OTHER, 9.0), chunk("b", "table", "tbl", TABLE, 8.0)]
)
ok("order is preserved", [c.chunk_id for c in ordered] == ["a", "b"], [c.chunk_id for c in ordered])
ok("nothing is invented", all(isinstance(c, Candidate) for c in ordered))

print("\nA passage is cut at a space, never inside a word")
# `body[:700]` ended half of this workspace's 6,099 stored excerpts mid-word:
# "replace with gov…", "without demonstrated gatew…", "It lists four specific
# da…". The reader is left guessing at a word the cut destroyed, and "gov"
# could be governance, governed or government.
long = ("word " * 200) + "governance"
cut = retrieval._shorten(long)
ok("it is cut", cut.endswith("…"))
ok("within the limit", len(cut) <= retrieval._EXCERPT + 1, len(cut))
# The real test of a clean cut is not what the last character is — a whole word
# also ends in a letter — but that the source continues with a space where the
# cut was made. That is what "no word was broken" means.
kept = cut[:-1]
ok(
    "the cut is where the source has a space",
    long.startswith(kept) and long[len(kept)] == " ",
    repr(cut[-28:]),
)
ok("so no word was broken by it", kept.split()[-1] == "word", kept.split()[-1])
ok("a short passage is untouched", retrieval._shorten("hello world") == "hello world")
ok(
    "one exactly at the limit is untouched",
    retrieval._shorten("a" * retrieval._EXCERPT) == "a" * retrieval._EXCERPT,
)
ok(
    "a single token longer than the limit is still cut, having no space to cut at",
    retrieval._shorten("x" * 900) == "x" * retrieval._EXCERPT + "…",
)
ok(
    "a space too near the start does not shorten it to nothing",
    len(retrieval._shorten("a" * 690 + " " + "b" * 200)) > retrieval._EXCERPT // 2,
)

print("\nLine breaks that mean something are kept")
# Collapsing every newline destroyed the only structure a passage had. A table
# inside a section chunk arrived as "Area Decision / current choice Rationale or
# issue Ingestion Nightly ETL from HR…" — the column boundaries that *are* the
# content, gone.
TABLE_IN_SECTION = """Area
Decision / current choice
Rationale or issue
Ingestion
Nightly ETL from HR and learning systems
Source access
BI dashboard directly queries Timekeeping DB"""
out = retrieval._reflow(TABLE_IN_SECTION)
ok("every cell keeps its own line", len(out.splitlines()) == 7, len(out.splitlines()))
ok("and nothing is fused", "Ingestion Nightly" not in out, out[:90])

bullets = "Each principle includes:\n• Statement (what it means)\n• Rationale (why it matters)"
ok(
    "a bullet list stays a list",
    len(retrieval._reflow(bullets).splitlines()) == 3,
    retrieval._reflow(bullets),
)
ok(
    "a line ending in a colon keeps its break",
    retrieval._reflow("Each principle includes:\nstatement").splitlines()[0].endswith(":"),
)

print("\nAnd the ones that do not are closed up")
# A PDF wrapping at its right margin: a long unterminated line, then a
# lower-case continuation. 4% of line pairs in this corpus.
wrapped = (
    "It collects measurement data from approximately 310,000 field\n"
    "devices and smart meters across the estate."
)
ok("a mid-sentence wrap is rejoined", len(retrieval._reflow(wrapped).splitlines()) == 1)
ok("with a space, not a jam", "field devices" in retrieval._reflow(wrapped))
ok(
    "a short line is not treated as a wrap, however it ends",
    len(retrieval._reflow("Area\ndecision").splitlines()) == 2,
)
ok(
    "nor is a continuation that starts upper case",
    len(
        retrieval._reflow(
            "It collects measurement data from approximately 310,000 field\nDevices are listed."
        ).splitlines()
    )
    == 2,
)
ok("blank lines are dropped", retrieval._reflow("a\n\n\nb") == "a\nb")
ok("empty in, empty out", retrieval._reflow("") == "")

print("\nA table's own chunk is never reflowed")
# A cell can be short and lower case, and any continuation rule would weld it
# onto the row above — which is unrecoverable by eye.
cells = Candidate(
    chunk_id="t", heading_path="h", text="Object Type | Convention\ntable | snake case",
    page_start=1, score=1.0, vector_rank=1, lexical_rank=1, source_kind="table",
)
ok("its rows stay separate", len(cells.excerpt.splitlines()) == 2, cells.excerpt)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
