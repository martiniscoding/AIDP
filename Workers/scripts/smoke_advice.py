"""The checks on "suggested improvements", without a database or a model.

The model's reply is scripted, so what this proves is what the code does with a
reply: a section number that is not a section is dropped, a change to the design
that does not quote it is dropped, a quote that is not in the design — or not in
the section it is claimed for — is refused, a clause reference is kept only when
this run failed that clause, labels the model invented are replaced, and the list
is ordered and capped. Then the run end to end with the database and the model
stubbed: what is stored when it works, when it is switched off, when there is no
key, and when the model fails.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test scripts/smoke_advice.py
"""

from __future__ import annotations

import contextlib
import dataclasses
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import advice, coverage, db, whole_document  # noqa: E402
from aidp import config as config_module  # noqa: E402
from aidp.ai import llm  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


HEADS = [
    {
        "ordinal": 1,
        "title": "Order Platform",
        "headingPath": "Order Platform",
        "pageStart": 1,
        "pageEnd": 1,
    },
    {
        "ordinal": 2,
        "title": "3 Data",
        "headingPath": "Order Platform › 3 Data",
        "pageStart": 2,
        "pageEnd": 3,
    },
    {
        "ordinal": 3,
        "title": "4 Integration",
        "headingPath": "Order Platform › 4 Integration",
        "pageStart": 4,
        "pageEnd": 4,
    },
    {
        "ordinal": 4,
        "title": "5 Access",
        "headingPath": "Order Platform › 5 Access",
        "pageStart": 5,
        "pageEnd": 5,
    },
]
ROWS = [
    {"page": 1, "kind": "heading", "text": "Order Platform", "sectionOrdinal": 1},
    {
        "page": 1,
        "kind": "text",
        "text": "Version 1.2 of the order platform design.",
        "sectionOrdinal": 1,
    },
    {"page": 2, "kind": "heading", "text": "3 Data", "sectionOrdinal": 2},
    {
        "page": 2,
        "kind": "text",
        "text": "Orders are stored in a single PostgreSQL 11 instance in the Toronto region.",
        "sectionOrdinal": 2,
    },
    {
        "page": 3,
        "kind": "text",
        "text": "Nightly backups are written to the same storage array as the database.",
        "sectionOrdinal": 2,
    },
    {"page": 4, "kind": "heading", "text": "4 Integration", "sectionOrdinal": 3},
    {
        "page": 4,
        "kind": "text",
        "text": "Failed calls to the carrier API are retried until they succeed.",
        "sectionOrdinal": 3,
    },
    {"page": 5, "kind": "heading", "text": "5 Access", "sectionOrdinal": 4},
    {
        "page": 5,
        "kind": "text",
        "text": "Support staff share one administrator account for the order console.",
        "sectionOrdinal": 4,
    },
]

sections = coverage.group(HEADS, ROWS)
whole = whole_document.build("Order Platform", ROWS, [])

FAILING = [
    {
        "clauseRef": "Data §9.3",
        "clauseTitle": "Backups are stored separately",
        "verdict": "partial",
        "rationale": "Backups exist but share storage with the database.",
    },
    {
        "clauseRef": "IAM §2.1",
        "clauseTitle": "Named accounts",
        "verdict": "contradicts",
        "rationale": "A shared administrator account is described.",
    },
    {"clauseRef": "Ops §4", "clauseTitle": "Runbooks", "verdict": "needs_review", "rationale": ""},
    {"clauseRef": None, "clauseTitle": None, "verdict": "absent", "rationale": "No ref."},
    {
        "clauseRef": "Sec §1",
        "clauseTitle": "TLS",
        "verdict": "covered",
        "rationale": "Should never be shown.",
    },
]
FAILED = [row for row in FAILING if row["verdict"] in advice.FAILING]


