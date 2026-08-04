"""The two jobs in this pipeline that need a language model.

1. Figure descriptions. The sample corpus contains an Enterprise Context Diagram
   holding a customer's entire application landscape behind an empty text layer.
   Without a vision pass, that page contributes nothing to retrieval.

2. Contextual preambles. One or two sentences situating each chunk in its
   document, prepended before embedding.

Provider is a config switch. Gemini is the default; Anthropic is kept because
the choice was described as "for now", and behind this interface swapping back
is one environment variable rather than an edit.

Both are reached over plain HTTP rather than through a vendor SDK, which keeps
the dependency list short and the two providers symmetrical.

A note on cost. The Anthropic path marks the document as a cached prefix, so a
run over hundreds of chunks pays for the document roughly once. Gemini's
explicit context caching has a minimum token count that most of these documents
sit under, and implicit caching is not something to rely on for a cost estimate —
so the Gemini path sends a trimmed document per chunk and uses a flash-class
model to keep that affordable. If preamble cost becomes the dominant line item,
that trade is the first thing to revisit.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Protocol

import httpx

from .. import logs
from ..config import get_config

log = logs.get(__name__)

TIMEOUT = httpx.Timeout(180.0, connect=15.0)

_FIGURE_PROMPT = """\
This image is a figure from an enterprise architecture or governance document.

Describe it so that someone searching the document in plain language can find it, \
and so that an auditor reading your description alone learns what the figure \
asserts. Be specific and exhaustive about content:

- Every named system, component, actor, or zone that appears
- The relationships between them, including direction where the diagram shows it
- Any grouping, layering, tiering, or swimlane structure
- Any labels, legends, or annotations

Write flowing prose, not a bulleted list. Do not preface it with "This image \
shows" — begin with the content itself. If the figure is decorative and carries \
no information, reply with exactly: NO_INFORMATION"""

_CONTEXT_PROMPT = """\
Here is a chunk taken from the document above:

<chunk>
{chunk}
</chunk>

Give one or two short sentences situating this chunk within the document, so \
that it can be understood and retrieved on its own. Name the standard or section \
it belongs to and what it governs. Answer with the context only — no preamble, \
no repetition of the chunk."""


_JUDGE_PROMPT = """\
You are auditing a submitted design document against one clause of an enterprise \
standard. Decide whether the design satisfies the clause, using only the extracts \
provided. You cannot see the rest of the document.

<standard_clause>
Reference: {reference}
{clause}
</standard_clause>

<extracts_from_submitted_document>
{extracts}
</extracts_from_submitted_document>
{precedents}
Choose exactly one verdict:

- "covered"      — the extracts address every requirement in the clause
- "partial"      — the extracts address the clause but leave a requirement unmet
- "contradicts"  — the design states something the clause forbids, or forbids
                   something it requires
- "absent"       — the extracts are clearly about other subjects, and the design
                   does not address this clause at all
- "needs_review" — you cannot tell. The extracts are adjacent to the subject but
                   inconclusive, or the clause turns on something the extracts
                   neither confirm nor deny

Rules that matter more than being decisive:

1. "covered", "partial" and "contradicts" MUST cite at least one extract id. A
   claim about a document that cites nothing in it is invented.
2. Choose "absent" only when the extracts are plainly about other topics. If the
   design seems to touch the subject but you cannot confirm the requirement,
   choose "needs_review". A wrong "absent" sends someone to fix a thing that is
   already there; a wrong "covered" ships a gap. "needs_review" costs a human
   two minutes and is the right answer whenever you are unsure.
3. Judge only what the clause requires. Do not reward the design for good
   practice the clause does not ask for.
4. confidence is your own certainty in the verdict, 0 to 1.
5. Standing decisions, where any are given, are this organisation's own settled
   rulings and outrank your general judgement about what good practice looks
   like. If one resolves the clause, follow it and list its id in
   appliedDecisions. Never list an id you were not given. A decision marked
   "on a related clause" is guidance, not a ruling — it can inform a verdict but
   cannot settle one on its own.

