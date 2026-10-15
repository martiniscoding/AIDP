"""Two false "absent" verdicts a client found, checked without a database or a model.

Both are the same complaint from a reviewer's side — the report says a standard
is unaddressed when the design addresses it — and they have different causes, so
they are tested apart.

1. **The clause is answered in another file.** Ten designs are uploaded under one
   project, and a clause answered outright in the architecture deck came back
   absent while the proposal was being graded. That is fixed: a run resolves a
   scope of every ready design and searches all of them per clause, each in its
   own window so the largest file cannot take every slot (`retrieval.search`,
   `_woven`). What this asserts is the property a reviewer actually depends on —
   evidence from document B settles a clause while document A is in hand, the
   search predicate really does carry every document id, and every passage keeps
   the document it came from so "page 12" is an address. Those are the pieces
   that would break silently if someone passed one id again.

2. **The design calls it something else.** A clause asking for an "API Gateway"
   was reported absent against a design whose page 17 describes "API
   Management" — the function is there under the vendor's name for it. Three
   prompts can reach that verdict (search-mode judge, whole-document judge, and
   the re-read that confirms an absent before it is reported), so the rule to
   check the design's own vocabulary before answering absent has to be in all
   three. A rule present in two of them is the bug again on whichever path the
   run happens to take.

Prompt text is asserted, not model behaviour: there is no model here, and the
instruction being in the prompt at all is the part that regressed.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_cross_document_absence.py
"""

from __future__ import annotations

import pathlib
import sys

