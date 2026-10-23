"""The embed stage tells the app, and nothing it says can fail the job.

The pipeline stops at embed: `queue.NEXT_STAGE["embed"]` is None, and deciding
to assess is not the worker's decision to make — it needs the framework
version, which of a project's designs are ready and how many findings that
comes to, none of which this process has. So when a document lands `ready` the
worker says so, and the app decides what follows.

The one rule this has to hold: **a document that is embedded is embedded.**
Whether the app heard about it is a separate question, and the app's own timer
is what guarantees a request eventually moves. An embed stage that could fail
on a notification would retry, and eventually dead-letter, a document it had
already finished — turning a courtesy call into the thing that loses the work.

What this proves:

  · the call carries the document id and the shared secret, to the address the
    app serves, in the shape /api/internal/advance-requests accepts;
  · nothing is attempted when there is nobody to tell, which is the ordinary
    local arrangement and not a fault;
  · every way the call can go wrong — refused, timed out, rejected, or
    answered with something unreadable — leaves the caller unharmed;
  · the secret never reaches a log, but whether one was sent does, because a
    refused connection and a rejected secret are different faults and somebody
    has to tell them apart without the secret being printed.

No database and no network: the client is replaced.

    python tests/test_notify.py
"""

from __future__ import annotations

import logging
import pathlib
import sys
from dataclasses import replace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from aidp import notify  # noqa: E402
from aidp.config import Config  # noqa: E402

passed = 0
failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name}", extra)


def config(**overrides) -> Config:
    """A config carrying only the two fields this module reads.

    Built with `replace` rather than by poking a frozen dataclass, so a field
    named here that the real Config does not have fails loudly instead of being
    quietly ignored.
    """
    base = dict(app_base_url="https://app.example", worker_shared_secret="s3cret")
    base.update(overrides)
    return replace(Config(stage="embed", database_url="postgresql://unused"), **base)


class _Client:
    """Stands in for httpx.Client. Records the call, or raises instead."""

    sent: dict = {}

    def __init__(self, response=None, raises=None, **_kwargs):
        self._response = response
        self._raises = raises

    def __call__(self, **_kwargs):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def post(self, url, json, headers):
        _Client.sent = {"url": url, "json": json, "headers": headers}
        if self._raises is not None:
            raise self._raises
        return self._response


def install(client) -> None:
    notify.get_config = lambda: client.cfg  # type: ignore[attr-defined]
    notify.httpx.Client = client  # type: ignore[assignment]


def arrange(*, response=None, raises=None, **overrides):
    """Point the module at a stub client and a config, and return the stub."""
    stub = _Client(response=response, raises=raises)
    stub.cfg = config(**overrides)  # type: ignore[attr-defined]
    _Client.sent = {}
    install(stub)
    return stub


class _Refuse:
    """A client that must never be constructed."""

    cfg: Config

    def __call__(self, **_kwargs):
        raise AssertionError("no call should have been attempted")


_real_config = notify.get_config
_real_client = notify.httpx.Client

print("\nWhat the call carries")

arrange(response=httpx.Response(200, json={"started": 1, "waiting": 0, "failed": 0}))
notify.document_ready("doc-1")
ok(
    "it posts to the endpoint the app serves",
    _Client.sent.get("url") == "https://app.example/api/internal/advance-requests",
    _Client.sent.get("url"),
)
ok(
    "naming the document that is ready",
    _Client.sent.get("json") == {"documentId": "doc-1"},
    _Client.sent.get("json"),
)
ok(
    "with the header the workers already use for credentials and files",
    (_Client.sent.get("headers") or {}).get("x-worker-secret") == "s3cret",
)

print("\nWhen there is nobody to tell")

for label, overrides in (
    ("no app address is configured", {"app_base_url": None}),
    ("no shared secret is configured", {"worker_shared_secret": None}),
):
    refuser = _Refuse()
    refuser.cfg = config(**overrides)
    install(refuser)
    try:
        notify.document_ready("doc-1")
        ok(f"{label}: nothing is attempted", True)
    except AssertionError as exc:
        ok(f"{label}: nothing is attempted", False, exc)

refuser = _Refuse()
refuser.cfg = config()
install(refuser)
try:
    notify.document_ready(None)
    ok("a job with no document makes no call", True)
except AssertionError as exc:
    ok("a job with no document makes no call", False, exc)

print("\nEvery way it can go wrong leaves the job finished")

request = httpx.Request("POST", "https://app.example/api/internal/advance-requests")
for label, failure in (
    ("the app refuses the connection", httpx.ConnectError("refused")),
    ("the app is too slow", httpx.ReadTimeout("slow")),
    (
        "the app rejects the secret",
        httpx.HTTPStatusError("401", request=request, response=httpx.Response(401)),
    ),
    ("the reply is not readable", ValueError("not json")),
):
    arrange(raises=failure)
    try:
        notify.document_ready("doc-1")
        ok(label, True)
    except Exception as exc:  # noqa: BLE001 — that it raised at all is the failure
        ok(label, False, f"{type(exc).__name__}: {exc}")

# A non-2xx reply reaches raise_for_status rather than the except clause above,
# which is a different path through the same guarantee.
arrange(response=httpx.Response(401, json={"error": "not authorised"}, request=request))
try:
    notify.document_ready("doc-1")
    ok("a 401 is swallowed too", True)
except Exception as exc:  # noqa: BLE001
    ok("a 401 is swallowed too", False, f"{type(exc).__name__}: {exc}")

print("\nWhat a failure says, and what it does not")


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record):
        self.records.append(record)


capture = _Capture()
logger = logging.getLogger("aidp.notify")
logger.addHandler(capture)
logger.setLevel(logging.WARNING)

arrange(raises=httpx.ConnectError("refused"))
notify.document_ready("doc-1")

logger.removeHandler(capture)

ok("the failure is reported once", len(capture.records) == 1, len(capture.records))
fields = getattr(capture.records[0], "fields", {}) if capture.records else {}
message = capture.records[0].getMessage() if capture.records else ""

ok("the secret is not in the message", "s3cret" not in message)
ok("nor in the structured fields", "s3cret" not in repr(fields))
ok(
    "but whether one was sent is, because that is the other fault",
    fields.get("secret") == "sent",
    fields.get("secret"),
)
ok(
    "and the address it tried, because that is usually the real answer",
    fields.get("endpoint") == "https://app.example/api/internal/advance-requests",
    fields.get("endpoint"),
)
ok("and which document it was about", fields.get("documentId") == "doc-1")
ok(
    "and it says the timer will catch it, so nobody goes looking for a lost job",
    "timer" in message,
    message,
)

notify.get_config = _real_config
notify.httpx.Client = _real_client

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