Reply with JSON only, no prose around it:
{{"verdict": "...", "confidence": 0.0, "rationale": "one sentence",
  "evidence": ["extract id", ...], "appliedDecisions": ["decision id", ...]}}"""


class QuotaExhausted(RuntimeError):
    """A per-day quota is spent. Retrying will not help until tomorrow."""


def _quota_detail(body: dict) -> tuple[bool, float | None]:
    """(daily cap hit, seconds to wait) from a Google 429 body."""
    daily = False
    retry_after: float | None = None
    for detail in body.get("error", {}).get("details", []):
        kind = detail.get("@type", "")
        if "QuotaFailure" in kind:
            for violation in detail.get("violations", []):
                if "PerDay" in (violation.get("quotaId") or ""):
                    daily = True
        elif "RetryInfo" in kind:
            raw = str(detail.get("retryDelay", "")).rstrip("s")
            try:
                retry_after = float(raw)
            except ValueError:
                pass
    return daily, retry_after


def _post(url: str, headers: dict, payload: dict, attempts: int = 4) -> dict:
    delay = 1.5
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            with httpx.Client(timeout=TIMEOUT) as client:
                res = client.post(url, headers=headers, json=payload)

            if res.status_code == 429:
                try:
                    body = res.json()
                except ValueError:
                    body = {}
                daily, retry_after = _quota_detail(body)
                if daily:
                    raise QuotaExhausted(
                        "the model's per-day free-tier quota is exhausted; enable billing "
                        "on the Google Cloud project or wait for the daily reset"
                    )
                # Google tells us how long to wait. Guessing is worse.
                wait = retry_after if retry_after is not None else delay
                if attempt == attempts - 1:
                    raise RuntimeError(f"429 after {attempts} attempts: {res.text[:160]}")
                time.sleep(min(wait, 90))
                delay = min(delay * 2, 30)
                continue

            if res.status_code >= 500:
                raise RuntimeError(f"{res.status_code}: {res.text[:200]}")
            res.raise_for_status()
            return res.json()
        except QuotaExhausted:
            raise
        except Exception as exc:  # noqa: BLE001 — retried, re-raised below
            last = exc
            if attempt == attempts - 1:
                break
            time.sleep(delay)
            delay = min(delay * 2, 30)
    raise RuntimeError(f"model request failed after {attempts} attempts: {last}")


class LLM(Protocol):
    def describe_figure(
        self, image_png: bytes, *, heading_path: str, caption: str | None
    ) -> str: ...
    def contextualise(self, document_text: str, chunk_text: str, *, title: str) -> str: ...
    def judge(
        self, *, reference: str, clause: str, extracts: str, precedents: str = ""
    ) -> dict: ...


# Verdict shape, enforced by the API rather than requested in the prompt.
# Without it the model returns plausible-looking but truncated JSON — observed
# as `{"verdict": "covered", ""}` with a finish reason of STOP, which parses as
# nothing and would silently cost a clause.

def _precedent_block(precedents: str) -> str:
    """Wrap the register for the prompt, or contribute nothing.

    An empty string rather than "none recorded": a header announcing an absence
    is tokens on every clause of every run, and invites the model to remark on
    it in the rationale.
    """
    if not precedents.strip():
        return ""
    return (
        "\n<standing_decisions>\n"
        "Rulings this organisation has already made. They outrank general practice.\n"
        f"{precedents}\n"
        "</standing_decisions>\n"
    )


_VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {
            "type": "string",
            "enum": ["covered", "partial", "absent", "contradicts", "needs_review"],
        },
        "confidence": {"type": "number"},
        "rationale": {"type": "string"},
        "evidence": {"type": "array", "items": {"type": "string"}},
        "appliedDecisions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["verdict", "confidence", "rationale", "evidence", "appliedDecisions"],
    "propertyOrdering": [
        "verdict",
        "confidence",
        "rationale",
        "evidence",
        "appliedDecisions",
    ],
}


class GeminiLLM:
    BASE = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self, api_key: str, model: str, thinking_budget: int = 0) -> None:
        self.api_key = api_key
        self.model = model
        # 2.5 Flash is a thinking model, and thinking is billed against the same
        # output budget as the answer. At the sizes these calls use, it spends
        # the whole allowance reasoning and returns an empty response with
        # finishReason MAX_TOKENS — a silent failure across every clause.
        #
        # None of these three tasks needs it: two are summarisation and the
        # third is grounded classification against extracts already in the
        # prompt. Set GEMINI_THINKING_BUDGET above 0 only on a model that
        # requires it (2.5 Pro cannot disable thinking).
        self.thinking_budget = thinking_budget

    def _generate(
        self,
        parts: list[dict],
        *,
        system: str | None,
        max_tokens: int,
        schema: dict | None = None,
    ) -> str:
        config: dict = {
            "maxOutputTokens": max_tokens,
            "temperature": 0.0 if schema else 0.2,
            "thinkingConfig": {"thinkingBudget": self.thinking_budget},
        }
        if schema:
            config["responseMimeType"] = "application/json"
            config["responseSchema"] = schema

        payload: dict = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": config,
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}

        data = _post(
            f"{self.BASE}/{self.model}:generateContent",
            {"x-goog-api-key": self.api_key, "content-type": "application/json"},
            payload,
        )
        candidates = data.get("candidates") or []
        if not candidates:
            # Usually a safety block or an empty completion; treat as "nothing
            # to say" rather than failing the document over it.
            logs.warn(log, "gemini returned no candidates", feedback=str(data)[:200])
            return ""
        parts_out = candidates[0].get("content", {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts_out).strip()

    def describe_figure(self, image_png: bytes, *, heading_path: str, caption: str | None) -> str:
        where = f"Location in document: {heading_path}"
        if caption:
            where += f"\nCaption as printed: {caption}"
        text = self._generate(
            [
                {"text": f"{where}\n\n{_FIGURE_PROMPT}"},
                {
                    "inline_data": {
                        "mime_type": "image/png",
                        "data": base64.b64encode(image_png).decode(),
                    }
                },
            ],
            system=None,
            max_tokens=1200,
        )
        return "" if text.strip() == "NO_INFORMATION" else text

    def contextualise(self, document_text: str, chunk_text: str, *, title: str) -> str:
        return self._generate(
            [{"text": _CONTEXT_PROMPT.format(chunk=chunk_text[:6000])}],
            system=(
                f"You are indexing the document '{title}'.\n\n"
                f"<document>\n{document_text[:60_000]}\n</document>"
            ),
            max_tokens=200,
        )


    def judge(
        self, *, reference: str, clause: str, extracts: str, precedents: str = ""
    ) -> dict:
        text = self._generate(
            [
                {
                    "text": _JUDGE_PROMPT.format(
                        reference=reference,
                        clause=clause,
                        extracts=extracts,
                        precedents=_precedent_block(precedents),
                    )
                }
            ],
            system=None,
            max_tokens=2048,
            schema=_VERDICT_SCHEMA,
        )
        if not text:
            raise RuntimeError("gemini returned an empty verdict")
        return _parse_json(text)


class AnthropicLLM:
    BASE = "https://api.anthropic.com/v1/messages"
    VERSION = "2023-06-01"

    def __init__(self, api_key: str, model: str, fast_model: str) -> None:
        self.api_key = api_key
        self.model = model
        self.fast_model = fast_model

    def _headers(self) -> dict:
        return {
            "x-api-key": self.api_key,
            "anthropic-version": self.VERSION,
            "content-type": "application/json",
        }

    @staticmethod
    def _text_of(data: dict) -> str:
        return "".join(
            b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
        ).strip()

    def describe_figure(self, image_png: bytes, *, heading_path: str, caption: str | None) -> str:
        where = f"Location in document: {heading_path}"
        if caption:
            where += f"\nCaption as printed: {caption}"
        data = _post(
            self.BASE,
            self._headers(),
            {
                "model": self.model,
                "max_tokens": 1200,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": base64.b64encode(image_png).decode(),
                                },
                            },
                            {"type": "text", "text": f"{where}\n\n{_FIGURE_PROMPT}"},
                        ],
                    }
                ],
            },
        )
        text = self._text_of(data)
        return "" if text.strip() == "NO_INFORMATION" else text

    def contextualise(self, document_text: str, chunk_text: str, *, title: str) -> str:
        doc = document_text[:180_000]
        system: list[dict] = [
            {
                "type": "text",
                "text": (
                    f"You are indexing the document '{title}'.\n\n"
                    f"<document>\n{doc}\n</document>"
                ),
            }
        ]
        # The document is the same for every chunk in a run, so mark it cacheable.
        if len(doc) > 4000:
            system[0]["cache_control"] = {"type": "ephemeral"}

        data = _post(
            self.BASE,
            self._headers(),
            {
                "model": self.fast_model,
                "max_tokens": 200,
                "system": system,
                "messages": [
                    {"role": "user", "content": _CONTEXT_PROMPT.format(chunk=chunk_text[:6000])}
                ],
            },
        )
        return self._text_of(data)


    def judge(
        self, *, reference: str, clause: str, extracts: str, precedents: str = ""
    ) -> dict:
        data = _post(
            self.BASE,
            self._headers(),
            {
                "model": self.model,
                "max_tokens": 700,
                "temperature": 0,
                "messages": [
                    {
                        "role": "user",
                        "content": _JUDGE_PROMPT.format(
                            reference=reference,
                            clause=clause,
                            extracts=extracts,
                            precedents=_precedent_block(precedents),
                        ),
                    },
                    # Prefilling the opening brace is the closest equivalent to
                    # Gemini's structured output: it removes the "Here is the
                    # JSON:" preamble that otherwise breaks parsing.
                    {"role": "assistant", "content": "{"},
                ],
            },
        )
        return _parse_json("{" + self._text_of(data))


_client: LLM | None = None


def _parse_json(raw: str) -> dict:
    """Parse a model's JSON reply, tolerating fenced or padded output.

    Deliberately strict about the result being a dict: a list or a bare string
    means the model answered a different question, and coercing it would produce
    a verdict nobody chose.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text[3:]
        text = text.removeprefix("json").strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise RuntimeError(f"model reply was not JSON: {text[:200]}") from None
        parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise RuntimeError(f"model reply was not a JSON object: {text[:200]}")
    return parsed