def suggestion(**fields) -> dict:
    base = {
        "title": "Untitled",
        "kind": "improve",
        "category": "resilience",
        "priority": "medium",
        "section": 2,
        "component": "PostgreSQL",
        "quote": "",
        "page": None,
        "recommendation": "Do the thing.",
        "why": "Because.",
        "clauses": [],
    }
    base.update(fields)
    return base


REPLY = {
    "suggestions": [
        suggestion(
            title="Keep backups off the database's storage",
            category="data",
            priority="high",
            component="Nightly backups",
            quote="Nightly backups are written to the same storage array as the database.",
            page=3,
            recommendation="Write backups to storage in another region.",
            clauses=[
                "Data §9.3 — Backups are stored separately",
                "Data §9.3",
                "Sec §1",
                "Made-up §7",
                "",
            ],
        ),
        suggestion(
            title="Add a standby database",
            kind="add",
            priority="high",
            component="PostgreSQL 11",
            recommendation="Run a streaming replica of PostgreSQL in a second region.",
        ),
        suggestion(
            title="Bound the carrier retries",
            category="integration",
            section=3,
            component="carrier API",
            quote="Failed calls to the carrier API are retried until they succeed.",
            page=4,
            recommendation="Retry with exponential backoff, at most five times, then dead-letter.",
        ),
        suggestion(
            title="Named administrator accounts",
            category="security",
            priority="low",
            section=4,
            component="order console",
            quote="Support staff share one administrator account for the order console.",
            page=5,
            clauses=["[IAM §2.1] Named accounts"],
        ),
        suggestion(
            title="An addition keeps going without its unchecked quote",
            kind="add",
            section=3,
            component="carrier API",
            quote="The carrier integration uses mutual TLS everywhere.",
            page=4,
        ),
        # Refused or dropped, one reason each.
        suggestion(title="Change without quoting", kind="improve", quote=""),
        suggestion(
            title="Not a section",
            section=9,
            quote="Orders are stored in a single PostgreSQL 11 instance",
        ),
        suggestion(
            title="Invented words",
            section=2,
            quote="Orders are replicated to three regions synchronously.",
        ),
        suggestion(
            title="Right words, wrong section",
            section=4,
            component="order console",
            quote="Failed calls to the carrier API are retried until they succeed.",
        ),
        suggestion(title="", recommendation="No title."),
        suggestion(title="No recommendation", recommendation="   "),
        suggestion(title="KEEP BACKUPS OFF THE DATABASE'S STORAGE", kind="add", priority="low"),
        suggestion(title="Generic advice", kind="add", component="Kubernetes"),
        suggestion(
            title="Named in two sections and quoted from neither",
            kind="add",
            section=3,
            component="order",
        ),
        # Labels the model invented, on a suggestion that is otherwise sound.
        suggestion(
            title="Plan the PostgreSQL upgrade",
            kind="sideways",
            category="vibes",
            priority="urgent",
            section="2",
            component="PostgreSQL 11",
            quote="Orders are stored in a single PostgreSQL 11 instance in the Toronto region.",
            page=2,
            recommendation="Confirm the support status of PostgreSQL 11 and plan an upgrade path.",
        ),
        suggestion(title="Several names", kind="add", component="PostgreSQL and Redis"),
        suggestion(
            title="Placed by its quote",
            section=2,
            component="carrier API",
            quote="Nightly backups are written to the same storage array as the database.",
            page=3,
        ),
        suggestion(
            title="Moved to the one section that names it",
            kind="add",
            section=4,
            component="carrier API",
        ),
        "not a dict",
    ],
}

