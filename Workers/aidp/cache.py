"""Answers we have already paid a provider for.

Every expensive call in this pipeline is a function of its inputs, so the same
inputs need only be paid for once. This module is the only place cache keys are
built, which is the point: "what does this answer depend on?" gets exactly one
answer, in one file, rather than being re-decided at each call site.

Why the key is the whole design
-------------------------------
A key that misses an input is not a slow cache. It is a cache that returns a
confidently wrong answer, and in a compliance tool that is worse than no cache.
So two rules:

  1. Everything that can change the output goes in the key — including the
     model name and, for embeddings, the task type and the output width.
  2. Under-normalise. The fingerprint covers the exact bytes handed to the
     provider, with no whitespace folding or tidying. Text that differs by one
     space misses and costs a fraction of a penny; a false hit costs
     correctness. That asymmetry only points one way.

Embeddings are cached first because they are the only call here that is risk
free: `embed(text)` is a pure function, so a stored answer is not a stale
answer, it is the identical answer. A verdict is not — it depends on the
submitted design as well as the standard — and reusing one has to be recorded
on the finding or the audit trail starts lying.

Scoped per organisation. A cache keyed on customer text is otherwise a channel
through which one customer could learn that another holds a document containing
an exact passage.

Nothing here is allowed to fail the work. A cache that cannot be read is a
slower pipeline; a cache that raises is a broken one.
"""

from __future__ import annotations

import datetime as dt
import hashlib
from dataclasses import dataclass

from psycopg.types.json import Jsonb

from . import db, logs, usage

log = logs.get(__name__)

EMBEDDING = "embedding"
ADVICE = "advice"
LIFECYCLE = "lifecycle"


def fingerprint(*parts: str) -> str:
    """A stable hash over several fields.

    The separator matters. Without it ("ab", "c") and ("a", "bc") hash the same,
    and a model name ending where a task type begins would collide — rare, and
    impossible to diagnose from a wrong vector.
    """
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part.encode("utf-8"))
        digest.update(b"\x00")
    return digest.hexdigest()


def embedding_key(text: str, model: str, input_type: str, dims: int) -> str:
    """The identity of one embedding.

    `input_type` is in here because it is not decoration: Gemini embeds the same
    string differently as a document and as a query, and serving one for the
    other would quietly degrade retrieval rather than fail. `dims` likewise —
    the vectors are Matryoshka-truncated, so 1024 and 768 of the same model are
    different answers, and the column only accepts one width.
    """
    return fingerprint(text, model, input_type, str(dims))


def _parse_vector(raw: str) -> list[float]:
    """pgvector's text output back into floats.

    Comes out as "[0.1,-0.2,...]". Parsed by hand rather than through a codec
    because it is one line and avoids a registration step at every entry point.
    """
    return [float(value) for value in raw.strip()[1:-1].split(",")]


_SELECT = """
SELECT "fingerprint", "vector"::text AS vector
  FROM "ai_cache"
 WHERE "organisationId" = %(org)s
   AND "kind" = %(kind)s
   AND "vector" IS NOT NULL
   AND "fingerprint" = ANY(%(keys)s)
"""

_TOUCH = """
UPDATE "ai_cache"
   SET "hits" = "hits" + 1, "lastUsedAt" = %(now)s
 WHERE "organisationId" = %(org)s
   AND "kind" = %(kind)s
   AND "fingerprint" = ANY(%(keys)s)
"""

_INSERT_HEAD = """
INSERT INTO "ai_cache" (
    "id", "organisationId", "kind", "fingerprint", "model",
    "vector", "costTokens", "hits", "lastUsedAt", "createdAt"
) VALUES
"""

# One row of the statement above. Written as a batch rather than a statement
# per vector: an embed batch is up to ninety-six of these, and against Neon
# each round trip costs more than the insert itself.
_INSERT_ROW = "(%s, %s, %s, %s, %s, %s::vector, %s, 0, %s, %s)"

_INSERT_TAIL = ' ON CONFLICT ("organisationId", "kind", "fingerprint") DO NOTHING'


def organisation() -> str | None:
    """Whose cache to read, taken from the job the worker is running.

    Reuses the attribution the usage recorder already binds, so the AI modules
    do not grow a second bookkeeping argument. Null outside a job — smoke tests
    and one-off scripts — and every function here then does nothing, which is
    correct: work that belongs to no customer belongs in no customer's cache.
    """
    attribution = usage.current()
    return attribution.organisation_id if attribution else None


