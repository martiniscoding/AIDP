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

import hashlib

from . import db, logs, usage

log = logs.get(__name__)

EMBEDDING = "embedding"


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

_INSERT = """
INSERT INTO "ai_cache" (
    "id", "organisationId", "kind", "fingerprint", "model",
    "vector", "costTokens", "hits", "lastUsedAt", "createdAt"
) VALUES (
    %(id)s, %(org)s, %(kind)s, %(fp)s, %(model)s,
    %(vec)s::vector, %(cost)s, 0, %(now)s, %(now)s
)
ON CONFLICT ("organisationId", "kind", "fingerprint") DO NOTHING
"""


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
            found = {row["fingerprint"]: _parse_vector(row["vector"]) for row in rows}
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
    try:
        with db.connection() as conn:
            for key, model, vector, cost in entries:
                db.execute(
                    conn,
                    _INSERT,
                    {
                        "id": db.new_id(),
                        "org": organisation_id,
                        "kind": EMBEDDING,
                        "fp": key,
                        "model": model,
                        "vec": "[" + ",".join(f"{v:.7g}" for v in vector) + "]",
                        "cost": cost,
                        "now": db.now(),
                    },
                )
    except Exception as exc:  # noqa: BLE001 — see the module docstring
        logs.warn(log, "cache write failed, continuing", error=str(exc)[:200])