print("\nChecking a reply")
checked = advice.check(REPLY, sections, whole, FAILED)
titles = [s["title"] for s in checked.suggestions]
by_title = {s["title"]: s for s in checked.suggestions}
ok("nine sound suggestions kept", len(titles) == 9, titles)
ok(
    "highest priority first, the model's order within a priority",
    titles
    == [
        "Keep backups off the database's storage",
        "Add a standby database",
        "Bound the carrier retries",
        "An addition keeps going without its unchecked quote",
        "Plan the PostgreSQL upgrade",
        "Several names",
        "Placed by its quote",
        "Moved to the one section that names it",
        "Named administrator accounts",
    ],
    titles,
)
ok(
    "a change that does not quote the design is dropped",
    "Change without quoting" not in titles and checked.dropped["missingQuote"] == 1,
    checked.dropped,
)
ok("a number that is not a section is dropped", checked.dropped["unknownSection"] == 1)
ok(
    "a change quoting invented words is refused",
    checked.dropped["unverified"] == 1 and "Invented words" not in titles,
    checked.dropped,
)
ok(
    "a change quoting real words from another section is refused",
    checked.dropped["outsideSection"] == 1,
    checked.dropped,
)
ok("no title or no recommendation is dropped", checked.dropped["empty"] == 2, checked.dropped)
ok("a repeated title, in any case, is kept once", checked.dropped["duplicate"] == 1)
ok(
    "a component the design never names, or one that cannot be placed, is dropped",
    checked.dropped["unanchored"] == 2
    and "Generic advice" not in titles
    and "Named in two sections and quoted from neither" not in titles,
    checked.dropped,
)
ok("nothing over the limit", checked.dropped["overLimit"] == 0)

backups = by_title["Keep backups off the database's storage"]
ok(
    "a kept quote is the design's words, on its page",
    backups["quote"] == "Nightly backups are written to the same storage array as the database."
    and backups["page"] == 3,
    backups,
)
ok(
    "only clauses this run failed are kept, once each, however they were spelled",
    backups["clauses"] == ["Data §9.3"],
    backups["clauses"],
)
ok(
    "a bracketed reference with its title names the clause",
    by_title["Named administrator accounts"]["clauses"] == ["IAM §2.1"],
    by_title["Named administrator accounts"]["clauses"],
)
ok(
    "a suggestion carries its section's place, pages and component",
    backups["section"] == 2
    and backups["headingPath"] == "Order Platform › 3 Data"
    and backups["pageStart"] == 2
    and backups["pageEnd"] == 3
    and backups["component"] == "Nightly backups",
    backups,
)
standby = by_title["Add a standby database"]
ok(
    "an addition may stand without a quote",
    standby["kind"] == "add" and standby["quote"] is None and standby["page"] is None,
    standby,
)
unchecked = by_title["An addition keeps going without its unchecked quote"]
ok(
    "an addition's quote that does not check out is left off, never shown",
    unchecked["quote"] is None and unchecked["page"] is None and unchecked["section"] == 3,
    unchecked,
)
odd = by_title["Plan the PostgreSQL upgrade"]
ok(
    "invented labels are replaced, a numeric-string section accepted",
    odd["kind"] == "improve"
    and odd["category"] == "other"
    and odd["priority"] == "medium"
    and odd["section"] == 2,
    odd,
)
ok(
    "of several names, only those the design uses are kept",
    by_title["Several names"]["component"] == "PostgreSQL",
    by_title["Several names"],
)
placed = by_title["Placed by its quote"]
ok(
    "a component named elsewhere stays where its checked quote is",
    placed["section"] == 2 and placed["component"] == "carrier API" and placed["page"] == 3,
    placed,
)
moved = by_title["Moved to the one section that names it"]
ok(
    "unquoted, it moves to the one section that names its component",
    moved["section"] == 3 and moved["headingPath"] == "Order Platform › 4 Integration",
    moved,
)
ok(
    "a reply that is not the expected shape yields nothing, and raises nothing",
    advice.check({"suggestions": "nope"}, sections, whole, FAILED).suggestions == []
    and advice.check({}, sections, whole, FAILED).suggestions == [],
)

many = {
    "suggestions": [
        suggestion(title=f"Suggestion {i}", kind="add", priority=("low" if i < 10 else "high"))
        for i in range(20)
    ]
}
capped = advice.check(many, sections, whole, FAILED)
ok(
    "capped, keeping the highest priority",
    len(capped.suggestions) == advice.MAX_SUGGESTIONS
    and capped.dropped["overLimit"] == 20 - advice.MAX_SUGGESTIONS
    and all(s["priority"] == "high" for s in capped.suggestions[:10]),
    capped.dropped,
)

