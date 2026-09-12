"""Embed stage — vectors into pgvector.

Only chunks that lack a vector for the *current* model are sent, so a retry
after a partial failure costs only what is missing, and switching models rolls
out alongside the old one instead of as a big-bang re-embed.

For a reference document this is the last stage: `queue.NEXT_STAGE["embed"]` is
None, so nothing is chained and the document lands as `ready`. Documents
uploaded with role='assessed' are what continue into analyse.
"""

from __future__ import annotations

from collections.abc import Callable

from .. import db, logs, queue
from ..ai import embeddings
from ..config import get_config
from ..queue import Job

log = logs.get(__name__)

# Rows written per statement batch. Independent of the provider's request batch.
_WRITE_BATCH = 200


def handle(job: Job, heartbeat) -> None:
    embed_missing(
        job.document_id,
        heartbeat,
        on_start=lambda: _set_status(job.document_id, "embedding"),
    )
    _finish(job)


def embed_missing(
    document_id: str,
    heartbeat: Callable[[], None],
    *,
    on_start: Callable[[], None] | None = None,
) -> int:
    """Embed a document's chunks that have no vector for the current model.

    Returns how many were embedded. Shared by the embed stage and by analyse,
    which calls it before retrieving anything: a document embedded under an
    earlier model has no vectors retrieval can see, so every search would come
    back empty and every clause would read as absent — confidently, and with
    nothing to say why. Filling the gap first makes changing the embedding
    model safe for any document that is assessed again.
    """
    cfg = get_config()
    model = cfg.embedding_model

    with db.connection() as conn:
        pending = db.query(
            conn,
            """
            SELECT c."id", c."text"
              FROM "chunk" c
             WHERE c."documentId" = %(doc)s
               AND NOT EXISTS (
                   SELECT 1 FROM "embedding" e
                    WHERE e."chunkId" = c."id" AND e."model" = %(model)s
               )
             ORDER BY c."ordinal"
            """,
            {"doc": document_id, "model": model},
        )

    if not pending:
        logs.info(log, "nothing to embed, already current", model=model)
        return 0

    if on_start is not None:
        on_start()
    logs.info(log, "embedding", chunks=len(pending), model=model, dims=cfg.embedding_dims)

    vectors: list[tuple[str, str]] = []
    for start in range(0, len(pending), embeddings.BATCH_SIZE):
        window = pending[start : start + embeddings.BATCH_SIZE]
        result = embeddings.embed_all([row["text"] for row in window], "document")
        vectors.extend(
            (row["id"], embeddings.to_pgvector(vector))
            for row, vector in zip(window, result, strict=True)
        )
        heartbeat()

    with db.transaction() as conn:
        for start in range(0, len(vectors), _WRITE_BATCH):
            for chunk_id, literal in vectors[start : start + _WRITE_BATCH]:
                db.execute(
                    conn,
                    """
                    INSERT INTO "embedding" ("id","chunkId","model","dims","vector")
                    VALUES (%s, %s, %s, %s, %s::vector)
                    ON CONFLICT ("chunkId","model")
                    DO UPDATE SET "vector" = EXCLUDED."vector", "dims" = EXCLUDED."dims"
                    """,
                    (db.new_id(), chunk_id, model, cfg.embedding_dims, literal),
                )

    logs.info(log, "embedded", chunks=len(vectors), model=model)
    return len(vectors)


def _finish(job: Job) -> None:
    # The vectors are already written in their own transaction. A crash between
    # the two retries the job, finds nothing missing, and lands here again.
    with db.transaction() as conn:
        db.execute(
            conn,
            """
            UPDATE "document"
               SET "status" = 'ready', "failureReason" = NULL, "updatedAt" = now()
             WHERE "id" = %s
            """,
            (job.document_id,),
        )
        queue.complete(conn, job)


def _set_status(document_id: str, status: str) -> None:
    with db.connection() as conn:
        db.execute(
            conn,
            'UPDATE "document" SET "status" = %s, "updatedAt" = now() WHERE "id" = %s',
            (status, document_id),
        )
