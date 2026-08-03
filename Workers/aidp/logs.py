"""Structured logging with a correlation id threaded through every stage.

Solution Architecture Standards §7.3 asks for structured logs with correlation
identifiers propagated across service calls, and the customer's own DevOps
principle 9 says the same. A pipeline that hands work between four processes is
exactly the case they had in mind, so the correlation id rides in a ContextVar
and lands in every line without each call site remembering to pass it.

Their Integration principle 9 also requires logging standards to "explicitly
mandate the masking of personally identifiable information". The revision-history
tables in the sample corpus name real people, so `scrub()` exists and is applied
to anything that came out of a document.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from contextvars import ContextVar
from typing import Any

_correlation_id: ContextVar[str | None] = ContextVar("correlation_id", default=None)
_document_id: ContextVar[str | None] = ContextVar("document_id", default=None)

# Deliberately blunt. This runs over log payloads, never over stored content —
# masking the corpus itself would defeat the product.
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b")
_LONG_DIGITS = re.compile(r"\b\d{9,}\b")


def scrub(text: str, limit: int = 400) -> str:
    """Mask obvious PII and truncate. For values lifted out of a document."""
    text = _EMAIL.sub("<email>", text)
    text = _LONG_DIGITS.sub("<number>", text)
    return text if len(text) <= limit else text[:limit] + "…"


def bind(correlation_id: str | None = None, document_id: str | None = None) -> None:
    if correlation_id is not None:
        _correlation_id.set(correlation_id)
    if document_id is not None:
        _document_id.set(document_id)


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if cid := _correlation_id.get():
            payload["correlationId"] = cid
        if did := _document_id.get():
            payload["documentId"] = did
        if extra := getattr(record, "fields", None):
            payload.update(extra)
        if record.exc_info:
            payload["error"] = self.formatException(record.exc_info)[-2000:]
        return json.dumps(payload, default=str)


def setup(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    # httpx is chatty at INFO and says nothing we act on.
    for noisy in ("httpx", "httpcore", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get(name: str) -> logging.Logger:
    return logging.getLogger(name)


def info(log: logging.Logger, msg: str, **fields: Any) -> None:
    log.info(msg, extra={"fields": fields})


def warn(log: logging.Logger, msg: str, **fields: Any) -> None:
    log.warning(msg, extra={"fields": fields})


def error(log: logging.Logger, msg: str, exc: bool = False, **fields: Any) -> None:
    log.error(msg, exc_info=exc, extra={"fields": fields})