from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import designs, retrieval  # noqa: E402
from aidp.ai import llm  # noqa: E402

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
    """Stands in for a connection; the query is patched, not run."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


# A project as a customer uploads one: the proposal is long and says nothing
# about an API gateway, and one short design is where that component lives.
PROPOSAL = designs.Design("doc-proposal", "Customer Portal Proposal")
PLATFORM = designs.Design("doc-platform", "Integration Platform Design")
DATA = designs.Design("doc-data", "Data Model")

SCOPE = designs.Scope([PROPOSAL, PLATFORM, DATA], [], project_id="prj-emerald")


def candidate(doc: str, page: int, text: str, title: str = "") -> retrieval.Candidate:
    return retrieval.Candidate(
        chunk_id=f"{doc}-{page}",
        heading_path="Architecture",
        text=text,
        page_start=page,
        score=1.0,
        vector_rank=1,
        lexical_rank=1,
        document_id=doc,
        document_title=title,
    )


# ---------------------------------------------------------------------------
print("\n1. The scope a project run searches")

ok(
    "every ready design is in scope, not just the one the run names",
    SCOPE.document_ids == ["doc-proposal", "doc-platform", "doc-data"],
    SCOPE.document_ids,
)
ok(
    "and each is named, so a page number has a document beside it",
    SCOPE.titles["doc-platform"] == "Integration Platform Design",
    SCOPE.titles,
)
ok("a project run knows it is one", SCOPE.is_project)

# The single-design case has to keep working exactly as it did: this is the
# shape every run had before projects existed.
alone = designs.Scope([PROPOSAL], [])
ok("a single-design run still scopes to one document", alone.document_ids == ["doc-proposal"])
ok("and is not treated as a project", not alone.is_project)

# A design still parsing has no chunks. In scope it would be an empty document,
# and a clause it answers would come back absent on the strength of it.
half_done = designs.Scope([PROPOSAL], ["Integration Platform Design"], project_id="prj-emerald")
ok(
    "a design that is not ready is left out, not searched empty",
    half_done.document_ids == ["doc-proposal"],
)
ok("but it is remembered, so the report can say what it did not read", half_done.unready)


# ---------------------------------------------------------------------------
print("\n2. The search really is given every document")

seen: dict[str, object] = {}


def _fake_in_one(conn, org, document_id, query, limit, vector, names):
    """Records what each per-design search was asked for."""
    seen.setdefault("docs", []).append(document_id)  # type: ignore[union-attr]
    seen["org"] = org
    if document_id == "doc-platform":
        return [
            candidate(
                "doc-platform",
                17,
                "API Management publishes every partner endpoint.",
                names.get("doc-platform", ""),
            )
        ]
    if document_id == "doc-proposal":
        return [candidate("doc-proposal", 4, "The portal replaces the extranet.", names.get("doc-proposal", ""))]
    return []


with mock.patch.object(retrieval, "_in_one", _fake_in_one):
    found = retrieval.search(
        _Conn(),
        organisation_id="org-1",
        document_ids=SCOPE.document_ids,
        titles=SCOPE.titles,
        query="API gateway for partner traffic",
        limit=8,
        vector="[0]",
    )

ok(
    "every design in the project was searched, not only the first",
    seen.get("docs") == ["doc-proposal", "doc-platform", "doc-data"],
    seen.get("docs"),
)
ok("the tenant filter is carried on the path that reads chunks", seen.get("org") == "org-1")

# The point of the whole feature: grading with the proposal in hand, the
# passage that answers the clause comes from a different file.
from_elsewhere = [c for c in found if c.document_id != "doc-proposal"]
ok(
    "evidence from another design is returned while grading this one",
    bool(from_elsewhere),
    [c.document_id for c in found],
)
ok(
    "and it is the passage that answers the clause",
    any("API Management" in c.text for c in from_elsewhere),
    [c.text for c in from_elsewhere],
)
ok(
    "each passage still says which design it came from",
    all(c.document_id for c in found),
    [(c.document_id, c.page_start) for c in found],
)
ok(
    "and which file to open, by name",
    any(c.document_title == "Integration Platform Design" for c in found),
    [c.document_title for c in found],
)

# A single-document search must not pay for the weave, and must still work.
one_seen: list[str] = []


def _one(conn, org, document_id, query, limit, vector, names):
    one_seen.append(document_id)
    return [candidate(document_id, 1, "text", names.get(document_id, ""))]


with mock.patch.object(retrieval, "_in_one", _one):
    retrieval.search(
        _Conn(),
        organisation_id="org-1",
        document_ids=["doc-proposal"],
        query="anything",
        limit=8,
        vector="[0]",
    )
ok("one design is searched once", one_seen == ["doc-proposal"], one_seen)

# Nothing to search is not an error.
ok(
    "no designs returns nothing rather than raising",
    retrieval.search(
        _Conn(), organisation_id="org-1", document_ids=[], query="q", limit=8, vector="[0]"
    )
    == [],
)


# ---------------------------------------------------------------------------
print("\n3. The judge is shown which design each passage is from")

from aidp.stages import analyse  # noqa: E402

mixed = [
    candidate("doc-proposal", 4, "The portal replaces the extranet.", "Customer Portal Proposal"),
    candidate("doc-platform", 17, "API Management publishes every partner endpoint.", "Integration Platform Design"),
]
block = analyse._render_extracts(mixed, named=True)
ok(
    "a project run names the design on every extract",
    block.count('design="') == 2,
    block,
)
ok(
    "by the title a reviewer sees in the UI",
    'design="Integration Platform Design"' in block,
    block,
)
ok("and keeps the page, so the citation is a location", "page=17" in block, block)

alone_block = analyse._render_extracts(mixed[:1], named=False)
ok(
    "a single-design run adds no design attribute",
    'design="' not in alone_block,
    alone_block,
)


# ---------------------------------------------------------------------------
print("\n4. Every prompt that can answer 'absent' checks the design's own words")

# The three paths to an absent verdict. Each is rendered the way its caller
# renders it, so a broken placeholder fails here rather than in a run.
PROMPTS = {
    "search-mode judge": llm._JUDGE_PROMPT.format(
        scope_rule="",
        document_context="",
        reference="Security Standards — 5.2",
        clause="An API gateway shall front all external traffic.",
        extracts='<extract id="c1" location="Architecture" page=17>API Management publishes every partner endpoint.</extract>',
        precedents="",
    ),
    "whole-document judge": llm._DOCUMENT_JUDGE_SYSTEM.format(
        document="=== PAGE 17 ===\nAPI Management publishes every partner endpoint."
    ),
    "absent re-read": llm._CONFIRM_SYSTEM.format(
        document="=== PAGE 17 ===\nAPI Management publishes every partner endpoint."
    ),
}

for name, text in PROMPTS.items():
    lower = text.lower()
    ok(
        f"{name}: says to check what the design calls it before 'absent'",
        "api management" in lower,
        name,
    )
    ok(
        f"{name}: allows a vendor or product name to count",
        "product name" in lower or "platform service" in lower,
        name,
    )
    ok(
        f"{name}: forbids 'absent' merely because the clause's term is missing",
        "any name" in lower,
        name,
    )
    # The instruction is worthless if it does not reach the verdict list.
    ok(f"{name}: still offers the absent verdict it is qualifying", '"absent"' in text, name)
    ok(f"{name}: left no placeholder unfilled", "{document}" not in text and "{extracts}" not in text, name)

# Several naming conventions, not one worked example: the client's was API
# Management, the next one will not be.
synonyms = ("identity provider", "waf", "secrets manager", "replica", "kafka")
for name, text in PROMPTS.items():
    lower = text.lower()
    missing = [s for s in synonyms if s not in lower]
    ok(f"{name}: gives more than one kind of alias", not missing, missing)


# ---------------------------------------------------------------------------
print("\n5. The rule narrows 'absent' without weakening a real one")

doc_judge = PROMPTS["whole-document judge"].lower()
ok(
    "silence on the mechanism is still absent",
    "silence on the mechanism is what counts" in doc_judge,
)
ok(
    "a neighbouring subject still does not answer the clause",
    "neighbouring" in doc_judge,
)
ok(
    "a breach is still never softened",
    "never softened to" in doc_judge or "contradicts" in doc_judge,
)

reread = PROMPTS["absent re-read"].lower()
ok(
    "the re-read still requires an exact quote to overturn absent",
    "word for word" in reread,
)
ok(
    "and still weighs a search miss against a real silence",
    "weigh both answers evenly" in reread,
)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