def available() -> bool:
    cfg = get_config()
    if cfg.llm_provider.lower() == "anthropic":
        return bool(cfg.anthropic_api_key)
    return bool(cfg.gemini_api_key)


def client() -> LLM:
    global _client
    if _client is None:
        cfg = get_config()
        provider = cfg.llm_provider.lower()
        if provider == "anthropic":
            if not cfg.anthropic_api_key:
                raise RuntimeError("ANTHROPIC_API_KEY is not set")
            _client = AnthropicLLM(cfg.anthropic_api_key, cfg.claude_model, cfg.claude_fast_model)
        elif provider == "gemini":
            if not cfg.gemini_api_key:
                raise RuntimeError("GEMINI_API_KEY is not set")
            _client = GeminiLLM(
                cfg.gemini_api_key, cfg.gemini_model, cfg.gemini_thinking_budget
            )
        else:
            raise SystemExit(f"unknown LLM_PROVIDER {cfg.llm_provider!r}")
    return _client


def describe_figure(image_png: bytes, *, heading_path: str, caption: str | None) -> str:
    return client().describe_figure(image_png, heading_path=heading_path, caption=caption)


def contextualise(document_text: str, chunk_text: str, *, title: str) -> str:
    return client().contextualise(document_text, chunk_text, title=title)


