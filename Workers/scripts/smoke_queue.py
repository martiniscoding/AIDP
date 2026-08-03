"""Round-trip the queue against the real database.

The queue is hand-written SQL against a Prisma-generated schema, which is where
typos hide: camelCase identifiers need quoting, `id` and `updatedAt` carry no
database default because Prisma generates them client-side, and the idempotency
guard is a *partial* unique index that `ON CONFLICT DO NOTHING` has to hit.

None of that is exercised by the parsing smoke test. This creates a throwaway
organisation, drives a job through claim → heartbeat → complete → chain, and
deletes everything it made.

    docker run --rm -v "$PWD":/w -w /w \
      -e STAGE=parse -e DATABASE_URL="$DIRECT_DATABASE_URL" \
      --entrypoint python aidp-worker:dev scripts/smoke_queue.py
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aidp import db, queue  # noqa: E402

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    suffix = f"  — {detail}" if not condition and detail else ""
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}{suffix}")
    if not condition:
        failures.append(label)


def main() -> int:
    marker = uuid.uuid4().hex[:10]
    org_id = db.new_id()
    doc_id = db.new_id()
    correlation = str(uuid.uuid4())

    print(f"\nUsing throwaway organisation smoke-{marker}\n")

    try:
        with db.transaction() as conn:
            db.execute(
                conn,
                'INSERT INTO "organisation" ("id","name","slug","updatedAt")'
                " VALUES (%s,%s,%s,now())",
                (org_id, f"Smoke {marker}", f"smoke-{marker}"),
            )
            db.execute(
                conn,
                """
                INSERT INTO "document"
                    ("id","organisationId","role","title","storageKey","byteSize",
                     "sha256","status","updatedAt")
                VALUES (%s,%s,'reference',%s,%s,%s,%s,'pending',now())
                """,
                (doc_id, org_id, "Smoke document", f"documents/{org_id}/x.pdf", 1234, marker),
            )

        print("Enqueue")
        with db.transaction() as conn:
            job_id = queue.enqueue(
                conn, organisation_id=org_id, document_id=doc_id,
                stage="parse", correlation_id=correlation,
            )
        check("job created", job_id is not None)

        with db.transaction() as conn:
            duplicate = queue.enqueue(
                conn, organisation_id=org_id, document_id=doc_id,
                stage="parse", correlation_id=correlation,
            )
        check("partial unique index blocks a second live job", duplicate is None)

        print("\nClaim")
        job = queue.claim("parse", "smoke-worker", 600)
        check("job claimed", job is not None and job.id == job_id)
        check("no second claimer gets it", queue.claim("parse", "other-worker", 600) is None
              or queue.claim("parse", "other-worker", 600).document_id != doc_id)
        if job:
            check("correlation id carried", job.correlation_id == correlation)
            check("attempt counted", job.attempts == 1, f"got {job.attempts}")

        print("\nHeartbeat")
        check("lease extended by owner", queue.heartbeat(job_id, "smoke-worker", 900))
        check("lease not extendable by anyone else", not queue.heartbeat(job_id, "impostor", 900))

        print("\nComplete and chain")
        with db.transaction() as conn:
            queue.complete(conn, job)

        with db.connection() as conn:
            rows = db.query(
                conn,
                'SELECT "stage","state" FROM "job" WHERE "documentId" = %s ORDER BY "createdAt"',
                (doc_id,),
            )
        states = {r["stage"]: r["state"] for r in rows}
        check("parse marked done", states.get("parse") == "done", str(states))
        check("chunk queued automatically", states.get("chunk") == "queued", str(states))

        print("\nFailure path")
        chunk_job = queue.claim("chunk", "smoke-worker", 600)
        check("chunk job claimable", chunk_job is not None)
        if chunk_job:
            state = queue.fail(chunk_job, "deliberate smoke failure")
            check("released back to queued with backoff", state == "queued", f"got {state}")
            with db.connection() as conn:
                row = db.one(
                    conn,
                    'SELECT "runAfter" > now() AS backed_off, "lastError"'
                    ' FROM "job" WHERE "id" = %s',
                    (chunk_job.id,),
                )
            check("retry is delayed", bool(row and row["backed_off"]))
            check("error recorded", bool(row and "smoke failure" in (row["lastError"] or "")))

        return 1 if failures else 0

    finally:
        with db.transaction() as conn:
            # Documents and jobs cascade from the organisation.
            db.execute(conn, 'DELETE FROM "organisation" WHERE "id" = %s', (org_id,))
        print(f"\nCleaned up smoke-{marker}")
        db.close()


if __name__ == "__main__":
    code = main()
    summary = (
        "All checks passed." if not failures else f"{len(failures)} failed: {', '.join(failures)}"
    )
    print("\n" + summary)
    sys.exit(code)