def get_embeddings(organisation_id: str, keys: list[str]) -> dict[str, list[float]]:
    """Whichever of these we already hold, by key.

    One query for the whole batch rather than one per text: a run asks about a
    hundred-odd clauses at once, and the interesting number is how many of them
    we can skip, not which.
    """
    if not keys:
        return {}
    try:
        with db.connection() as conn:
            rows = db.query(
                conn,
                _SELECT,
                {"org": organisation_id, "kind": EMBEDDING, "keys": keys},
            )
            found: dict[str, list[float]] = {}
            for row in rows:
                try:
                    found[row["fingerprint"]] = _parse_vector(row["vector"])
                except ValueError:
                    # One unreadable row should cost one re-embed, not the
                    # whole batch's worth of hits.
                    logs.warn(log, "skipping unreadable cache row", key=row["fingerprint"][:12])
            if found:
                # Recency and reuse count, for reporting the saving and for
                # evicting what nobody wants. Best effort — a failed bump must
                # not discard vectors we have already read.
                db.execute(
                    conn,
                    _TOUCH,
                    {
                        "org": organisation_id,
                        "kind": EMBEDDING,
                        "keys": list(found),
                        "now": db.now(),
                    },
                )
            return found
    except Exception as exc:  # noqa: BLE001 — a cold cache is not a failure
        logs.warn(log, "cache read failed, continuing without it", error=str(exc)[:200])
        return {}


def put_embeddings(
    organisation_id: str,
    entries: list[tuple[str, str, list[float], int]],
) -> None:
    """Store vectors we have just paid for.

    `entries` is (key, model, vector, cost_tokens). Conflicts are ignored rather
    than updated: two workers embedding the same passage at the same time is
    normal, and the row they would write is identical anyway.
    """
    if not entries:
        return

    # The caller already sends each key once, but a repeated key would collide
    # with its own statement rather than with a stored row, and ON CONFLICT is
    # not the guard for that. Deduplicate here so the batch is safe whoever
    # calls it.
    unique: dict[str, tuple[str, str, list[float], int]] = {}
    for entry in entries:
        unique.setdefault(entry[0], entry)

    now = db.now()
    params: list[object] = []
    for key, model, vector, cost in unique.values():
        params.extend(
            (
                db.new_id(),
                organisation_id,
                EMBEDDING,
                key,
                model,
                "[" + ",".join(f"{v:.7g}" for v in vector) + "]",
                cost,
                now,
                now,
            )
        )

    sql = _INSERT_HEAD + ",".join([_INSERT_ROW] * len(unique)) + _INSERT_TAIL
    try:
        with db.connection() as conn:
            db.execute(conn, sql, params)
    except Exception as exc:  # noqa: BLE001 — see the module docstring
        logs.warn(log, "cache write failed, continuing", error=str(exc)[:200])


# ------------------------------------------------------------------ #
# Answers stored as JSON — suggested improvements
# ------------------------------------------------------------------ #


def advice_key(
    *,
    design: str,
    title: str,
    standards: str,
    provider: str,
    model: str,
    prompt: str,
    version: int,
) -> str:
    """The identity of one set of suggested improvements.

    Everything the model is shown except the findings: the design's text, its
    title, the clause set it was assessed against, which model, and the exact
    instructions. A change to any of them is a different question and misses.

    The findings are left out on purpose, and it is the one place this module
    departs from "everything that can change the output". Verdicts drift between
    runs of an unchanged design, so a key that held them would miss on the very
    repeat it exists for. What the findings decide in a reply — which clause a
    suggestion says it would help with — is re-checked against the current run
    every time the reply is reused; see advice.py.
    """
    return fingerprint(ADVICE, str(version), provider, model, prompt, title, standards, design)


def lifecycle_key(
    *,
    design: str,
    title: str,
    products: str,
    provider: str,
    model: str,
    prompt: str,
    version: int,
) -> str:
    """The identity of one reading of which technologies a design uses.

    Everything the model is shown: the design, its title, the product list it
    chooses ids from, the model and the instructions. No findings are involved,
    so unlike `advice_key` nothing is left out. Only the reading is keyed; the
    support dates are looked up fresh every run. See lifecycle.py.
    """
    return fingerprint(LIFECYCLE, str(version), provider, model, prompt, title, products, design)


@dataclass
class Stored:
    """One answer read back: what it said, which model said it, and when."""

    payload: dict
    model: str
    created_at: dt.datetime
    hits: int


_SELECT_PAYLOAD = """
SELECT "payload", "model", "createdAt", "hits"
  FROM "ai_cache"
 WHERE "organisationId" = %(org)s
   AND "kind" = %(kind)s
   AND "fingerprint" = %(key)s
   AND "payload" IS NOT NULL
   AND "createdAt" > %(since)s
"""

_TOUCH_ONE = """
UPDATE "ai_cache"
   SET "hits" = "hits" + 1, "lastUsedAt" = %(now)s
 WHERE "organisationId" = %(org)s
   AND "kind" = %(kind)s
   AND "fingerprint" = %(key)s
"""