print("\nClause references given back")
refs = advice._clause_refs(FAILED + [{"clauseRef": "8.2", "clauseTitle": "Secure Disposal"}])
for spelled, expected in [
    ("Data §9.3", "Data §9.3"),
    ("[Data §9.3]", "Data §9.3"),
    ("[Data §9.3] Backups are stored separately", "Data §9.3"),
    ("data §9.3 — backups are stored separately", "Data §9.3"),
    ("Data §9.3 (Backups are stored separately)", "Data §9.3"),
    ("8.2 — Secure Disposal", "8.2"),
    ("8.2 - Secure Disposal", "8.2"),
    ("8.2", "8.2"),
    ("8.21", None),
    ("Sec §1", None),
    ("Made-up §7", None),
    ("", None),
    (None, None),
]:
    got = advice._clause_ref(spelled, refs)
    ok(f"{spelled!r} names {expected!r}", got == expected, got)

print("\nFindings shown to the model")
rendered = advice.render_findings(FAILING)
lines = rendered.splitlines()
verdicts = [re.search(r" — (\w+)(?::|$)", line).group(1) for line in lines]
ok(
    "only findings that did not pass, worst first",
    verdicts == ["contradicts", "absent", "partial", "needs_review"],
    lines,
)
ok("a passing finding is never shown", "Sec §1" not in rendered)
ok(
    "the reference in brackets, then title, verdict and rationale",
    "- [Data §9.3] Backups are stored separately — partial: Backups exist" in rendered,
    rendered,
)
ok(
    "a finding with no rationale has no dangling colon",
    lines[-1] == "- [Ops §4] Runbooks — needs_review",
    lines[-1],
)
ok("a finding with no reference is still shown", "- (unnamed clause) — absent: No ref." in lines)
ok("no failing findings says so", advice.render_findings([]).startswith("(none"))
long_list = [
    {"clauseRef": f"C{i}", "clauseTitle": "", "verdict": "partial", "rationale": "x"}
    for i in range(advice.MAX_FINDINGS + 7)
]
ok(
    "a long list is cut and says how much was left out",
    advice.render_findings(long_list).endswith("... and 7 more not shown"),
)

print("\nThe prompt and schema")
system = llm._advice_system(
    design="=== S1: {braces} ===\nsome {text}", findings="- none", title='The "Quoted" Design'
)
ok("a design containing braces formats cleanly", "some {text}" in system)
ok("the title's double quotes cannot close the prompt's", "The 'Quoted' Design" in system)
ok("the prompt forbids claims about support status", "end of life" in system)
strict = llm._strict_schema(llm._ADVICE_SCHEMA)
item = strict["properties"]["suggestions"]["items"]
ok(
    "the strict schema requires every field and allows no others",
    set(item["required"]) == set(item["properties"]) and item.get("additionalProperties") is False,
    json.dumps(item)[:400],
)
ok(
    "the optional page is nullable in the strict schema",
    "null" in json.dumps(item["properties"]["page"]),
    item["properties"]["page"],
)

print("\nA run, with the database and the model stubbed")
stored: list[tuple] = []


class FakeConn:
    pass


@contextlib.contextmanager
def fake_connection():
    yield FakeConn()


def fake_execute(conn, sql, params=None):
    stored.append((sql, params))
    return 1


calls: list[dict] = []
real = {
    "connection": db.connection,
    "execute": db.execute,
    "load": coverage._load,
    "failing": advice._failing,
    "available": llm.available,
    "suggest": llm.suggest_improvements,
    "model_name": llm.model_name,
    "get_config": advice.get_config,
}
db.connection = fake_connection
db.execute = fake_execute
coverage._load = lambda conn, document_id: (sections, whole)
advice._failing = lambda conn, run_id: [r for r in FAILING if r["verdict"] in advice.FAILING]
llm.available = lambda: True
llm.model_name = lambda: ("openrouter", "openai/gpt-4.1-mini")


