"""A run over a whole project, without a database or a model.

A solution is described across several documents — a proposal, an architecture
deck, a data model — and judged one document at a time the answers in the second
file were reported as gaps in the first. A run may now name a project, and a
clause is judged once against every design in it.

What this proves is the part that can be got wrong silently. The designs a run
covers and the ones it had to leave out; that several designs' coverage, advice
and technologies merge into one report without losing which design each item is
about; that a diagram in one design is never carried into another design's
search window on the strength of a shared page number; that the judge is told
which design it is reading; and that the absent re-read reads each design whole,
one at a time, with every quote still checked against the design it came from.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_project_run.py
"""

from __future__ import annotations

import pathlib
import sys

from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import designs, lifecycle, retrieval, whole_document  # noqa: E402
from aidp.ai import llm  # noqa: E402
from aidp.stages import analyse  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


class _Conn:
    """Stands in for a connection; the queries are patched, not run."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


A = designs.Design("doc-a", "Customer Portal Proposal")
B = designs.Design("doc-b", "Target Architecture")
C = designs.Design("doc-c", "Data Model")


# ---------------------------------------------------------------------------
print("\n1. What a run covers")

DOC_RUN = {"id": "run-1", "organisationId": "org-1", "documentId": "doc-a", "projectId": None}
PROJ_RUN = {"id": "run-2", "organisationId": "org-1", "documentId": None, "projectId": "proj-1"}

with mock.patch.object(
    designs.db,
    "one",
    lambda conn, sql, args: {
        "id": "doc-a",
        "title": "Customer Portal Proposal",
        "projectId": "proj-1",
    },
):
    scope = designs.for_run(_Conn(), DOC_RUN)
ok("a run on one design covers that design", scope.designs == [A], scope.designs)
ok("and is not a project run", not scope.is_project and not scope.unready)
# The run row names no project; the design's own row does. Without this a
# ruling the board granted to this project would not be weighed on the design
# it was granted for — see aidp/decisions.py.
ok(
    "but it still knows the project the design is in",
    scope.project_id == "proj-1",
    scope.project_id,
)

with mock.patch.object(designs.db, "one", lambda conn, sql, args: None):
    gone = designs.for_run(_Conn(), DOC_RUN)
ok("a run whose design is gone covers nothing", gone.designs == [] and gone.unready == [])

PROJECT_ROWS = [
    {"id": "doc-a", "title": "Customer Portal Proposal", "status": "ready"},
    {"id": "doc-b", "title": "Target Architecture", "status": "ready"},
    {"id": "doc-c", "title": "Data Model", "status": "chunking"},
]
_asked: dict = {}
with mock.patch.object(
    designs.db,
    "query",
    lambda conn, sql, args: _asked.update(sql=sql, args=args) or PROJECT_ROWS,
):
    project = designs.for_run(_Conn(), PROJ_RUN)
ok("a project run covers every finished design", project.designs == [A, B], project.designs)
ok("and names the project it is about", project.project_id == "proj-1", project.project_id)
ok(
    "a design still processing is left out and named",
    project.unready == ["Data Model"],
    project.unready,
)
ok("in the order they were uploaded", 'ORDER BY "createdAt"' in _asked["sql"])
ok(
    "asked for this project, this organisation, designs only",
    _asked["args"] == {"project": "proj-1", "org": "org-1", "role": "assessed"},
    _asked["args"],
)
ok("it is a project run", project.is_project)
ok("the ids go to the search", project.document_ids == ["doc-a", "doc-b"])
ok(
    "the titles go to the judge",
    project.titles == {"doc-a": "Customer Portal Proposal", "doc-b": "Target Architecture"},
)
ok("and it describes itself", designs.describe(project).startswith('"Customer Portal'))

with mock.patch.object(designs.db, "query", lambda conn, sql, args: []):
    empty = designs.for_run(_Conn(), PROJ_RUN)
ok("an empty project covers nothing", empty.designs == [] and not empty.is_project)

with mock.patch.object(
    designs.db,
    "query",
    lambda conn, sql, args: [{"id": "doc-c", "title": "", "status": "parsing"}],
):
    untitled = designs.for_run(_Conn(), PROJ_RUN)
ok(
    "an unready design with no title is named by its id",
    untitled.unready == ["doc-c"],
    untitled.unready,
)


# ---------------------------------------------------------------------------
print("\n2. Every item says which design it is about")

tagged = designs.tag(
    {
        "gaps": [{"section": 4, "quote": "x"}, "not a dict"],
        "suggestions": [{"title": "Already named", "documentId": "doc-z", "documentTitle": "Z"}],
    },
    A,
    keys=("gaps", "suggestions"),
)
ok(
    "a gap carries the design it was found in",
    tagged["gaps"][0]["documentId"] == "doc-a"
    and tagged["gaps"][0]["documentTitle"] == "Customer Portal Proposal",
    tagged["gaps"][0],
)
ok("a reply that already named one keeps it", tagged["suggestions"][0]["documentId"] == "doc-z")
ok("something that is not a dict is left alone", tagged["gaps"][1] == "not a dict")
ok("a missing list is not an error", designs.tag({}, A, keys=("gaps",)) == {})


# ---------------------------------------------------------------------------
print("\n3. Several designs read as one report")

ONE = {
    "state": "complete",
    "note": None,
    "sections": 3,
    "truncated": False,
    "reads": 3,
    "gaps": [{"section": 1, "documentId": "doc-a"}],
    "suggestions": [{"title": "From A"}],
    "dropped": {"unverified": 1, "generic": 0},
    "corrected": {"lineQuote": 2},
    "source": "cache",
    "generatedAt": "2026-09-01T00:00:00",
}
TWO = {
    "state": "failed",
    "note": "The model could not be reached.",
    "sections": 5,
    "truncated": True,
    "reads": 1,
    "gaps": [{"section": 2, "documentId": "doc-b"}],
    "suggestions": [],
    "dropped": {"unverified": 2, "outsideSection": 1},
    "corrected": {"lineQuote": 1},
    "source": "model",
    "generatedAt": "2026-09-20T00:00:00",
}
items = ("gaps", "suggestions")
merged = designs.merge([ONE, TWO], items=items)
ok("one outcome merges to itself", designs.merge([ONE], items=items) is ONE)
ok("nothing merges to nothing", designs.merge([], items=items) == {})
ok(
    "the gaps are kept, in the designs' order, each still naming its design",
    [g["documentId"] for g in merged["gaps"]] == ["doc-a", "doc-b"],
    merged["gaps"],
)
ok("the refusals are added up", merged["dropped"] == {"unverified": 3, "generic": 0, "outsideSection": 1}, merged["dropped"])
ok("so are the replacements", merged["corrected"] == {"lineQuote": 3}, merged["corrected"])
ok("and the sections read", merged["sections"] == 8, merged["sections"])
ok("one shortened design makes the report shortened", merged["truncated"] is True)
ok("the reads are the most any design took", merged["reads"] == 3, merged["reads"])
ok(
    "a design worked out beside one that failed still reports what it has",
    merged["state"] == "complete",
    merged["state"],
)
ok(
    "and says what went wrong with the other",
    merged["note"] == "The model could not be reached.",
    merged["note"],
)
ok("one fresh reply makes the set new, not reused", merged["source"] == "model")
ok("dated by the most recent", merged["generatedAt"] == "2026-09-20T00:00:00")

both_failed = designs.merge(
    [
        {**ONE, "state": "failed", "note": "The model could not be reached."},
        {**TWO, "note": "Also down."},
    ],
    items=items,
)
ok("all designs failing is a failure", both_failed["state"] == "failed", both_failed["state"])
ok(
    "with every distinct reason given once",
    both_failed["note"] == "The model could not be reached. Also down.",
    both_failed["note"],
)
same_note = designs.merge([{**ONE, "note": "Off."}, {**TWO, "note": "Off."}], items=items)
ok("a reason both gave is not said twice", same_note["note"] == "Off.", same_note["note"])
skipped = designs.merge(
    [{**ONE, "state": "skipped", "note": None}, {**TWO, "state": "skipped", "note": None}],
    items=items,
)
ok("all skipped stays skipped, with no note", skipped["state"] == "skipped" and skipped["note"] is None)
reused = designs.merge([ONE, {**TWO, "source": "cache"}], items=items)
ok("reused only when every design's was", reused["source"] == "cache")

deduped = designs.merge(
    [
        {"state": "complete", "technologies": [{"name": "PostgreSQL"}, {"name": "Redis"}]},
        {"state": "complete", "technologies": [{"name": "PostgreSQL"}, {"name": "Kafka"}]},
    ],
    items=("technologies",),
    dedupe={"technologies": "name"},
)
ok(
    "a field marked for it keeps the first of each",
    [t["name"] for t in deduped["technologies"]] == ["PostgreSQL", "Redis", "Kafka"],
    deduped["technologies"],
)


# ---------------------------------------------------------------------------
print("\n4. A diagram is never carried across designs")


def candidate(doc: str, page: int, kind: str = "clause", text: str = "ingestion workers") -> retrieval.Candidate:
    return retrieval.Candidate(
        chunk_id=f"{doc}-{page}-{kind}",
        heading_path="Architecture",
        text=text,
        page_start=page,
        score=1.0,
        vector_rank=1,
        lexical_rank=1,
        source_kind=kind,
        source_id="fig-1" if kind == "figure" else None,
        document_id=doc,
        document_title="A" if doc == "doc-a" else "B",
    )


QUERY = "ingestion workers retention"
window = [candidate("doc-a", 4), candidate("doc-a", 5)]

elsewhere = retrieval.with_figure(window + [candidate("doc-b", 4, "figure")], QUERY, 2)
ok(
    "another design's diagram on the same page number is not carried in",
    [c.chunk_id for c in elsewhere] == ["doc-a-4-clause", "doc-a-5-clause"],
    [c.chunk_id for c in elsewhere],
)
here = retrieval.with_figure(window + [candidate("doc-a", 4, "figure")], QUERY, 2)
ok(
    "its own design's diagram on a page the window reached is",
    [c.chunk_id for c in here] == ["doc-a-4-clause", "doc-a-4-figure"],
    [c.chunk_id for c in here],
)
off_topic = retrieval.with_figure(
    window + [candidate("doc-a", 4, "figure", "a logo and a footer")], QUERY, 2
)
ok("a diagram about something else still is not", len(off_topic) == 2 and not off_topic[-1].is_generated)
ok(
    "and a window that already has one is left alone",
    retrieval.with_figure([candidate("doc-a", 4, "figure")], QUERY, 1)[0].is_generated,
)


# ---------------------------------------------------------------------------
print("\n4b. A bigger design cannot crowd a smaller one out of the window")

# The defect this guards, found by assessing a real project: fusion scores a
# passage against the passages it is ranked with, so one shared window of eight
# went entirely to the 52-chunk proposal and the 18-chunk telemetry design was
# never shown. A clause that design answered outright came back absent, with the
# judge writing "no extract states…" about the only design it had been given.
BIG = [candidate("doc-big", page, text=f"proposal passage {page}") for page in range(1, 9)]
SMALL = [candidate("doc-small", 4, text="data classification is Internal")]

woven = retrieval._woven([BIG, SMALL], 8)
ok(
    "the smaller design's best passage is in the window",
    any(c.document_id == "doc-small" for c in woven),
    [c.chunk_id for c in woven],
)
ok(
    "and it is in before the bigger design's second",
    [c.document_id for c in woven[:2]] == ["doc-big", "doc-small"],
    [c.document_id for c in woven[:2]],
)
ok(
    "every design's window is kept, not truncated to one design's share",
    len([c for c in woven if c.document_id == "doc-big"]) == 8,
    len(woven),
)

# Three designs, each with more passages than the cap allows in total.
many = retrieval._woven([[candidate(f"doc-{n}", p) for p in range(1, 15)] for n in range(3)], 8)
ok(
    "the cap holds however many designs there are",
    len(many) == retrieval.MAX_PASSAGES,
    len(many),
)
ok(
    "and every design is still represented inside it",
    len({c.document_id for c in many}) == 3,
    {c.document_id for c in many},
)
ok("one design weaves to itself", retrieval._woven([BIG], 8) == BIG)
ok("no designs weave to nothing", retrieval._woven([], 8) == [])
ok(
    "a design with nothing to show does not take a slot",
    [c.document_id for c in retrieval._woven([BIG[:2], [], SMALL], 8)]
    == ["doc-big", "doc-small", "doc-big"],
    [c.document_id for c in retrieval._woven([BIG[:2], [], SMALL], 8)],
)


# ---------------------------------------------------------------------------
print("\n5. The judge is told which design it is reading")

named = analyse._render_extracts([candidate("doc-a", 4), candidate("doc-b", 9)], named=True)
ok('each extract names its design', named.count('design="') == 2, named)
plain = analyse._render_extracts([candidate("doc-a", 4)], named=False)
ok("a single-design run says nothing about designs", 'design="' not in plain, plain)
blank = retrieval.Candidate(
    chunk_id="c1", heading_path="H", text="t", page_start=1, score=1.0,
    vector_rank=1, lexical_rank=1,
)
ok(
    "a passage with no design name does not get an empty one",
    'design=""' not in analyse._render_extracts([blank], named=True),
)


# ---------------------------------------------------------------------------
print("\n5b. The judge is told to read the designs as one solution")

# Found by assessing a real project: with the retrieval fixed and both designs
# in the window, the judge still answered about one of them — the prompt around
# the extracts says "the submitted design document", singular, throughout. A
# clause the telemetry design satisfied outright came back absent, the rationale
# naming only the proposal.
ok("one design is told nothing extra", llm._scope_block(1) == "", llm._scope_block(1))
rule = llm._scope_block(3)
ok(
    "several are told a requirement met in any one of them is met",
    "met in any one of these designs is met" in rule,
    rule[:80],
)
ok(
    "that absent means no design engages with it",
    "no design engages with the clause at all" in rule,
)
ok(
    "and that one design behaving does not excuse another contradicting",
    "contradicts" in rule and "does not undo" in rule,
)


def rendered(designs: int) -> str:
    return llm._JUDGE_PROMPT.format(
        reference="Data — 9.3",
        clause="Records are kept for a stated period.",
        extracts="<extract id='c1'>x</extract>",
        precedents="",
        scope_rule=llm._scope_block(designs),
        document_context="",
    )


one, several = rendered(1), rendered(2)
ok("the rule reaches the prompt", "<the_designs_you_are_reading>" in several)
ok("and is absent from a single-design prompt", "<the_designs_you_are_reading>" not in one)
# Byte for byte: a single-design run's verdicts are tuned and cached against
# this prompt, so the placeholder must leave no trace when it is empty.
ok(
    "a single-design prompt is unchanged, to the character",
    one == llm._JUDGE_PROMPT.replace("{scope_rule}", "").format(
        reference="Data — 9.3",
        clause="Records are kept for a stated period.",
        extracts="<extract id='c1'>x</extract>",
        precedents="",
        document_context="",
    ),
)


# ---------------------------------------------------------------------------
print("\n6. A project run searches, and says why")

mode, note, whole = analyse._resolve_mode({**PROJ_RUN, "mode": "document"}, project)
ok("whole-document was asked for and search was used", mode == "retrieval" and whole is None)
ok(
    "and the reason is the page numbers, not a failure",
    note is not None and "ambiguous" in note and "read whole" in note,
    note,
)
mode, note, _ = analyse._resolve_mode({**PROJ_RUN, "mode": "retrieval"}, project)
ok("a project run that asked for search says nothing", mode == "retrieval" and note is None)

said = analyse._with_unready(note, project)
ok(
    "the designs it could not read are named in the note",
    said is not None and 'Not included: "Data Model"' in said,
    said,
)
appended = analyse._with_unready("Something else happened.", project)
ok("beside whatever else the note said", appended.startswith("Something else happened. Not included"), appended)
ok("and nothing is added when every design was read", analyse._with_unready(None, scope) is None)


# ---------------------------------------------------------------------------
print("\n7. What the designs are for")

SUMMARIES = [
    {"id": "doc-a", "summary": "Replaces the customer portal."},
    {"id": "doc-b", "summary": "The target architecture for it."},
]
with mock.patch.object(analyse.db, "query", lambda conn, sql, args: SUMMARIES):
    one_design = analyse._context(_Conn(), scope)
ok(
    "one design's purpose is its own summary, as before",
    one_design == "Replaces the customer portal.",
    one_design,
)
with mock.patch.object(analyse.db, "query", lambda conn, sql, args: SUMMARIES):
    many = analyse._context(_Conn(), project)
ok("several are labelled by design", many.count("=== design:") == 2, many)
ok(
    "under one line saying they are one solution",
    many.startswith("These designs describe one solution"),
    many[:60],
)
with mock.patch.object(analyse.db, "query", lambda conn, sql, args: []):
    ok("no summaries is no context", analyse._context(_Conn(), project) == "")
ok("no designs is no context", analyse._context(_Conn(), designs.Scope([], [])) == "")


# ---------------------------------------------------------------------------
print("\n8. One fact per product, however many designs name it")

folded = lifecycle._collapse(
    [
        {"name": "PostgreSQL", "version": "11", "documentTitle": "A", "pageStart": 4},
        {"name": "postgresql", "version": "11", "documentTitle": "B", "pageStart": 9},
        {"name": "PostgreSQL", "version": "15", "documentTitle": "C"},
        {"name": "Redis", "version": None, "documentTitle": "A"},
        {"name": "Redis", "version": None, "documentTitle": "A"},
        "not a dict",
    ]
)
ok(
    "the same product and version is one row",
    [(t["name"], t["version"]) for t in folded if isinstance(t, dict)]
    == [("PostgreSQL", "11"), ("PostgreSQL", "15"), ("Redis", None)],
    folded,
)
ok("keeping the first design's page", folded[0]["pageStart"] == 4)
ok("and naming the others", folded[0]["alsoIn"] == ["B"], folded[0].get("alsoIn"))
ok("a different version is a different fact", folded[1]["version"] == "15")
ok("the same design twice is not 'also in' itself", "alsoIn" not in folded[2], folded[2])
ok("something that is not a dict survives", "not a dict" in folded)


# ---------------------------------------------------------------------------
print("\n9. The absent re-read reads each design whole")

DESIGN_B = whole_document.build(
    "Target Architecture",
    [
        {"page": 3, "kind": "heading", "text": "5 Retention", "sectionOrdinal": 1},
        {
            "page": 3,
            "kind": "text",
            "text": "Order records are deleted seven years after the order closes.",
            "sectionOrdinal": 1,
        },
    ],
    [],
)
CLAUSE = {
    "id": "c1",
    "numberText": "9.3",
    "headingPath": "Data › 9.3 Retention",
    "documentTitle": "Data Standards",
    "statement": "Records are kept for a stated period.",
    "requirements": [],
    "title": "Retention",
}
REPLY = {
    "clauses": [
        {
            "clause": 1,
            "verdict": "covered",
            "page": 3,
            "quote": "Order records are deleted seven years after the order closes.",
            "rationale": "Seven years is stated.",
        }
    ]
}

written: list[dict] = []
with mock.patch.object(analyse, "_write", lambda *a, **k: written.append(k)):
    answered = analyse._adopt_confirmations(
        PROJ_RUN, [CLAUSE], REPLY, DESIGN_B, B, designs.Scope([A, B], [])
    )
ok("the clause the design answers is reported back", answered == {"c1"}, answered)
ok("and rewritten off absent", written and written[0]["verdict"] == "covered", written)
ok(
    "its evidence says which design, so the reviewer knows the file",
    written[0]["evidence"][0]["documentId"] == "doc-b"
    and written[0]["evidence"][0]["documentTitle"] == "Target Architecture",
    written[0]["evidence"][0],
)
ok(
    "and the rationale names it",
    '"Target Architecture" does address it' in written[0]["rationale"],
    written[0]["rationale"],
)

written.clear()
with mock.patch.object(analyse, "_write", lambda *a, **k: written.append(k)):
    single = analyse._adopt_confirmations(
        DOC_RUN, [CLAUSE], REPLY, DESIGN_B, B, designs.Scope([B], [])
    )
ok("a single-design run keeps the words it always used",
   "the whole document was read again" in written[0]["rationale"], written[0]["rationale"])

written.clear()
INVENTED = {
    "clauses": [
        {"clause": 1, "verdict": "covered", "page": 3, "quote": "Records are kept forever."}
    ]
}
with mock.patch.object(analyse, "_write", lambda *a, **k: written.append(k)):
    none_adopted = analyse._adopt_confirmations(
        PROJ_RUN, [CLAUSE], INVENTED, DESIGN_B, B, designs.Scope([A, B], [])
    )
ok(
    "a quote that is not in that design changes nothing",
    none_adopted == set() and not written,
    (none_adopted, written),
)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
