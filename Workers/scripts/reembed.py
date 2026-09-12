"""Re-embed what the system already holds, after the embedding model changes.

Every vector belongs to the model that produced it, and search only ever reads
vectors of the configured model. So once EMBEDDING_MODEL changes, every document
already ingested is invisible to search until its chunks are embedded again, and
every standing decision is invisible to the precedent lookup until it is.

Assessment heals its own submission before it retrieves anything (see
`embed.embed_missing`), so a run never judges against an empty search. This is
for everything else: the search page, reference standards, and the decision
register.

Dry run by default — it reports and changes nothing.

    python scripts/reembed.py                 # what would happen
    python scripts/reembed.py --apply         # queue embed jobs; re-embed decisions now
    python scripts/reembed.py --apply --now   # embed documents in this process instead
    python scripts/reembed.py --drop-old      # afterwards: delete other models' vectors

Run with the workers' environment (the new EMBEDDING_* values) against the
database the app uses. `--apply` alone only queues the documents, so the embed
worker must be running to process them; `--now` does the work here, which is
what to use when no worker is running. `--drop-old` refuses while anything still
lacks a vector for the current model, because deleting the old ones then would
leave it with none.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import cache, db, queue  # noqa: E402
from aidp.ai import embeddings  # noqa: E402
from aidp.config import get_config  # noqa: E402
from aidp.stages import embed as embed_stage  # noqa: E402

_MISSING = """
SELECT d."id", d."organisationId", d."title", d."status",
       count(*) AS "chunks",
       count(*) FILTER (
           WHERE NOT EXISTS (
               SELECT 1 FROM "embedding" e
                WHERE e."chunkId" = c."id" AND e."model" = %(model)s
           )
       ) AS "missing"
  FROM "document" d
  JOIN "chunk" c ON c."documentId" = d."id"
 GROUP BY d."id"
HAVING count(*) FILTER (
           WHERE NOT EXISTS (
               SELECT 1 FROM "embedding" e
                WHERE e."chunkId" = c."id" AND e."model" = %(model)s
           )
       ) > 0
 ORDER BY d."createdAt"
"""

_STALE_DECISIONS = """
SELECT "id", "title", "statement", "rationale", "clauseTitle"
  FROM "decision"
 WHERE "embeddingModel" IS DISTINCT FROM %(model)s
 ORDER BY "createdAt"
"""


def _decision_text(row: dict) -> str:
    """Kept in step with `searchableText` in AIDP/src/lib/ingest/decisions.ts —
    a decision embedded from different text than the app would use is found by
    different queries."""
    parts = [row["clauseTitle"], row["title"], row["statement"], row["rationale"]]
    return "\n\n".join(part for part in parts if part and part.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="re-embed documents and decisions")
    parser.add_argument(
        "--now", action="store_true", help="with --apply: embed here instead of queueing jobs"
    )
    parser.add_argument(
        "--drop-old", action="store_true", help="delete vectors of every other model"
    )
    args = parser.parse_args()

    cfg = get_config()
    model = cfg.embedding_model
    print(f"Embedding model: {model} via {cfg.embedding_provider} at {cfg.embedding_dims} dims\n")

    with db.connection() as conn:
        documents = db.query(conn, _MISSING, {"model": model})
        stale = db.query(conn, _STALE_DECISIONS, {"model": model})
        old = db.query(
            conn,
            'SELECT "model", count(*) AS "n" FROM "embedding" '
            'WHERE "model" <> %(model)s GROUP BY "model" ORDER BY "model"',
            {"model": model},
        )

    print(f"Documents with chunks lacking a {model} vector: {len(documents)}")
    for row in documents:
        print(
            f"  - {row['title'][:70]!r} [{row['status']}] "
            f"{row['missing']}/{row['chunks']} chunks"
        )
    print(f"Decisions not embedded with {model}: {len(stale)}")
    others = ", ".join(f"{r['model']} ({r['n']})" for r in old)
    print("Vectors from other models:", others or "none")

    if args.apply and args.now:
        print("\nEmbedding documents now…")
        for row in documents:
            count = embed_stage.embed_missing(row["id"], lambda: None)
            print(f"  {row['title'][:70]!r}: {count} chunk(s)")
    elif args.apply:
        print("\nQueueing embed jobs…")
        queued = skipped = 0
        for row in documents:
            with db.transaction() as conn:
                job = queue.enqueue(
                    conn,
                    organisation_id=row["organisationId"],
                    document_id=row["id"],
                    stage="embed",
                    correlation_id=f"reembed-{uuid.uuid4().hex[:12]}",
                )
            if job:
                queued += 1
            else:
                # The idempotency guard: a live job already exists for this
                # document, and it will embed whatever is missing when it runs.
                skipped += 1
        print(f"  queued {queued}, already in progress {skipped}. The embed worker processes them.")

    if args.apply:
        print("Re-embedding decisions…")
        for start in range(0, len(stale), 50):
            batch = stale[start : start + 50]
            kept = [(row, text) for row in batch if (text := _decision_text(row))]
            if not kept:
                continue
            vectors = embeddings.embed_all([text for _, text in kept], "document")
            with db.transaction() as conn:
                for (row, _), vector in zip(kept, vectors, strict=True):
                    db.execute(
                        conn,
                        'UPDATE "decision" SET "vector" = %s::vector, "embeddingModel" = %s '
                        'WHERE "id" = %s',
                        (embeddings.to_pgvector(vector), model, row["id"]),
                    )
        print(f"  re-embedded {len(stale)} decision(s).")

    if args.drop_old:
        with db.connection() as conn:
            remaining = db.query(conn, _MISSING, {"model": model})
            stale_now = db.query(conn, _STALE_DECISIONS, {"model": model})
        if remaining or stale_now:
            print(
                f"\nRefusing to drop old vectors: {len(remaining)} document(s) and "
                f"{len(stale_now)} decision(s) still lack a {model} vector. Run --apply, "
                "let it finish, then run this again."
            )
            return 1
        with db.transaction() as conn:
            dropped = db.execute(
                conn, 'DELETE FROM "embedding" WHERE "model" <> %(model)s', {"model": model}
            )
            cached = db.execute(
                conn,
                'DELETE FROM "ai_cache" WHERE "kind" = %(kind)s AND "model" <> %(model)s',
                {"kind": cache.EMBEDDING, "model": model},
            )
        print(f"\nDeleted {dropped} old vector(s) and {cached} cached embedding(s).")

    if not (args.apply or args.drop_old):
        print("\nDry run — nothing changed. Re-run with --apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
