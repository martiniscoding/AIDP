"""Does "the same design gets the same suggestions" hold — and only when it should?

The model is stubbed with a counter, so "the second ask never reached the model"
is measured rather than assumed. The cache is the real `ai_cache` table, under a
throwaway organisation deleted at the end, so this can run against a live
database without touching anyone's rows. The two checks that need a real run
(`mark_advice_failed`) run inside a transaction that is rolled back.

    docker run --rm -v "$PWD/Workers":/w -w /w --env-file Workers/.env \\
      --entrypoint python workers-analyse scripts/test_advice_cache.py
"""

from __future__ import annotations

import contextlib
import dataclasses
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

if not os.environ.get("DATABASE_URL"):
    _ENV = pathlib.Path(__file__).resolve().parents[2] / "AIDP" / ".env.local"
    for line in _ENV.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"'))
os.environ.setdefault("STAGE", "analyse")

import psycopg  # noqa: E402
from psycopg.types.json import Jsonb  # noqa: E402

from aidp import __main__ as worker  # noqa: E402
from aidp import advice, cache, coverage, db, whole_document  # noqa: E402
from aidp.ai import llm  # noqa: E402
from aidp.stages import analyse  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


ORG = "zz-advice-cache-test-org"
OTHER = ORG + "-b"

HEADS = [
    {"ordinal": 1, "title": "Order Platform", "headingPath": "Order Platform",
     "pageStart": 1, "pageEnd": 1},
    {"ordinal": 2, "title": "3 Data", "headingPath": "Order Platform › 3 Data",
     "pageStart": 2, "pageEnd": 2},
    {"ordinal": 3, "title": "4 Integration", "headingPath": "Order Platform › 4 Integration",
     "pageStart": 3, "pageEnd": 3},
]


def rows_for(backup_line: str) -> list[dict]:
    return [
        {"page": 1, "kind": "heading", "text": "Order Platform", "sectionOrdinal": 1},
        {"page": 1, "kind": "text", "text": "Version 1.2 of the order platform design.",
         "sectionOrdinal": 1},
        {"page": 2, "kind": "heading", "text": "3 Data", "sectionOrdinal": 2},
        {"page": 2, "kind": "text",
         "text": "Orders are stored in a single PostgreSQL 11 instance in the Toronto region.",
         "sectionOrdinal": 2},
        {"page": 2, "kind": "text", "text": backup_line, "sectionOrdinal": 2},
        {"page": 3, "kind": "heading", "text": "4 Integration", "sectionOrdinal": 3},
        {"page": 3, "kind": "text",
         "text": "Failed calls to the carrier API are retried until they succeed.",
         "sectionOrdinal": 3},
    ]


BACKUP = "Nightly backups are written to the same storage array as the database."
ROWS = rows_for(BACKUP)
SECTIONS = coverage.group(HEADS, ROWS)
WHOLE = whole_document.build("Order Platform", ROWS, [])

# The run's failing findings, then the same design on a later run where one
# verdict came back differently — the drift the key deliberately ignores.
FAILING_A = [
    {"clauseRef": "Data §9.3", "clauseTitle": "Backups are stored separately",
     "verdict": "partial", "rationale": "Backups share storage with the database."},
    {"clauseRef": "IAM §2.1", "clauseTitle": "Named accounts",
     "verdict": "contradicts", "rationale": "A shared account."},
]
FAILING_B = [FAILING_A[1]]


def suggestion(**fields) -> dict:
    base = {
        "title": "Untitled", "kind": "improve", "category": "resilience",
        "priority": "medium", "section": 2, "component": "PostgreSQL", "quote": "",
        "page": None, "recommendation": "Do the thing.", "why": "Because.", "clauses": [],
    }
    base.update(fields)
    return base


