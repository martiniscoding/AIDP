"""The Postgres job queue.

Not PGMQ — Neon does not offer the extension, and a plain table wins anyway:
the document library screen joins jobs to documents constantly, and the
compliance story wants `correlationId`, `attempts` and a dead-letter state as
real columns rather than payload keys.

`SELECT … FOR UPDATE SKIP LOCKED` does the hard part. N workers on one stage
claim concurrently without blocking each other and without ever being handed the
same job twice.

Satisfies Data Standards §9.3 and the customer's Integration principle 12 as
written: retry count, backoff, timeout, dead-letter path, idempotent processing,
correlation id per transaction.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import psycopg

from . import db, logs

log = logs.get(__name__)

# The pipeline. `analyse` only runs for documents uploaded with role='assessed';
# a reference document is finished once it is embedded.
NEXT_STAGE: dict[str, str | None] = {
    "parse": "chunk",
    "chunk": "embed",
    "embed": None,
    "analyse": None,
}

# Never wait longer than an hour between retries, however many have failed.
MAX_BACKOFF_SECONDS = 3600


@dataclass(frozen=True)
class Job:
    id: str
    organisation_id: str
    document_id: str
    stage: str
    attempts: int
    correlation_id: str
    payload: dict[str, Any]

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Job:
        payload = row.get("payload") or {}
        if isinstance(payload, str):
            payload = json.loads(payload)
        return cls(
            id=row["id"],
            organisation_id=row["organisationId"],
            document_id=row["documentId"],
            stage=row["stage"],
            attempts=row["attempts"],
            correlation_id=row["correlationId"],
            payload=payload,
        )


_CLAIM = """
UPDATE "job"
   SET "state"      = 'leased',
       "leaseUntil" = now() + make_interval(secs => %(lease)s),
       "leaseOwner" = %(owner)s,
       "attempts"   = "attempts" + 1,
       "updatedAt"  = now()
 WHERE "id" = (
       SELECT "id"
         FROM "job"
        WHERE "stage" = %(stage)s
          AND "state" = 'queued'
          AND "runAfter" <= now()
        ORDER BY "createdAt"
          FOR UPDATE SKIP LOCKED
        LIMIT 1
 )
RETURNING *
"""


def claim(stage: str, owner: str, lease_seconds: int) -> Job | None:
    """Take the oldest runnable job for a stage, or return None if idle."""
    with db.connection() as conn:
        row = db.one(conn, _CLAIM, {"stage": stage, "owner": owner, "lease": lease_seconds})
    return Job.from_row(row) if row else None


def heartbeat(job_id: str, owner: str, lease_seconds: int) -> bool:
    """Extend a lease mid-handler.

    Parsing a long PDF with vision calls can outrun the lease. Ownership is part
    of the predicate, so a worker that was already reaped cannot silently
    reclaim work another worker has picked up.
    """
    with db.connection() as conn:
        changed = db.execute(
            conn,
            """
            UPDATE "job"
               SET "leaseUntil" = now() + make_interval(secs => %(lease)s),
                   "updatedAt"  = now()
             WHERE "id" = %(id)s AND "leaseOwner" = %(owner)s AND "state" = 'leased'
            """,
            {"id": job_id, "owner": owner, "lease": lease_seconds},
        )
    return changed == 1


def enqueue(
    conn: psycopg.Connection,
    *,
    organisation_id: str,
    document_id: str,
    stage: str,
    correlation_id: str,
    payload: dict[str, Any] | None = None,
) -> str | None:
    """Add a job, inside the caller's transaction.

    Returns None when the partial unique index rejected it — that is the
    idempotency guard doing its job, not an error: a live job for this document
    and stage already exists.
    """
    job_id = db.new_id()
    row = db.one(
        conn,
        """
        INSERT INTO "job" ("id", "organisationId", "documentId", "stage", "state",
                           "correlationId", "payload", "runAfter", "updatedAt")
        VALUES (%(id)s, %(org)s, %(doc)s, %(stage)s, 'queued',
                %(cid)s, %(payload)s, now(), now())
        ON CONFLICT DO NOTHING
        RETURNING "id"
        """,
        {
            "id": job_id,
            "org": organisation_id,
            "doc": document_id,
            "stage": stage,
            "cid": correlation_id,
            "payload": json.dumps(payload or {}),
        },
    )
    if row is None:
        logs.info(log, "enqueue skipped, live job exists", stage=stage, documentId=document_id)
        return None
    return job_id


def complete(conn: psycopg.Connection, job: Job, *, chain: bool = True) -> None:
    """Mark done and hand off to the next stage, inside the caller's transaction.

    Completion and handoff share the transaction that wrote the stage's output,
    so a crash anywhere rolls back to a clean retry rather than leaving work
    persisted with the handoff lost.
    """
    db.execute(
        conn,
        """
        UPDATE "job"
           SET "state" = 'done', "leaseUntil" = NULL, "leaseOwner" = NULL,
               "updatedAt" = now()
         WHERE "id" = %s
        """,
        (job.id,),
    )
    if not chain:
        return
    nxt = NEXT_STAGE.get(job.stage)
    if nxt:
        enqueue(
            conn,
            organisation_id=job.organisation_id,
            document_id=job.document_id,
            stage=nxt,
            correlation_id=job.correlation_id,
        )


_BACKOFF = """
"runAfter" = now() + make_interval(
    secs => LEAST(%(cap)s, power(2, "attempts")::int)
)
"""


def fail(job: Job, error: str) -> str:
    """Release a job after a handler raised. Returns its new state."""
    with db.connection() as conn:
        row = db.one(
            conn,
            f"""
            UPDATE "job"
               SET "state" = CASE WHEN "attempts" >= "maxAttempts"
                                  THEN 'dead' ELSE 'queued' END,
                   {_BACKOFF},
                   "leaseUntil" = NULL,
                   "leaseOwner" = NULL,
                   "lastError"  = %(err)s,
                   "updatedAt"  = now()
             WHERE "id" = %(id)s
            RETURNING "state", "attempts"
            """,
            {"id": job.id, "err": error[:4000], "cap": MAX_BACKOFF_SECONDS},
        )
    state = row["state"] if row else "unknown"
    if state == "dead":
        logs.error(
            log,
            "job dead-lettered",
            jobId=job.id,
            stage=job.stage,
            documentId=job.document_id,
            attempts=job.attempts,
        )
    return state


def reap(cap: int = MAX_BACKOFF_SECONDS) -> int:
    """Requeue jobs whose lease expired. A crashed worker holds nothing."""
    with db.connection() as conn:
        rows = db.query(
            conn,
            f"""
            UPDATE "job"
               SET "state" = CASE WHEN "attempts" >= "maxAttempts"
                                  THEN 'dead' ELSE 'queued' END,
                   {_BACKOFF},
                   "leaseUntil" = NULL,
                   "leaseOwner" = NULL,
                   "lastError"  = 'lease expired before completion',
                   "updatedAt"  = now()
             WHERE "state" = 'leased' AND "leaseUntil" < now()
            RETURNING "id"
            """,
            {"cap": cap},
        )
    if rows:
        logs.warn(log, "reclaimed expired leases", count=len(rows))
    return len(rows)
