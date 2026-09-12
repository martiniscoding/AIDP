"""Progress reports on a real job row, and a real stage writing them.

The report is hand-written SQL into a JSON column, from a module that must never
fail the job it reports on. So this checks both halves against a database: what
lands in the row, and that a refused write — no column yet, no connection — is
swallowed. Then it runs the real embed stage, with the provider stubbed, and
reads back what that stage reported.

Needs a throwaway database migrated with the app's migrations. The missing-column
check renames a column, so it only runs against localhost.

    docker run --rm --network container:aidp-status-pg -v "$PWD":/w -w /w \
      -e STAGE=embed -e DATABASE_URL="postgresql://postgres:…@localhost:5432/aidp" \
      --entrypoint python aidp-worker-test scripts/smoke_progress.py
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aidp import db, progress, queue  # noqa: E402
from aidp.ai import embeddings  # noqa: E402
from aidp.config import get_config  # noqa: E402
from aidp.stages import embed as embed_stage  # noqa: E402

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    suffix = f"  — {detail}" if not condition and detail else ""
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}{suffix}")
    if not condition:
        failures.append(label)


def stored(job_id: str) -> dict:
    with db.connection() as conn:
        row = db.one(conn, 'SELECT "progress" FROM "job" WHERE "id" = %s', (job_id,))
    value = row["progress"] if row else None
    if isinstance(value, str):
        value = json.loads(value)
    return value or {}


def main() -> int:
    marker = uuid.uuid4().hex[:10]
    org_id = db.new_id()
    doc_id = db.new_id()
    local = any(host in os.environ.get("DATABASE_URL", "") for host in ("localhost", "127.0.0.1"))

    print(f"\nUsing throwaway organisation smoke-{marker}\n")
    with db.transaction() as conn:
        db.execute(
            conn,
            'INSERT INTO "organisation" ("id","name","slug","updatedAt") VALUES (%s,%s,%s,now())',
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

    try:
        print("Binding")
        with db.transaction() as conn:
            queue.enqueue(
                conn, organisation_id=org_id, document_id=doc_id,
                stage="parse", correlation_id=str(uuid.uuid4()),
            )
        job = queue.claim("parse", "smoke-worker", 600)
        check("job claimed", job is not None and job.document_id == doc_id)
        if job is None:
            return 1

        progress.bind(job.id, "smoke-worker", job.attempts)
        report = stored(job.id)
        check(
            "binding records the attempt and when it started",
            report.get("attempt") == 1
            and bool(report.get("startedAt"))
            and report.get("step") is None,
            str(report),
        )

        print("\nSteps")
        progress.step("Fetching the file")
        progress.step("Describing figures", done=0, total=3)
        report = stored(job.id)
        check(
            "a new step is written at once",
            report.get("step") == "Describing figures" and report.get("done") == 0
            and report.get("total") == 3,
            str(report),
        )
        check(
            "the step before it joins the trail, timed",
            [entry["step"] for entry in report.get("trail", [])] == ["Fetching the file"]
            and isinstance(report["trail"][0]["seconds"], (int, float)),
            str(report.get("trail")),
        )

        progress.step("Describing figures", done=1, total=3)
        check("a count a moment later is held back", stored(job.id).get("done") == 0)
        progress.step("Describing figures", done=3, total=3)
        check("reaching the total is written regardless", stored(job.id).get("done") == 3)

        progress.step("Counting", done=1, total=10)
        progress.step("Counting", done=2, total=10)
        check("still held back inside the interval", stored(job.id).get("done") == 1)
        tracker = progress._context.get()
        assert tracker is not None
        tracker.last_write -= progress.MIN_INTERVAL_SECONDS
        progress.step("Counting", done=3, total=10)
        check("written again once the interval has passed", stored(job.id).get("done") == 3)

        print("\nOwnership")
        progress.bind(job.id, "impostor", job.attempts)
        progress.step("Should never appear")
        check(
            "a worker that does not hold the job cannot write to it",
            stored(job.id).get("step") == "Counting",
            str(stored(job.id).get("step")),
        )

        print("\nFailure tolerance")
        progress.bind(job.id, "smoke-worker", job.attempts)
        original = db.connection

        def unavailable():
            raise RuntimeError("database unavailable")

        db.connection = unavailable
        try:
            progress.step("During an outage")
            raised = None
        except Exception as exc:  # noqa: BLE001
            raised = exc
        finally:
            db.connection = original
        check("a refused write does not raise", raised is None, repr(raised))
        progress.step("After the outage")
        check(
            "reporting goes quiet after a failure rather than retrying on every step",
            stored(job.id).get("step") != "After the outage",
        )

        progress.bind(None)
        progress.step("Unbound")
        check("a step with nothing bound does nothing", stored(job.id).get("step") != "Unbound")

        if local:
            print("\nA worker deployed before the migration")
            with db.transaction() as conn:
                db.execute(conn, 'ALTER TABLE "job" RENAME COLUMN "progress" TO "progress_away"')
            label = "binding and stepping survive a database without the column"
            try:
                progress.bind(job.id, "smoke-worker", job.attempts)
                progress.step("Without the column")
                check(label, True)
            except Exception as exc:  # noqa: BLE001
                check(label, False, repr(exc))
            finally:
                with db.transaction() as conn:
                    db.execute(
                        conn, 'ALTER TABLE "job" RENAME COLUMN "progress_away" TO "progress"'
                    )
                progress.bind(None)

        with db.transaction() as conn:
            queue.complete(conn, job, chain=False)

        print("\nThe embed stage")
        _embed_stage(org_id, doc_id)
        return 1 if failures else 0

    finally:
        progress.bind(None)
        with db.transaction() as conn:
            db.execute(conn, 'DELETE FROM "organisation" WHERE "id" = %s', (org_id,))
        print(f"\nCleaned up smoke-{marker}")
        db.close()


def _embed_stage(org_id: str, doc_id: str) -> None:
    cfg = get_config()
    with db.transaction() as conn:
        for ordinal in range(1, 6):
            db.execute(
                conn,
                """
                INSERT INTO "chunk"
                    ("id","organisationId","documentId","sourceKind","sourceId","ordinal",
                     "headingPath","text","tokenCount","pageStart","pageEnd","contentHash")
                VALUES (%s,%s,%s,'section',%s,%s,'Smoke',%s,3,1,1,%s)
                """,
                (db.new_id(), org_id, doc_id, db.new_id(), ordinal, f"passage {ordinal}",
                 uuid.uuid4().hex),
            )
        queue.enqueue(
            conn, organisation_id=org_id, document_id=doc_id,
            stage="embed", correlation_id=str(uuid.uuid4()),
        )

    job = queue.claim("embed", "smoke-worker", 600)
    check("embed job claimed", job is not None and job.document_id == doc_id)
    if job is None:
        return

    calls: list[tuple[str, int | None, int | None]] = []
    real_step, real_embed, real_batch = progress.step, embeddings.embed_all, embeddings.BATCH_SIZE

    def spy(label: str, *, done: int | None = None, total: int | None = None) -> None:
        calls.append((label, done, total))
        real_step(label, done=done, total=total)

    progress.step = spy
    embeddings.embed_all = lambda texts, kind: [[0.001] * cfg.embedding_dims for _ in texts]
    embeddings.BATCH_SIZE = 2
    try:
        progress.bind(job.id, "smoke-worker", job.attempts)
        embed_stage.handle(job, lambda: None)
    finally:
        progress.step, embeddings.embed_all, embeddings.BATCH_SIZE = (
            real_step, real_embed, real_batch,
        )
        progress.bind(None)

    counts = [(done, total) for label, done, total in calls if label == "Embedding passages"]
    check(
        "counts every batch up to the total",
        counts == [(0, 5), (2, 5), (4, 5), (5, 5)],
        str(counts),
    )
    check("says when it is saving", calls[-1][0] == "Saving the index", str(calls[-1:]))

    with db.connection() as conn:
        row = db.one(
            conn,
            'SELECT j."state", j."progress", d."status" FROM "job" j '
            'JOIN "document" d ON d."id" = j."documentId" WHERE j."id" = %s',
            (job.id,),
        )
        vectors = db.one(
            conn,
            'SELECT count(*) AS n FROM "embedding" e JOIN "chunk" c ON c."id" = e."chunkId" '
            'WHERE c."documentId" = %s',
            (doc_id,),
        )
    report = row["progress"] if row else {}
    if isinstance(report, str):
        report = json.loads(report)
    check("the job finished and the document is ready",
          bool(row) and row["state"] == "done" and row["status"] == "ready", str(row))
    check("every passage has a vector", bool(vectors) and vectors["n"] == 5, str(vectors))
    check(
        "the finished job keeps what it did",
        report.get("step") == "Saving the index"
        and [entry["step"] for entry in report.get("trail", [])] == ["Embedding passages"],
        str(report),
    )


if __name__ == "__main__":
    code = main()
    summary = (
        "All checks passed." if not failures else f"{len(failures)} failed: {', '.join(failures)}"
    )
    print("\n" + summary)
    sys.exit(code)