REPLY_1 = {
    "suggestions": [
        suggestion(
            title="Keep backups off the database's storage",
            priority="high", category="data", component="Nightly backups",
            quote=BACKUP, page=2,
            recommendation="Write backups to storage in another region.",
            clauses=["Data §9.3"],
        ),
        suggestion(
            title="Bound the carrier retries",
            section=3, category="integration", component="carrier API",
            quote="Failed calls to the carrier API are retried until they succeed.", page=3,
            recommendation="Retry with backoff, at most five times, then dead-letter.",
        ),
    ]
}
REPLY_2 = {
    "suggestions": [
        suggestion(
            title="Replicate PostgreSQL to a second region",
            kind="add", priority="high", component="PostgreSQL 11",
            recommendation="Run a streaming replica of PostgreSQL in a second region.",
        ),
    ]
}


class Model:
    """Stands in for the provider: counts every call and returns what it is told."""

    def __init__(self) -> None:
        self.calls = 0
        self.reply: dict = REPLY_1
        self.error: Exception | None = None

    def __call__(self, *, design: str, findings: str, title: str) -> dict:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.reply


def titles(result: dict) -> list[str]:
    return [s["title"] for s in result["suggestions"]]


def by_title(result: dict, title: str) -> dict:
    return next(s for s in result["suggestions"] if s["title"] == title)


def advice_rows(org: str) -> int:
    with db.connection() as conn:
        row = db.one(
            conn,
            'SELECT count(*)::int AS n FROM "ai_cache" WHERE "organisationId" = %s AND "kind" = %s',
            (org, cache.ADVICE),
        )
    return row["n"] if row else 0


def age_rows(org: str, days: int) -> None:
    with db.connection() as conn:
        db.execute(
            conn,
            'UPDATE "ai_cache" SET "createdAt" = now() - make_interval(days => %s) '
            'WHERE "organisationId" = %s AND "kind" = %s',
            (days, org, cache.ADVICE),
        )


def age_exactly(org: str, interval: str) -> None:
    """Back-date the organisation's suggestion rows by a precise interval."""
    with db.connection() as conn:
        db.execute(
            conn,
            'UPDATE "ai_cache" SET "createdAt" = now() - %s::interval '
            'WHERE "organisationId" = %s AND "kind" = %s',
            (interval, org, cache.ADVICE),
        )


def created_at(org: str):
    with db.connection() as conn:
        row = db.one(
            conn,
            'SELECT max("createdAt") AS t FROM "ai_cache" WHERE "organisationId" = %s AND "kind" = %s',
            (org, cache.ADVICE),
        )
    return row["t"] if row else None


def plant(org: str, kind: str, fingerprint: str, age: str) -> None:
    """A stored row of a given age, as if written that long ago."""
    with db.connection() as conn:
        db.execute(
            conn,
            'INSERT INTO "ai_cache" ("id","organisationId","kind","fingerprint","model",'
            '"payload","costTokens","hits","lastUsedAt","createdAt") '
            "VALUES (%s,%s,%s,%s,'test',%s,0,0,now(),now() - %s::interval)",
            (db.new_id(), org, kind, fingerprint,
             Jsonb({"raw": {"suggestions": []}}) if kind == cache.ADVICE else None, age),
        )


def fingerprints(org: str) -> set[str]:
    with db.connection() as conn:
        rows = db.query(
            conn,
            'SELECT "kind" || \':\' || "fingerprint" AS k FROM "ai_cache" WHERE "organisationId" = %s',
            (org,),
        )
    return {row["k"] for row in rows}


model = Model()
real = {
    "load": coverage._load,
    "failing": advice._failing,
    "standards": advice._read_standards,
    "available": llm.available,
    "suggest": llm.suggest_improvements,
    "model_name": llm.model_name,
    "prompt": llm.advice_prompt_identity,
    "get_config": advice.get_config,
    "one": db.one,
    "connection": db.connection,
}
state: dict = {
    "sections": SECTIONS,
    "whole": WHOLE,
    "failing": FAILING_A,
    "standards": "standards-v1",
    "model": ("openrouter", "openai/gpt-4.1-mini"),
}
base_config = dataclasses.replace(
    real["get_config"](), improvement_suggestions=True, advice_cache_days=90
)
state["config"] = base_config

