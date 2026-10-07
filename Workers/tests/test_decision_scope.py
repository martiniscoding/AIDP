"""How far a standing decision reaches, without a database or a model.

A review board allows a breach for one piece of work — a legacy protocol kept
until a migration lands, a pilot exempted while it is a pilot. Recorded with
the only reach the register used to have, that allowance became policy, and the
next design inherited a dispensation nobody had granted it.

What this proves is the part that fails silently. A wrong answer here does not
raise: it hands the judge a precedent from somebody else's project, the clause
comes back "covered" with a cited ruling, and the report looks exactly like a
correct one. So: that both halves of the union filter on reach, that the
project travels from the run's scope into the query, that a run with no project
sees only the organisation-wide rulings, and that the prompt says when a ruling
is local rather than letting the judge read an exemption as policy.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \
      --entrypoint python aidp-worker-test tests/test_decision_scope.py
"""

from __future__ import annotations

import pathlib
import sys

from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import decisions  # noqa: E402

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


def _row(decision_id: str, scope: str = "organisation", **over: object) -> dict:
    row = {
        "id": decision_id,
        "title": "Legacy protocol during migration",
        "statement": "MQTT 3.1 may stay until the gateway migration completes.",
        "rationale": "",
        "effect": "accepts",
        "clauseRef": "3.2",
        "decidedByName": "A. Reviewer",
        "scope": scope,
    }
    row.update(over)
    return row


def _calls(rows_by_sql):
    """Record every query made, and answer from the rows the test supplies."""
    seen: list[dict] = []

    def query(conn, sql, args):
        seen.append({"sql": sql, "args": args})
        for marker, rows in rows_by_sql:
            if marker in sql:
                return rows
        return []

    return seen, query


# ---------------------------------------------------------------------------
print("\n1. Both halves of the union filter on reach")

ok(
    "the anchored lookup checks the scope",
    'AND ("scope" = \'organisation\' OR "projectId" = %(project)s)' in decisions._ANCHORED,
)
ok(
    "and so does the nearest-by-meaning lookup",
    'AND ("scope" = \'organisation\' OR "projectId" = %(project)s)' in decisions._NEAREST,
)
# The distinction the column exists for: a project-scoped row whose project has
# been removed keeps its scope and a null project, so it matches nothing. Were
# this written as "projectId IS NULL means everywhere", that same row would
# have widened into organisation-wide policy the moment the project went.
ok(
    "by scope, never by a null project standing for 'everywhere'",
    '"projectId" IS NULL' not in decisions._ANCHORED
    and '"projectId" IS NULL' not in decisions._NEAREST,
)


# ---------------------------------------------------------------------------
print("\n2. The project travels from the run into the query")

seen, query = _calls([('"clauseRef" = %(clause_ref)s', [_row("d-1", "project")])])
with mock.patch.object(decisions.db, "query", query):
    found = decisions.for_clause(
        _Conn(),
        organisation_id="org-1",
        clause_ref="3.2",
        query="encryption of data at rest",
        limit=1,
        project_id="proj-1",
    )
ok("the anchored lookup is told which project", seen[0]["args"]["project"] == "proj-1")
ok("and the ruling comes back", [d.id for d in found] == ["d-1"], found)
ok("carrying its reach", found[0].scope == "project", found[0].scope)

# Capped at the limit, so a second query only happens when the first half left
# room. Asking for two with one anchored row is what reaches the vector half.
seen, query = _calls(
    [
        ('"clauseRef" = %(clause_ref)s', [_row("d-1")]),
        ("distance", [dict(_row("d-2", "project"), distance=0.1)]),
    ]
)
with (
    mock.patch.object(decisions.db, "query", query),
    mock.patch.object(
        decisions, "get_config", lambda: mock.Mock(embedding_model="gemini-embedding-001")
    ),
):
    found = decisions.for_clause(
        _Conn(),
        organisation_id="org-1",
        clause_ref="3.2",
        query="encryption of data at rest",
        limit=2,
        vector="[0.1,0.2]",
        project_id="proj-1",
    )
ok("the nearest lookup is told too", seen[1]["args"]["project"] == "proj-1", seen[1]["args"])
ok("and both rulings come back", [d.id for d in found] == ["d-1", "d-2"], found)


# ---------------------------------------------------------------------------
print("\n3. A run with no project sees the wide ones only")

# None is not "any project" but "no project": `"projectId" = NULL` is never
# true in SQL, so the clause leaves organisation-wide rulings and nothing else.
# A design uploaded before projects existed must not collect another project's
# dispensations on its way through.
seen, query = _calls([('"clauseRef" = %(clause_ref)s', [_row("d-1")])])
with mock.patch.object(decisions.db, "query", query):
    decisions.for_clause(
        _Conn(),
        organisation_id="org-1",
        clause_ref="3.2",
        query="encryption of data at rest",
        limit=1,
    )
ok("the project is passed as null, not omitted", seen[0]["args"]["project"] is None)
ok("so the parameter is always bound", "project" in seen[0]["args"])


# ---------------------------------------------------------------------------
print("\n4. The prompt says when a ruling is local")

wide = decisions._row_to_decision(_row("d-1"), anchored=True)
local = decisions._row_to_decision(_row("d-2", "project"), anchored=True)

ok("a local ruling is marked as one", "granted to this project alone" in decisions.render([local]))
ok(
    "an organisation-wide one is not labelled at all",
    "granted to this project" not in decisions.render([wide]),
)
ok("both still carry their id for citation", "[decision:d-1]" in decisions.render([wide]))

# Rows written before the column existed, and any reader of them: the absent
# scope is the wide one, which is what those decisions were recorded as.
legacy = _row("d-3")
del legacy["scope"]
ok(
    "a row with no scope reads as organisation-wide",
    decisions._row_to_decision(legacy, anchored=False).scope == "organisation",
)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