def judge(*, reference: str, clause: str, extracts: str, precedents: str = "") -> dict:
    return client().judge(
        reference=reference, clause=clause, extracts=extracts, precedents=precedents
    )


def contextualise_many(
    document_text: str, chunks: list[str], *, title: str, on_error: str = "skip"
) -> list[str]:
    """Preambles for a document's chunks, in order.

    Sequential on purpose. On Anthropic the first call writes the cache entry
    every later call reads, so firing them in parallel would race and each pay
    full price. On Gemini it simply keeps the request rate civil.

    A failure degrades the chunk rather than failing the document — an
    un-contextualised chunk still embeds and still retrieves.
    """
    llm = client()
    out: list[str] = []
    for i, chunk in enumerate(chunks):
        try:
            out.append(llm.contextualise(document_text, chunk, title=title))
        except QuotaExhausted:
            # Every remaining chunk would fail the same way. Fill the rest and
            # let the caller record why, rather than making a hundred more calls
            # that are guaranteed to be refused.
            logs.warn(
                log,
                "quota exhausted, skipping remaining preambles",
                done=i,
                total=len(chunks),
            )
            out.extend([""] * (len(chunks) - i))
            return out
        except Exception as exc:  # noqa: BLE001 — deliberate degrade-not-fail
            if on_error == "raise":
                raise
            logs.warn(log, "contextualisation failed, continuing", index=i, error=str(exc)[:200])
            out.append("")
        if i and i % 25 == 0:
            time.sleep(0.2)
    return out