coverage._load = lambda conn, document_id: (state["sections"], state["whole"])
advice._failing = lambda conn, run_id: state["failing"]
advice._read_standards = lambda run: state["standards"]
llm.available = lambda: True
llm.suggest_improvements = model
llm.model_name = lambda: state["model"]
advice.get_config = lambda: state["config"]

RUN = {"id": "zz-run", "documentId": "zz-doc", "organisationId": ORG, "frameworkId": "zz-fw"}

with db.connection() as conn:
    for org_id, name in ((ORG, "ZZ Advice Cache Test"), (OTHER, "ZZ Advice Cache Test B")):
        db.execute(
            conn,
            'INSERT INTO "organisation" ("id","name","slug","createdAt","updatedAt") '
            "VALUES (%(id)s,%(n)s,%(s)s,%(t)s,%(t)s) ON CONFLICT DO NOTHING",
            {"id": org_id, "n": name, "s": org_id, "t": db.now()},
        )

try:
    print("\n1. The first ask pays the model and stores the reply")
    first = advice.work_out(RUN)
    ok("model called once", model.calls == 1, model.calls)
    ok("says it came from the model", first["source"] == "model", first.get("source"))
    ok("records when it was worked out", bool(first["generatedAt"]))
    ok("one advice row stored for the organisation", advice_rows(ORG) == 1, advice_rows(ORG))
    ok(
        "the failing clause it helps with is kept",
        by_title(first, "Keep backups off the database's storage")["clauses"] == ["Data §9.3"],
    )

    print("\n2. The same design again: no model call, the same suggestions")
    second = advice.work_out(RUN)
    ok("model NOT called again", model.calls == 1, model.calls)
    ok("says it was reused", second["source"] == "cache", second.get("source"))
    ok("same suggestions, same order", titles(second) == titles(first))
    ok("keeps the original date", second["generatedAt"] == first["generatedAt"],
       (second["generatedAt"], first["generatedAt"]))
    ok("quotes still checked and present",
       by_title(second, "Bound the carrier retries")["quote"] is not None)

    print("\n3. Verdicts drifted, design unchanged: still reused, clause links re-checked")
    state["failing"] = FAILING_B
    drifted = advice.work_out(RUN)
    ok("model NOT called", model.calls == 1, model.calls)
    ok("reused", drifted["source"] == "cache")
    ok("same suggestions", titles(drifted) == titles(first))
    ok(
        "link to a clause this run did not fail is dropped",
        by_title(drifted, "Keep backups off the database's storage")["clauses"] == [],
        by_title(drifted, "Keep backups off the database's storage")["clauses"],
    )
    state["failing"] = FAILING_A

    print("\n4. A changed design is a new question")
    changed_rows = rows_for("Nightly backups are written to object storage in another region.")
    state["sections"] = coverage.group(HEADS, changed_rows)
    state["whole"] = whole_document.build("Order Platform", changed_rows, [])
    calls = model.calls
    changed = advice.work_out(RUN)
    ok("model called for the changed design", model.calls == calls + 1)
    ok("from the model", changed["source"] == "model")
    state["sections"], state["whole"] = SECTIONS, WHOLE
    calls = model.calls
    back = advice.work_out(RUN)
    ok("the original design still reuses its own entry", model.calls == calls
       and back["source"] == "cache" and titles(back) == titles(first))

    print("\n5. Changed standards, model or prompt each miss")
    for label, setup, undo in (
        ("standards", lambda: state.update(standards="standards-v2"),
         lambda: state.update(standards="standards-v1")),
        ("model", lambda: state.update(model=("openrouter", "openai/gpt-4.1")),
         lambda: state.update(model=("openrouter", "openai/gpt-4.1-mini"))),
        ("prompt", lambda: setattr(llm, "advice_prompt_identity", lambda: real["prompt"]() + "!"),
         lambda: setattr(llm, "advice_prompt_identity", real["prompt"])),
    ):
        setup()
        calls = model.calls
        result = advice.work_out(RUN)
        ok(f"a changed {label} asks the model", model.calls == calls + 1
           and result["source"] == "model")
        undo()
    calls = model.calls
    ok("and with everything restored it is reused again",
       advice.work_out(RUN)["source"] == "cache" and model.calls == calls)

    print("\n6. A fresh set asks again and replaces the stored one")
    stored_before = advice_rows(ORG)
    model.reply = REPLY_2
    calls = model.calls
    fresh = advice.work_out(RUN, fresh=True)
    ok("model called despite a stored reply", model.calls == calls + 1)
    ok("the new set is returned", titles(fresh) == ["Replicate PostgreSQL to a second region"],
       titles(fresh))
    ok("replaced, not added", advice_rows(ORG) == stored_before, advice_rows(ORG))
    calls = model.calls
    after = advice.work_out(RUN)
    ok("the next ask reuses the NEW set", model.calls == calls and titles(after) == titles(fresh))
    ok("dated from the fresh ask", after["generatedAt"] == fresh["generatedAt"])
    model.reply = REPLY_1

    print("\n7. Reuse ends after the configured number of days")
    age_rows(ORG, 89)
    calls = model.calls
    ok("89 days old: still reused", advice.work_out(RUN)["source"] == "cache"
       and model.calls == calls)
    age_rows(ORG, 91)
    calls = model.calls
    expired = advice.work_out(RUN)
    ok("91 days old: asks again", model.calls == calls + 1 and expired["source"] == "model")
    calls = model.calls
    ok("and the renewed entry is reused", advice.work_out(RUN)["source"] == "cache"
       and model.calls == calls)

    print("\n8. ADVICE_CACHE_DAYS=0 turns reuse off entirely")
    state["config"] = dataclasses.replace(base_config, advice_cache_days=0)
    stored_before = advice_rows(ORG)
    calls = model.calls
    advice.work_out(RUN)
    advice.work_out(RUN)
    ok("the model is asked every time", model.calls == calls + 2)
    ok("nothing stored or renewed", advice_rows(ORG) == stored_before)
    state["config"] = base_config

    print("\n9. One organisation never reads another's suggestions")
    calls = model.calls
    theirs = advice.work_out({**RUN, "organisationId": OTHER})
    ok("the other organisation pays for its own", model.calls == calls + 1
       and theirs["source"] == "model")

    print("\n10. No reuse when an input cannot be read")
    advice._read_standards = lambda run: None
    stored_before = advice_rows(ORG)
    calls = model.calls
    unread = advice.work_out(RUN)
    ok("standards unreadable: asks the model", model.calls == calls + 1
       and unread["source"] == "model")
    ok("and stores nothing under a key missing an input", advice_rows(ORG) == stored_before)
    advice._read_standards = lambda run: state["standards"]

    calls = model.calls
    stored_before = sum(advice_rows(org) for org in (ORG, OTHER))
    orphan = advice.work_out({"id": "zz-run", "documentId": "zz-doc"})
    ok("a run with no organisation never touches the cache", model.calls == calls + 1
       and orphan["source"] == "model"
       and sum(advice_rows(org) for org in (ORG, OTHER)) == stored_before)

    print("\n11. A cache that cannot be read never fails the suggestions")

    def broken_one(conn, sql, params=None):
        if '"ai_cache"' in sql:
            raise RuntimeError("cache table unavailable")
        return real["one"](conn, sql, params)

    db.one = broken_one
    calls = model.calls
    survived = advice.work_out(RUN)
    db.one = real["one"]
    ok("still complete, from the model", survived["state"] == "complete"
       and survived["source"] == "model" and model.calls == calls + 1)

    print("\n12. A fresh set that fails keeps the suggestions already on the report")
    previous = advice.work_out(RUN)
    model.error = llm.QuotaExhausted("credits")
    kept = advice.record({**RUN, "advice": {**previous, "refreshing": True}}, fresh=True)
    ok("still complete, with the earlier suggestions", kept["state"] == "complete"
       and titles(kept) == titles(previous))
    ok("no longer marked in progress", kept["refreshing"] is False)
    ok("says why the new set failed", "credits or quota" in (kept.get("refreshError") or ""),
       kept.get("refreshError"))
    # An ordinary run on the same design never reaches the failing model — the
    # stored set answers it — so that case is checked with reuse switched off.
    reused_while_down = advice.record({**RUN, "advice": previous}, fresh=False)
    ok(
        "with the model down, an unchanged design is still answered from the cache",
        reused_while_down["state"] == "complete" and reused_while_down["source"] == "cache",
        reused_while_down.get("state"),
    )
    state["config"] = dataclasses.replace(base_config, advice_cache_days=0)
    plain = advice.record({**RUN, "advice": previous}, fresh=False)
    ok("an ordinary run that cannot reach the model still says failed",
       plain["state"] == "failed", plain.get("state"))
    state["config"] = base_config
    model.error = None
    recovered = advice.record({**RUN, "advice": kept}, fresh=True)
    ok("a later fresh set that works clears the error", recovered["state"] == "complete"
       and "refreshError" not in recovered and recovered["refreshing"] is False)

    print("\n13. The standards query, against the real library")
    with db.connection() as conn:
        framework = real["one"](
            conn,
            'SELECT fd."frameworkId" FROM "framework_document" fd '
            'JOIN "document_section" s ON s."documentId" = fd."documentId" '
            'JOIN "clause" cl ON cl."sectionId" = s."id" LIMIT 1',
        )
        if framework is None:
            print("  SKIP no framework with clauses in this database")
        else:
            once = advice._standards(conn, framework["frameworkId"])
            twice = advice._standards(conn, framework["frameworkId"])
            ok("reads a non-empty clause set", len(once) > 0, len(once))
            ok("reads the same string every time", once == twice)
    ok("real _read_standards turns reuse off for a run with no framework",
       real["standards"]({"id": "x", "organisationId": ORG}) is None)

    print("\n14. A dead-lettered request for fresh suggestions leaves the run alone")
    with db.connection() as conn:
        target = real["one"](
            conn,
            'SELECT "id", "state", "advice" FROM "assessment_run" '
            "WHERE \"state\" = 'complete' AND \"advice\" IS NOT NULL "
            'ORDER BY "startedAt" DESC LIMIT 1',
        )
        if target is None:
            print("  SKIP no finished run with suggestions in this database")
        else:
            before = len((target["advice"] or {}).get("suggestions") or [])
            try:
                with conn.transaction() as tx:

                    @contextlib.contextmanager
                    def same_connection():
                        yield conn

                    db.connection = same_connection
                    analyse.mark_advice_failed(target["id"])
                    db.connection = real["connection"]
                    row = real["one"](
                        conn,
                        'SELECT "state", "advice" FROM "assessment_run" WHERE "id" = %s',
                        (target["id"],),
                    )
                    marked = row["advice"] or {}
                    ok("the run is still complete", row["state"] == "complete", row["state"])
                    ok("no longer marked in progress", marked.get("refreshing") is False)
                    ok("says the request failed", "could not be worked out"
                       in (marked.get("refreshError") or ""))
                    ok("its suggestions are untouched",
                       len(marked.get("suggestions") or []) == before)
                    raise psycopg.Rollback(tx)
            finally:
                db.connection = real["connection"]
            again = real["one"](
                conn, 'SELECT "advice" FROM "assessment_run" WHERE "id" = %s', (target["id"],)
            )
            ok("and the rehearsal was rolled back",
               (again["advice"] or {}).get("refreshError") == (target["advice"] or {}).get(
                   "refreshError"
               ))

    print("\n15. The 90-day edge, to the minute")
    model.error = None
    advice.work_out(RUN, fresh=True)
    age_exactly(ORG, "89 days 23:59:00")
    calls = model.calls
    edge_in = advice.work_out(RUN)
    ok("one minute before 90 days: still reused", edge_in["source"] == "cache"
       and model.calls == calls, edge_in["source"])
    age_exactly(ORG, "89 days 23:59:00")
    kept_before = advice_rows(ORG)
    cache.sweep(cache.ADVICE, max_age_days=90)
    ok("and a sweep does not delete it", kept_before >= 1 and advice_rows(ORG) == kept_before,
       (kept_before, advice_rows(ORG)))
    age_exactly(ORG, "90 days 00:01:00")
    calls = model.calls
    edge_out = advice.work_out(RUN)
    ok("one minute past 90 days: asks the model again", edge_out["source"] == "model"
       and model.calls == calls + 1, edge_out["source"])

    print("\n16. Using a stored set does not extend its life")
    stamped = created_at(ORG)
    advice.work_out(RUN)
    advice.work_out(RUN)
    ok("two reuses later, still dated from when it was worked out",
       created_at(ORG) == stamped, (stamped, created_at(ORG)))
    ok("only a fresh ask starts the clock again", (
        advice.work_out(RUN, fresh=True) and created_at(ORG) > stamped))

    print("\n17. Expired suggestions are deleted, not just ignored")
    for label, age in (("30d", "30 days"), ("89d", "89 days 23:59:00"),
                       ("91d", "90 days 00:01:00"), ("200d", "200 days")):
        plant(ORG, cache.ADVICE, f"zz-sweep-{label}", age)
    plant(ORG, cache.EMBEDDING, "zz-sweep-embedding", "200 days")
    deleted = cache.sweep(cache.ADVICE, max_age_days=90)
    left = fingerprints(ORG)
    ok("the two past 90 days are gone", "advice:zz-sweep-91d" not in left
       and "advice:zz-sweep-200d" not in left, sorted(left))
    ok("the two inside 90 days stay", {"advice:zz-sweep-30d", "advice:zz-sweep-89d"} <= left)
    ok("an old embedding is not touched", "embedding:zz-sweep-embedding" in left)
    ok("the live entry for the design stays", advice_rows(ORG) == 3, advice_rows(ORG))
    ok("reports how many it deleted", deleted >= 2, deleted)

    plant(ORG, cache.ADVICE, "zz-sweep-paused", "200 days")
    ok("with reuse switched off (0 days) nothing is deleted",
       cache.sweep(cache.ADVICE, max_age_days=0) == 0
       and "advice:zz-sweep-paused" in fingerprints(ORG))

    def failing_execute(conn, sql, params=None):
        raise RuntimeError("database away")

    real_execute = db.execute
    db.execute = failing_execute
    try:
        swept = cache.sweep(cache.ADVICE, max_age_days=90)
    finally:
        db.execute = real_execute
    ok("a failed sweep returns 0 instead of raising", swept == 0)

    print("\n18. The worker's expiry thread")
    worker._shutdown.set()
    try:
        worker._expire_suggestions(90, interval=0.01)
    finally:
        worker._shutdown.clear()
    ok("runs a sweep at once and stops on shutdown",
       "advice:zz-sweep-paused" not in fingerprints(ORG))

finally:
    coverage._load = real["load"]
    advice._failing = real["failing"]
    advice._read_standards = real["standards"]
    llm.available = real["available"]
    llm.suggest_improvements = real["suggest"]
    llm.model_name = real["model_name"]
    llm.advice_prompt_identity = real["prompt"]
    advice.get_config = real["get_config"]
    db.one = real["one"]
    db.connection = real["connection"]
    with db.connection() as conn:
        db.execute(conn, 'DELETE FROM "organisation" WHERE "id" = ANY(%s)', ([ORG, OTHER],))
    left = advice_rows(ORG) + advice_rows(OTHER)
    ok("cleanup: the throwaway organisations' cache rows are gone", left == 0, left)
    db.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