def fake_suggest(*, design, findings, title):
    calls.append({"design": design, "findings": findings, "title": title})
    return REPLY


llm.suggest_improvements = fake_suggest
base_config = real["get_config"]()
advice.get_config = lambda: base_config
RUN = {"id": "run-1", "documentId": "doc-1"}

try:
    result = advice.record(RUN)
    ok(
        "a working run is complete with the checked suggestions",
        result["state"] == "complete"
        and len(result["suggestions"]) == 9
        and result["sections"] == 4
        and result["model"] == "openai/gpt-4.1-mini",
        result,
    )
    ok(
        "the model saw the numbered design, the failing findings and the title",
        calls
        and "=== S3: Order Platform › 4 Integration (page 4) ===" in calls[0]["design"]
        and "[IAM §2.1] Named accounts — contradicts" in calls[0]["findings"]
        and calls[0]["title"] == "Order Platform",
        calls[:1],
    )
    ok(
        "stored on the run's advice column as JSON",
        stored
        and 'SET "advice"' in stored[-1][0]
        and stored[-1][1][1] == "run-1"
        and stored[-1][1][0].obj["state"] == "complete",
        stored[-1:],
    )
    ok(
        "the stored document is plain JSON",
        json.loads(json.dumps(stored[-1][1][0].obj))["version"] == advice.VERSION,
    )

    calls.clear()
    advice.get_config = lambda: dataclasses.replace(base_config, improvement_suggestions=False)
    off = advice.record(RUN)
    ok(
        "switched off: skipped, says how, and never calls the model",
        off["state"] == "skipped" and "IMPROVEMENT_SUGGESTIONS" in off["note"] and not calls,
        off,
    )
    advice.get_config = lambda: base_config

    llm.available = lambda: False
    nokey = advice.record(RUN)
    ok(
        "no key: skipped with a reason",
        nokey["state"] == "skipped" and "API key" in nokey["note"] and not calls,
        nokey,
    )
    llm.available = lambda: True

    coverage._load = lambda conn, document_id: ([], None)
    unparsed = advice.record(RUN)
    ok(
        "no stored pages: skipped, and says to reprocess",
        unparsed["state"] == "skipped" and "Reprocess" in unparsed["note"],
        unparsed,
    )
    coverage._load = lambda conn, document_id: (sections, whole)

    def quota(**_):
        raise llm.QuotaExhausted("credits")

    llm.suggest_improvements = quota
    spent = advice.record(RUN)
    ok(
        "credits used up: failed, says so, and is still stored",
        spent["state"] == "failed"
        and "credits or quota" in spent["note"]
        and stored[-1][1][0].obj["state"] == "failed",
        spent,
    )

    def broken(**_):
        raise RuntimeError("socket closed")

    llm.suggest_improvements = broken
    down = advice.record(RUN)
    ok(
        "model unreachable: failed with a plain reason",
        down["state"] == "failed"
        and "could not be reached" in down["note"]
        and "socket" not in down["note"],
        down,
    )

    llm.suggest_improvements = fake_suggest

    def no_column(conn, sql, params=None):
        raise RuntimeError('column "advice" does not exist')

    db.execute = no_column
    unmigrated = advice.record(RUN)
    ok(
        "an unmigrated database does not raise, and the result is still returned",
        unmigrated["state"] == "complete",
    )
finally:
    db.connection = real["connection"]
    db.execute = real["execute"]
    coverage._load = real["load"]
    advice._failing = real["failing"]
    llm.available = real["available"]
    llm.suggest_improvements = real["suggest"]
    llm.model_name = real["model_name"]
    advice.get_config = real["get_config"]

_ = config_module  # imported so a broken config module fails this script loudly

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