# Replaces rather than ignores, unlike the embeddings insert. A payload is only
# written after a miss, and a miss on a key that has a row means the row is too
# old to use — or a reviewer asked for a fresh answer on purpose. Either way the
# new answer is the one to keep, and its age starts again.
_UPSERT_PAYLOAD = """
INSERT INTO "ai_cache" (
    "id", "organisationId", "kind", "fingerprint", "model",
    "payload", "costTokens", "hits", "lastUsedAt", "createdAt"
) VALUES (
    %(id)s, %(org)s, %(kind)s, %(key)s, %(model)s,
    %(payload)s, %(cost)s, 0, %(now)s, %(now)s
)
ON CONFLICT ("organisationId", "kind", "fingerprint") DO UPDATE SET
    "model" = EXCLUDED."model",
    "payload" = EXCLUDED."payload",
    "costTokens" = EXCLUDED."costTokens",
    "hits" = 0,
    "lastUsedAt" = EXCLUDED."lastUsedAt",
    "createdAt" = EXCLUDED."createdAt"
"""


def get_payload(
    organisation_id: str | None,
    kind: str,
    key: str,
    *,
    max_age_days: int,
) -> Stored | None:
    """The stored answer for this key, if there is one younger than the limit.

    None for no organisation or a limit of zero, which is how reuse is turned
    off, and None rather than an exception for anything that goes wrong.
    """
    if not organisation_id or max_age_days <= 0:
        return None
    try:
        with db.connection() as conn:
            now = db.now()
            row = db.one(
                conn,
                _SELECT_PAYLOAD,
                {
                    "org": organisation_id,
                    "kind": kind,
                    "key": key,
                    "since": now - dt.timedelta(days=max_age_days),
                },
            )
            if row is None or not isinstance(row["payload"], dict):
                return None
            try:
                db.execute(
                    conn,
                    _TOUCH_ONE,
                    {"org": organisation_id, "kind": kind, "key": key, "now": now},
                )
            except Exception as exc:  # noqa: BLE001 — the answer is already read
                logs.warn(log, "cache hit not counted", kind=kind, error=str(exc)[:200])
            created = row["createdAt"]
            # The column has no zone; every writer stores UTC.
            if created.tzinfo is None:
                created = created.replace(tzinfo=dt.UTC)
            return Stored(
                payload=row["payload"],
                model=row["model"],
                created_at=created,
                hits=int(row["hits"]) + 1,
            )
    except Exception as exc:  # noqa: BLE001 — a cold cache is not a failure
        logs.warn(log, "cache read failed, continuing without it", kind=kind, error=str(exc)[:200])
        return None


_SWEEP = """
DELETE FROM "ai_cache"
 WHERE "kind" = %(kind)s
   AND "createdAt" <= %(cutoff)s
"""


def sweep(kind: str, *, max_age_days: int) -> int:
    """Delete stored answers of this kind that are too old to be reused.

    `get_payload` already refuses them, but a refused row still holds what the
    customer's design said — quotes and all — for as long as nobody asks about
    that design again, which may be never. Expiry has to mean deletion, not just
    being ignored. The cutoff is the exact complement of the read: a row is either
    young enough to be served or old enough to be deleted, never both, never
    neither.

    Every organisation at once. Returns how many were deleted; 0 for a limit of
    0 — reuse switched off writes nothing new, and deleting everything on a
    setting meant to pause reuse would surprise — and 0 rather than an exception
    when the delete fails, since the next sweep will simply try again.
    """
    if max_age_days <= 0:
        return 0
    try:
        with db.connection() as conn:
            return db.execute(
                conn,
                _SWEEP,
                {"kind": kind, "cutoff": db.now() - dt.timedelta(days=max_age_days)},
            )
    except Exception as exc:  # noqa: BLE001 — see the module docstring
        logs.warn(log, "cache sweep failed, will retry", kind=kind, error=str(exc)[:200])
        return 0


def put_payload(
    organisation_id: str | None,
    kind: str,
    key: str,
    *,
    model: str,
    payload: dict,
    cost_tokens: int,
    created_at: dt.datetime | None = None,
) -> None:
    """Store an answer we have just paid for, replacing any older one.

    `created_at` lets the caller store the same instant it reports, so an
    answer read back later carries exactly the time it was first given.
    """
    if not organisation_id:
        return
    now = created_at or db.now()
    try:
        with db.connection() as conn:
            db.execute(
                conn,
                _UPSERT_PAYLOAD,
                {
                    "id": db.new_id(),
                    "org": organisation_id,
                    "kind": kind,
                    "key": key,
                    "model": model,
                    "payload": Jsonb(payload),
                    "cost": max(0, int(cost_tokens)),
                    "now": now,
                },
            )
    except Exception as exc:  # noqa: BLE001 — see the module docstring
        logs.warn(log, "cache write failed, continuing", kind=kind, error=str(exc)[:200])
