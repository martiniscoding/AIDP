"""The technology support check against the real endoflife.date and database.

The model is stubbed with a counter; endoflife.date is real, with every request
recorded, so both "the dates are read correctly" and "only product ids went out"
are checked against the live service. The extraction cache is the real table,
under a throwaway organisation deleted at the end.

    docker run --rm -v "$PWD/Workers":/w -w /w --env-file Workers/.env \\
      --entrypoint python workers-analyse scripts/test_lifecycle_live.py
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
os.environ.setdefault("STAGE", "analyse")

import httpx  # noqa: E402

from aidp import cache, coverage, db, lifecycle, whole_document  # noqa: E402
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


requested: list[str] = []
real_get = httpx.get


def recording_get(url, **kwargs):
    requested.append(url)
    return real_get(url, **kwargs)


httpx.get = recording_get
TODAY = dt.date(2026, 9, 19)

print("\n1. The real product list")
known = lifecycle.products()
ok("over 400 products", len(known) > 400, len(known))
ok("PostgreSQL, with its aliases", "postgresql" in known and "postgres" in known["postgresql"].aliases)
ok("every id is a plain slug", all(lifecycle._SLUG.fullmatch(pid) for pid in known))

print("\n2. Real release data, read correctly")


def status(product: str, version: str) -> dict:
    return lifecycle._status(
        {"name": product, "product": product, "label": known[product].label, "version": version},
        TODAY,
        365,
    )


pg = status("postgresql", "11")
ok("PostgreSQL 11 ended 9 Nov 2023, last 11.22", pg["status"] == "ended"
   and pg["eol"] == "2023-11-09" and pg["latest"] == "11.22", pg)
ok("and the line to move to is newer than 17", pg["upgradeTo"] is not None
   and int(pg["upgradeTo"]) >= 18, pg["upgradeTo"])
ng = status("angular", "12.2")
ok("Angular 12.2 is line 12, ended 12 Nov 2022", ng["cycle"] == "12" and ng["status"] == "ended"
   and ng["eol"] == "2022-11-12", ng)
sb = status("spring-boot", "2.7.3")
ok("Spring Boot 2.7.3 ended, paid support until 30 Jun 2029", sb["cycle"] == "2.7"
   and sb["status"] == "ended" and sb["extendedSupport"] == "2029-06-30", sb)
jv = status("eclipse-temurin", "1.8")
ok("Java 1.8 on Temurin is LTS line 8, supported to 31 Dec 2030", jv["cycle"] == "8"
   and jv["lts"] is True and jv["status"] == "supported" and jv["eol"] == "2030-12-31", jv)
nd = status("nodejs", "18")
ok("Node.js 18 ended 30 Apr 2025", nd["status"] == "ended" and nd["eol"] == "2025-04-30", nd)
un = status("postgresql", "")
ok("PostgreSQL with no version: unversioned, with the current line",
   un["status"] == "unversioned" and un["current"] is not None, un)

print("\n3. The real service's failures")
try:
    lifecycle.releases("zz-not-a-product")
    ok("an unknown product is a 404", False, "no exception")
except lifecycle.NotFound:
    ok("an unknown product is a 404, recognised as such", True)
ok("and is reported as not checked, not as an error",
   lifecycle._status({"name": "x", "product": "zz-not-a-product", "label": "x", "version": "1"},
                     TODAY, 365)["status"] == "unchecked")

real_config = lifecycle.get_config
lifecycle.get_config = lambda: dataclasses.replace(
    real_config(), lifecycle_base_url="http://127.0.0.1:9/api"
)
lifecycle._held.clear()
try:
    lifecycle.products()
    ok("an unreachable service raises", False, "no exception")
except Exception as exc:  # noqa: BLE001
    ok("an unreachable service raises, so the run can say so", True, type(exc).__name__)
lifecycle.get_config = real_config
lifecycle._held.clear()

print("\n4. The extraction cache, in the real table")
ORG = "zz-lifecycle-test-org"
HEADS = [{"ordinal": 1, "title": "Data", "headingPath": "Portal › Data",
          "pageStart": 3, "pageEnd": 3}]
ROWS = [{"page": 3, "kind": "text", "sectionOrdinal": 1,
         "text": "Orders are stored in a single PostgreSQL 11 instance."}]
state = {"sections": coverage.group(HEADS, ROWS), "whole": whole_document.build("Portal", ROWS, [])}
calls = {"n": 0}


def fake_find(*, design, products, title):
    calls["n"] += 1
    return {"technologies": [{"name": "PostgreSQL", "product": "postgresql", "version": "11",
                              "section": 1, "page": 3,
                              "quote": "Orders are stored in a single PostgreSQL 11 instance."}]}


real = {"load": coverage._load, "find": llm.find_technologies, "available": llm.available}
coverage._load = lambda conn, document_id: (state["sections"], state["whole"])
llm.find_technologies = fake_find
llm.available = lambda: True
RUN = {"id": "zz-run", "documentId": "zz-doc", "organisationId": ORG}

with db.connection() as conn:
    db.execute(
        conn,
        'INSERT INTO "organisation" ("id","name","slug","createdAt","updatedAt") '
        "VALUES (%s,%s,%s,now(),now()) ON CONFLICT DO NOTHING",
        (ORG, "ZZ Lifecycle Test", ORG),
    )
try:
    first = lifecycle.work_out(RUN, today=TODAY)
    ok("first run reads the design with the model", calls["n"] == 1
       and first["extraction"]["source"] == "model")
    ok("and finds PostgreSQL 11 ended", first["technologies"][0]["status"] == "ended")
    second = lifecycle.work_out(RUN, today=TODAY)
    ok("same design: the reading is reused, the model not asked", calls["n"] == 1
       and second["extraction"]["source"] == "cache", second["extraction"])
    ok("reused reading keeps its date",
       second["extraction"]["generatedAt"] == first["extraction"]["generatedAt"])
    ok("the statuses are still worked out", second["technologies"][0]["status"] == "ended")
    later = lifecycle.work_out(RUN, today=dt.date(2020, 1, 1))
    ok("statuses follow the day, not the cache: in 2020 PostgreSQL 11 was still supported",
       later["technologies"][0]["status"] in ("supported", "ending"),
       later["technologies"][0]["status"])
    rows = [{"page": 3, "kind": "text", "sectionOrdinal": 1,
             "text": "Orders are stored in a single PostgreSQL 17 instance."}]
    state["sections"] = coverage.group(HEADS, rows)
    state["whole"] = whole_document.build("Portal", rows, [])
    lifecycle.work_out(RUN, today=TODAY)
    ok("a changed design is read again", calls["n"] == 2)
    def readings() -> int:
        with db.connection() as conn:
            return db.one(
                conn,
                'SELECT count(*)::int AS n FROM "ai_cache" WHERE "organisationId" = %s AND "kind" = %s',
                (ORG, cache.LIFECYCLE),
            )["n"]

    held = readings()
    cache.sweep(cache.LIFECYCLE, max_age_days=90)
    ok("young readings survive the expiry sweep", held == 2 and readings() == 2, (held, readings()))
finally:
    coverage._load = real["load"]
    llm.find_technologies = real["find"]
    llm.available = real["available"]
    with db.connection() as conn:
        db.execute(conn, 'DELETE FROM "organisation" WHERE "id" = %s', (ORG,))
        left = db.one(conn, 'SELECT count(*)::int AS n FROM "ai_cache" WHERE "organisationId" = %s',
                      (ORG,))
    ok("cleanup: the throwaway organisation's rows are gone", left["n"] == 0, left)
    db.close()

print("\n5. What went out, across this whole test")
paths = [url.split("/api/", 1)[1] for url in requested if "/api/" in url]
bad = [p for p in paths if p != "v1/products" and not (
    p.endswith(".json") and lifecycle._SLUG.fullmatch(p.removesuffix(".json")))]
ok("only the product list and product ids", not bad, bad)
ok("no version or design word in any request",
   not any(word in url for url in requested for word in ("Orders", "Portal", "instance", "/11", "2.7")),
   requested)
print(f"  ({len(requested)} requests: {sorted(set(paths))})")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
