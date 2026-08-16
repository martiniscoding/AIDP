"""Worker entrypoint. One image, `STAGE` picks the loop.

    STAGE=parse aidp-worker
    STAGE=chunk aidp-worker
    STAGE=embed aidp-worker
    STAGE=analyse aidp-worker

Four containers from one build, scaled independently: embed and analyse workers
are I/O-bound on provider calls and want concurrency, parse workers want memory.

The loop is deliberately dull. Claim, run, commit, repeat, with adaptive backoff
so an idle stage costs a handful of indexed lookups a minute. Every handler
receives a `heartbeat` callable and is expected to use it — a long parse with
vision calls will outrun the lease otherwise and get reaped mid-work.
"""

from __future__ import annotations

import signal
import sys
import threading
import time

from . import db, logs, queue, usage
from .config import get_config
from .stages import analyse as analyse_stage
from .stages import chunk as chunk_stage
from .stages import embed as embed_stage
from .stages import parse as parse_stage

log = logs.get("aidp.worker")

HANDLERS = {
    "parse": parse_stage.handle,
    "chunk": chunk_stage.handle,
    "embed": embed_stage.handle,
    "analyse": analyse_stage.handle,
}

_shutdown = threading.Event()


def _on_signal(signum, _frame) -> None:
    # Finish the job in hand, then stop. A hard kill is safe too — the lease
    # expires and the reaper requeues — but this avoids the wait.
    logs.info(log, "shutdown requested, finishing current job", signal=signum)
    _shutdown.set()


class _Backoff:
    def __init__(self, low: float, high: float) -> None:
        self.low = low
        self.high = high
        self.current = low

    def reset(self) -> None:
        self.current = self.low

    def wait(self) -> None:
        _shutdown.wait(self.current)
        self.current = min(self.current * 1.6, self.high)


def _reaper(interval: float = 60.0) -> None:
    """Requeues work abandoned by workers that died holding a lease."""
    while not _shutdown.wait(interval):
        try:
            queue.reap()
        except Exception as exc:  # noqa: BLE001 — a failed sweep must not kill the worker
            logs.error(log, "reaper sweep failed", error=str(exc)[:300])


def main() -> int:
    cfg = get_config()
    logs.setup()

    handler = HANDLERS.get(cfg.stage)
    if handler is None:
        logs.error(log, "no handler for stage", stage=cfg.stage)
        return 2

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    threading.Thread(target=_reaper, daemon=True).start()
    backoff = _Backoff(cfg.poll_min_seconds, cfg.poll_max_seconds)

    logs.info(
        log,
        "worker started",
        stage=cfg.stage,
        workerId=cfg.worker_id,
        leaseSeconds=cfg.lease_seconds,
    )

    while not _shutdown.is_set():
        try:
            job = queue.claim(cfg.stage, cfg.worker_id, cfg.lease_seconds)
        except Exception as exc:  # noqa: BLE001 — Neon naps; back off and retry
            logs.error(log, "claim failed", error=str(exc)[:300])
            backoff.wait()
            continue

        if job is None:
            backoff.wait()
            continue

        backoff.reset()
        logs.bind(correlation_id=job.correlation_id, document_id=job.document_id)

        # Bound once per job so the provider clients can account for what they
        # spend without every AI function taking a bookkeeping argument. See
        # the module docstring in usage.py. Resolving the uploader costs one
        # indexed lookup per job, not one per model call.
        usage.bind(
            usage.for_job(
                job.organisation_id,
                job.stage,
                job.document_id,
                job.payload.get("runId"),
            )
        )
        started = time.monotonic()

        def heartbeat(job_id: str = job.id) -> None:
            queue.heartbeat(job_id, cfg.worker_id, cfg.lease_seconds)

        try:
            logs.info(log, "job started", jobId=job.id, stage=job.stage, attempt=job.attempts)
            handler(job, heartbeat)
            logs.info(log, "job done", jobId=job.id, seconds=round(time.monotonic() - started, 2))
        except Exception as exc:  # noqa: BLE001 — one bad document must not stop the stage
            logs.error(log, "job failed", exc=True, jobId=job.id, error=str(exc)[:500])
            reason = f"{type(exc).__name__}: {exc}"
            state = queue.fail(job, reason)
            if state == "dead":
                # Surface the dead letter where someone will see it. Without
                # this the queue knows the work is stuck and the UI shows a
                # spinner forever.
                if job.stage == "analyse":
                    run_id = job.payload.get("runId")
                    if run_id:
                        analyse_stage.mark_failed(run_id, reason)
                else:
                    _mark_document_failed(job.document_id, reason)
        finally:
            logs.bind(correlation_id=None, document_id=None)
            usage.bind(None)

    db.close()
    logs.info(log, "worker stopped", stage=cfg.stage)
    return 0


def _mark_document_failed(document_id: str, reason: str) -> None:
    """Surface a dead-lettered job on the document itself.

    Without this the queue knows the document is stuck and the UI does not,
    which is exactly the silent failure the ingest_issue table exists to avoid.
    """
    try:
        with db.connection() as conn:
            db.execute(
                conn,
                """
                UPDATE "document"
                   SET "status" = 'failed', "failureReason" = %s, "updatedAt" = now()
                 WHERE "id" = %s
                """,
                (reason[:1000], document_id),
            )
    except Exception as exc:  # noqa: BLE001
        logs.error(log, "could not mark document failed", error=str(exc)[:300])


if __name__ == "__main__":
    sys.exit(main())
