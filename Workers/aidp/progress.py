"""What a job is doing right now, for the person waiting on it.

A document's status says which stage it is in, and nothing more. A 95-page
standard sits in "parsing" for several minutes while a model reads its rules
twice and describes forty diagrams, and from outside that is indistinguishable
from a worker that died holding the job. So each stage says what it is doing,
and how far through it is when that is countable, on the job row itself.

Bound once per job, like `usage.bind`, so a stage reports with one call and no
extra argument:

    progress.step("Describing figures", done=3, total=12)

Two properties matter more than the report itself:

- **It never fails a job.** A progress write is a courtesy. If the database
  refuses it — the column not migrated yet, a connection blip — the job carries
  on and the report goes quiet.
- **It never writes to a job this worker no longer holds.** Ownership is in the
  predicate, as it is for the heartbeat, so a worker that was reaped cannot
  overwrite what the worker that took over is reporting.
"""

from __future__ import annotations

import contextvars
import json
import time
from dataclasses import dataclass, field

from . import db, logs

log = logs.get(__name__)

# Writes closer together than this are skipped, unless the step changed or a
# count reached its total. The page polls every few seconds; writing more often
# than that costs round trips nobody sees.
MIN_INTERVAL_SECONDS = 2.0

# Finished steps kept for the record, oldest dropped first.
MAX_TRAIL = 24


@dataclass
class _Tracker:
    job_id: str
    owner: str
    attempt: int
    started_at: str
    step: str | None = None
    step_started: float = 0.0
    done: int | None = None
    total: int | None = None
    trail: list[dict] = field(default_factory=list)
    last_write: float = 0.0
    broken: bool = False


_context: contextvars.ContextVar[_Tracker | None] = contextvars.ContextVar(
    "aidp_progress", default=None
)


def bind(job_id: str | None, owner: str = "", attempt: int = 0) -> None:
    """Start reporting for a job, or stop with None.

    Binding writes at once, so a claimed job shows as started straight away and a
    retry does not go on showing the step the last attempt died in.
    """
    if job_id is None:
        _context.set(None)
        return
    tracker = _Tracker(
        job_id=job_id, owner=owner, attempt=attempt, started_at=db.now().isoformat()
    )
    _context.set(tracker)
    _write(tracker)


def step(label: str, *, done: int | None = None, total: int | None = None) -> None:
    """Report the current step, optionally as a count. Never raises."""
    tracker = _context.get()
    if tracker is None or tracker.broken:
        return

    now = time.monotonic()
    changed = label != tracker.step
    if changed and tracker.step is not None:
        tracker.trail.append(
            {"step": tracker.step, "seconds": round(now - tracker.step_started, 1)}
        )
        del tracker.trail[:-MAX_TRAIL]
    if changed:
        tracker.step_started = now

    tracker.step, tracker.done, tracker.total = label, done, total
    reached = done is not None and total is not None and done >= total
    if changed or reached or now - tracker.last_write >= MIN_INTERVAL_SECONDS:
        _write(tracker)


def snapshot(tracker: _Tracker) -> dict:
    """The JSON stored on the job. Read by the app; see src/lib/ingest/pipeline.ts."""
    return {
        "attempt": tracker.attempt,
        "startedAt": tracker.started_at,
        "step": tracker.step,
        "done": tracker.done,
        "total": tracker.total,
        "trail": tracker.trail,
        "at": db.now().isoformat(),
    }


def _write(tracker: _Tracker) -> None:
    tracker.last_write = time.monotonic()
    try:
        with db.connection() as conn:
            db.execute(
                conn,
                """
                UPDATE "job" SET "progress" = %s::jsonb
                 WHERE "id" = %s AND "leaseOwner" = %s AND "state" = 'leased'
                """,
                (json.dumps(snapshot(tracker)), tracker.job_id, tracker.owner),
            )
    except Exception as exc:  # noqa: BLE001 — a report must never fail the job
        # Once is enough: a missing column fails every write the same way.
        tracker.broken = True
        logs.warn(log, "progress not recorded, continuing without", error=str(exc)[:200])
