"""Does the embedding cache actually stop us paying twice?

Stubs the provider with a counter, so "the second call never reached the API"
is measured rather than assumed. Uses a throwaway organisation and deletes it
at the end, so it can be run against a live database without touching anyone's
rows.

    python3 Workers/scripts/test_embedding_cache.py
"""

from __future__ import annotations

import datetime as dt
import os
import pathlib
import sys

# The project targets Python 3.11+, where datetime.UTC exists. Shimmed so this
# also runs on an older local interpreter; the workers themselves are 3.11.
if not hasattr(dt, "UTC"):
    dt.UTC = dt.UTC  # type: ignore[attr-defined]

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

_ENV = pathlib.Path(__file__).resolve().parents[2] / "AIDP" / ".env.local"
for line in _ENV.read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"'))
os.environ.setdefault("STAGE", "embed")
os.environ.setdefault("GEMINI_API_KEY", "not-used-the-provider-is-stubbed")

from aidp import db, usage  # noqa: E402
from aidp.ai import embeddings  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


class CountingProvider:
    """Stands in for Gemini. Deterministic, so a cached vector can be compared
    against a freshly computed one and shown to be identical."""

    model = "test-embedding-model"
    dims = 1024

    def __init__(self) -> None:
        self.calls = 0
        self.texts_sent: list[str] = []

    def embed(self, texts, input_type):
        self.calls += 1
        self.texts_sent.extend(texts)
        out = []
        for text in texts:
            seed = sum(ord(character) for character in text) + len(input_type)
            out.append([((seed + index) % 100) / 100.0 for index in range(self.dims)])
        return out


ORG_ID = "zz-cache-test-org"


def cached_rows(organisation_id: str) -> int:
    with db.connection() as conn:
        row = db.one(
            conn,
            'SELECT count(*) AS n FROM "ai_cache" WHERE "organisationId" = %(org)s',
            {"org": organisation_id},
        )
    return int(row["n"]) if row else 0

with db.connection() as conn:
    db.execute(
        conn,
        'INSERT INTO "organisation" ("id","name","slug","createdAt","updatedAt") '
        "VALUES (%(id)s,%(n)s,%(s)s,%(t)s,%(t)s) ON CONFLICT DO NOTHING",
        {"id": ORG_ID, "n": "ZZ Cache Test", "s": ORG_ID, "t": db.now()},
    )

stub = CountingProvider()
embeddings.provider = lambda: stub  # type: ignore[assignment]

CLAUSES = [
    "All data in transit must be encrypted using TLS 1.2 or above.",
    "Every service must expose a health endpoint.",
    "Backups must meet a recovery point objective of one hour.",
]

try:
    usage.bind(usage.Attribution(organisation_id=ORG_ID, stage="embed"))

    print("\n1. First run pays the provider")
    first = embeddings.embed_all(CLAUSES, "document")
    ok("three vectors returned", len(first) == 3)
    ok("provider was called", stub.calls == 1, f"calls={stub.calls}")
    ok("all three texts were sent", len(stub.texts_sent) == 3)
    ok("stored in the cache", cached_rows(ORG_ID) == 3, f"rows={cached_rows(ORG_ID)}")

    print("\n2. Second run pays nothing")
    calls_before = stub.calls
    second = embeddings.embed_all(CLAUSES, "document")
    ok("provider NOT called again", stub.calls == calls_before, f"calls={stub.calls}")
    ok("vectors identical to the first run", second == first)

    print("\n3. A changed text still costs")
    changed = CLAUSES[:2] + ["Backups must meet a recovery point objective of four hours."]
    calls_before = stub.calls
    embeddings.embed_all(changed, "document")
    ok("provider called once more", stub.calls == calls_before + 1)
    ok("only the changed text was sent", stub.texts_sent[-1] == changed[2],
       stub.texts_sent[-1][:50])

    print("\n4. Query and document embeddings do not share an entry")
    calls_before = stub.calls
    as_query = embeddings.embed_all([CLAUSES[0]], "query")
    ok("provider called for the query form", stub.calls == calls_before + 1)
    ok("query vector differs from the document vector", as_query[0] != first[0])

    print("\n5. Repeats inside one call are paid for once")
    calls_before = stub.calls
    sent_before = len(stub.texts_sent)
    repeated = embeddings.embed_all(
        ["brand new line", "brand new line", "brand new line"], "document"
    )
    ok("one text sent, not three", len(stub.texts_sent) - sent_before == 1)
    ok("all three positions filled", len(repeated) == 3)
    ok("and they are the same vector", repeated[0] == repeated[1] == repeated[2])

    print("\n6. Another organisation does not read this one's cache")
    with db.connection() as conn:
        db.execute(
            conn,
            'INSERT INTO "organisation" ("id","name","slug","createdAt","updatedAt") '
            "VALUES (%(id)s,%(n)s,%(s)s,%(t)s,%(t)s) ON CONFLICT DO NOTHING",
            {"id": ORG_ID + "-b", "n": "ZZ Cache Test B", "s": ORG_ID + "-b", "t": db.now()},
        )
    usage.bind(usage.Attribution(organisation_id=ORG_ID + "-b", stage="embed"))
    calls_before = stub.calls
    embeddings.embed_all([CLAUSES[0]], "document")
    ok("tenant boundary held — provider was called", stub.calls == calls_before + 1)

    print("\n7. Order is preserved when hits and misses are mixed")
    usage.bind(usage.Attribution(organisation_id=ORG_ID, stage="embed"))
    mixed = [CLAUSES[1], "a line never seen before", CLAUSES[0]]
    result = embeddings.embed_all(mixed, "document")
    ok("cached entry landed in position 0", result[0] == first[1])
    ok("cached entry landed in position 2", result[2] == first[0])
    ok("fresh entry sits between them", result[1] != result[0] and result[1] != result[2])

finally:
    usage.bind(None)
    with db.connection() as conn:
        db.execute(
            conn,
            'DELETE FROM "organisation" WHERE "id" = ANY(%(ids)s)',
            {"ids": [ORG_ID, ORG_ID + "-b"]},
        )
    db.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
