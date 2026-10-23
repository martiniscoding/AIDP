"""Telling the app that a document has finished indexing.

The pipeline stops at embed. `queue.NEXT_STAGE["embed"]` is None and nothing
creates an analyse job on its own, because deciding to assess is not the
worker's decision to make: it needs the framework version, which of a project's
designs are ready, and how many findings that comes to — all of which live in
the app, in TypeScript, and none of which this process has.

So when a document lands `ready`, this says so, and the app decides whether
anything follows. For a design submitted through the architecture-request form
the answer is yes, and the assessment starts within the second. For a design
somebody uploaded by hand it is no, and a person presses Assess as before.

**This cannot fail the job that calls it.** A document that is embedded is
embedded; whether the app heard about it is a separate question, and the app
sweeps for missed ones on a timer anyway. So every error here is logged and
swallowed — the alternative is an embed stage that retries, and eventually
dead-letters, a document it has already finished.

The same arrangement as credentials.py and storage.py, and for the same
reasons: one shared secret, one base URL, both already configured wherever a
worker runs against a deployed app.
"""

from __future__ import annotations

import httpx

from . import logs
from .config import get_config

log = logs.get(__name__)

#: Short on purpose. This is a courtesy call at the end of a job that has
#: already done its work, and the app's own timer is the thing that guarantees
#: the request moves. Waiting thirty seconds on it would hold a worker off the
#: next document for no gain.
TIMEOUT = 5.0

PATH = "/api/internal/advance-requests"


def document_ready(document_id: str | None) -> None:
    """Tell the app a document has finished indexing, if there is an app to tell.

    Never raises.
    """
    if not document_id:
        return

    cfg = get_config()
    if not cfg.app_base_url or not cfg.worker_shared_secret:
        # No way to reach it, which is the ordinary local arrangement — the
        # same condition storage.py reads as "use the local backend". Nothing
        # is wrong; there is simply nobody to tell.
        return

    endpoint = cfg.app_base_url.rstrip("/") + PATH
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            res = client.post(
                endpoint,
                json={"documentId": document_id},
                headers={"x-worker-secret": cfg.worker_shared_secret},
            )
            res.raise_for_status()
            result = res.json()
    except Exception as exc:  # noqa: BLE001 — see the module docstring
        # Named the way credentials.py names its address, and for the same
        # reason: "connection refused" on its own sends people to look at an app
        # that is running perfectly well somewhere the worker was not pointed.
        # The secret is never printed, only whether one was sent.
        logs.warn(
            log,
            "could not tell the app this document is ready; its timer will catch it",
            documentId=document_id,
            endpoint=endpoint,
            secret="sent" if cfg.worker_shared_secret else "missing",
            error=str(exc)[:200],
        )
        return

    # Only worth a line when something actually followed. A design uploaded by
    # hand answers zero to all three, which is every document that is not an
    # architecture request, and is not news.
    if isinstance(result, dict) and result.get("started"):
        logs.info(
            log,
            "the app started an assessment for this document",
            documentId=document_id,
            started=result.get("started"),
        )
