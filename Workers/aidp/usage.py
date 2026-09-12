"""What the models cost, and who spent it.

An administrator on the customer side is shown their organisation's model spend
broken down by person. This is where those numbers come from: one row in
`token_usage` per provider call, written by the code that made the call.

Attribution without threading it through every signature
--------------------------------------------------------
The interesting number is per *person*, and the code that calls a model is four
layers below anything that knows who a person is. Passing an attribution
argument down through `llm.judge` and `embeddings.embed_all` would put a
bookkeeping parameter on every AI function in the codebase, and every new call
site would be one more place to forget it.

So the worker loop sets the context once per job (`bind`, from __main__) and the
provider clients read it from a `ContextVar` when they report. A ContextVar
rather than a module global because the reaper runs as a daemon thread beside
the handler; a global would be shared state between them.

Never fails the work
--------------------
Every function here swallows its own errors. A failure to record what something
cost must not fail the thing itself — a lost row costs an administrator a
slightly low number, while a raised exception costs the customer their
assessment. That trade is only correct in this direction, and it is why nothing
in this module is allowed to raise.
"""

from __future__ import annotations

import contextvars
from dataclasses import dataclass

from . import db, logs

log = logs.get(__name__)


@dataclass(frozen=True)
class Attribution:
    organisation_id: str
    stage: str
    document_id: str | None = None
    run_id: str | None = None
    user_id: str | None = None


_context: contextvars.ContextVar[Attribution | None] = contextvars.ContextVar(
    "aidp_usage_attribution", default=None
)


def current() -> Attribution | None:
    return _context.get()


def bind(attribution: Attribution | None) -> None:
    _context.set(attribution)


def for_job(
    organisation_id: str, stage: str, document_id: str | None, run_id: str | None = None
) -> Attribution:
    """Attribution for a job, resolving the person from the document.

    Whoever submitted the document owns what it costs to process. The lookup
    happens once per job rather than once per call — a run of a hundred clauses
    would otherwise ask the same question a hundred times.

    A document with no uploader (one that predates the column, or whose author's
    account has since been deleted) yields a null `user_id`. Those rows still
    count towards the organisation's total and are shown as unattributed, which
    is true, rather than being dropped or blamed on somebody else.
    """
    user_id: str | None = None
    if document_id:
        try:
            with db.connection() as conn:
                row = db.one(
                    conn,
                    'SELECT "uploadedById" FROM "document" WHERE "id" = %(id)s',
                    {"id": document_id},
                )
            if row:
                user_id = row["uploadedById"]
        except Exception as exc:  # noqa: BLE001 — attribution is not worth a failed job
            logs.warn(log, "could not resolve document uploader", error=str(exc)[:200])

    return Attribution(
        organisation_id=organisation_id,
        stage=stage,
        document_id=document_id,
        run_id=run_id,
        user_id=user_id,
    )


_INSERT = """
INSERT INTO "token_usage" (
    "id", "organisationId", "userId", "documentId", "runId",
    "stage", "kind", "provider", "model",
    "inputTokens", "outputTokens", "totalTokens", "estimated", "createdAt"
) VALUES (
    %(id)s, %(org)s, %(user)s, %(doc)s, %(run)s,
    %(stage)s, %(kind)s, %(provider)s, %(model)s,
    %(input)s, %(output)s, %(total)s, %(estimated)s, %(now)s
)
"""


def record(
    *,
    kind: str,
    provider: str,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    estimated: bool = False,
    run_id: str | None = None,
) -> None:
    """Write one usage row against the bound attribution.

    Silently does nothing when nothing is bound. That is the case for the smoke
    tests and any script that calls the AI modules directly, and those have no
    organisation to bill.
    """
    attribution = _context.get()
    if attribution is None:
        return

    try:
        with db.connection() as conn:
            db.execute(
                conn,
                _INSERT,
                {
                    "id": db.new_id(),
                    "org": attribution.organisation_id,
                    "user": attribution.user_id,
                    "doc": attribution.document_id,
                    "run": run_id or attribution.run_id,
                    "stage": attribution.stage,
                    "kind": kind,
                    "provider": provider,
                    "model": model,
                    "input": max(0, int(input_tokens)),
                    "output": max(0, int(output_tokens)),
                    "total": max(0, int(input_tokens)) + max(0, int(output_tokens)),
                    "estimated": estimated,
                    "now": db.now(),
                },
            )
    except Exception as exc:  # noqa: BLE001 — see the module docstring
        logs.warn(log, "could not record token usage", error=str(exc)[:200])


def estimate_tokens(text: str) -> int:
    """Tokens in a string, roughly.

    Four characters per token is the usual rule of thumb for English prose in a
    byte-pair vocabulary, and these are English documents. It runs low on dense
    technical text full of identifiers, which is why rows derived from it are
    flagged `estimated` rather than blended into the exact ones. Good enough for
    a spend indicator; not good enough to bill anyone, and nothing bills anyone.
    """
    return max(1, len(text) // 4)


def from_gemini(data: dict) -> tuple[int, int]:
    """(input, output) from a Gemini response.

    `totalTokenCount` includes reasoning tokens that neither of the other two
    counts covers, so output is taken as the remainder rather than as
    `candidatesTokenCount` — otherwise a thinking model's spend silently
    understates itself.
    """
    meta = data.get("usageMetadata") or {}
    prompt = int(meta.get("promptTokenCount") or 0)
    total = int(meta.get("totalTokenCount") or 0)
    candidates = int(meta.get("candidatesTokenCount") or 0)
    output = max(candidates, total - prompt) if total else candidates
    return prompt, max(0, output)


def from_anthropic(data: dict) -> tuple[int, int]:
    """(input, output) from an Anthropic response.

    Cache reads and writes are counted as input: they are billed, at different
    rates, and a token figure that ignored them would understate a cached run
    to near zero.
    """
    usage = data.get("usage") or {}
    inputs = (
        int(usage.get("input_tokens") or 0)
        + int(usage.get("cache_creation_input_tokens") or 0)
        + int(usage.get("cache_read_input_tokens") or 0)
    )
    return inputs, int(usage.get("output_tokens") or 0)


def from_openai(data: dict) -> tuple[int, int]:
    """(input, output) from an OpenAI-shaped response — OpenRouter's included.

    Reasoning tokens are already inside `completion_tokens` there, and cached
    prompt tokens inside `prompt_tokens`, so no remainder arithmetic is needed.
    """
    usage = data.get("usage") or {}
    return int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
