"""The two jobs in this pipeline that need a language model.

1. Figure descriptions. The sample corpus contains an Enterprise Context Diagram
   holding a customer's entire application landscape behind an empty text layer.
   Without a vision pass, that page contributes nothing to retrieval.

2. Contextual preambles. One or two sentences situating each chunk in its
   document, prepended before embedding.

Provider is a config switch. OpenRouter is what is deployed — one key, OpenAI's
models behind it, every request sent with `data_collection: deny` and pinned to
the model's own vendor. Gemini and Anthropic are kept, and swapping between the
three is one environment variable rather than an edit.

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

from .. import logs, usage
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


_SUMMARY_PROMPT = """\
Read this document and say what it is for.

<document>
{document}
</document>

Answer in three or four sentences, covering:

- what kind of document it is, and what decision or work it exists to support
- what it is about, named specifically — the systems, vendors, products or
  programme it concerns
- if it sets out options, alternatives or a comparison, say so and name what is
  being compared against what

Write it so that someone reading a single paragraph from this document, with no \
other view of it, would understand what they are looking at. State only what the \
document itself supports. No preamble, no headings."""


_JUDGE_PROMPT = """\
You are auditing a submitted design document against one clause of an enterprise \
standard. Decide whether the design satisfies the clause, using only the extracts \
provided. You cannot see the rest of the document.
{document_context}
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
    """A per-day quota is spent, or a paid account's credit is. Retrying will
    not help until someone adds more."""


class _Refused(RuntimeError):
    """A request the provider turned down outright. Repeating it cannot help."""


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

            if res.status_code == 402:
                # OpenRouter's answer when the account's credit has run out.
                # Like a spent daily quota, repeating the request cannot help.
                raise QuotaExhausted(
                    "the model provider account is out of credits; add credits and re-run"
                )
            if 400 <= res.status_code < 500 and res.status_code not in (408, 409, 429):
                # Refused outright — a bad key, a schema the model will not
                # accept, a model that does not exist. Sending it again returns
                # the same refusal three more times, with a backoff between each.
                raise _Refused(f"{res.status_code}: {res.text[:300]}")

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
        except (QuotaExhausted, _Refused):
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
    def summarise(self, document_text: str, *, title: str) -> str: ...
    def judge(
        self,
        *,
        reference: str,
        clause: str,
        extracts: str,
        precedents: str = "",
        document: str = "",
    ) -> dict: ...
    def structure(
        self, *, numbered: str, first_line: int, last_line: int, tags: str = ""
    ) -> dict: ...
    def read_rules(
        self, *, document: str, title: str, first: int, last: int, whole: bool, attempt: int
    ) -> str: ...


# Verdict shape, enforced by the API rather than requested in the prompt.
# Without it the model returns plausible-looking but truncated JSON — observed
# as `{"verdict": "covered", ""}` with a finish reason of STOP, which parses as
# nothing and would silently cost a clause.

def _document_block(summary: str) -> str:
    """What the submitted document is, or contribute nothing.

    Empty rather than "unknown", for the same reason as the register below: a
    header announcing an absence costs tokens on every clause of every run and
    invites the model to remark on it.

    This is the one thing retrieval cannot supply. Eight passages can say what a
    document contains and never what it is *for*, and a comparison deck read
    that way looks like unrelated claims about two products.
    """
    if not summary.strip():
        return ""
    return (
        "\n<what_this_document_is>\n"
        "Written from the whole document, not from the extracts below. Use it to "
        "read the extracts in context; do not treat it as evidence, and never "
        "cite it.\n"
        f"{summary.strip()}\n"
        "</what_this_document_is>\n"
    )


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



_STRUCTURE_PROMPT = """\
Below are numbered lines from a standards document whose formatting carries no \
structure - every line looks the same. Identify what each line is.

Return one marker per line that starts something. Use these roles:

- "heading"     names a topic and starts a new rule. Short, no full stop, often
                numbered. "Access Control", "3.2 Secure Remote Access".
- "statement"   the rule itself - a sentence asserting an obligation.
- "rationale"   why the rule exists.
- "requirement" a specific testable obligation under the rule, usually one of
                several, often a bullet.
- "guidance"    how to implement it. Only when the document plainly separates
                this from the requirements.

Rules that matter:

1. Only ever return line numbers between {first_line} and {last_line}. Never a
   number outside that range, and never a line that is not shown.
2. Mark only the line where something STARTS. A sentence continuing onto the
   next line needs no marker - the continuation belongs to whatever started it.
3. Do not mark a line that is a label on its own, like "Requirements:" - the
   requirements themselves are what get marked.
4. A table row is not a heading and not a requirement. Leave it unmarked.
5. A rule constrains what a design must DO. A sentence that describes what the
   document is, or what it covers, is not a rule. "This document defines the
   data standards..." and "These standards apply to all systems..." are scope,
   not obligations - mark the heading and leave them unmarked. Purpose, Scope,
   Introduction, Definitions and Glossary sections almost never contain rules.
6. If this window contains no rules at all - a contents page, a glossary, a
   revision table, front matter - return only the headings and no statements.
   That is a correct answer and is expected. Do not invent structure that is
   not there, and do not promote a description to a rule to fill a gap.
{tags}
Reply with JSON only:
{{"markers": [{{"line": 12, "role": "heading"}}, {{"line": 13, "role": "statement"}}]}}

<lines>
{numbered}
</lines>"""

_STRUCTURE_SCHEMA = {
    "type": "object",
    "properties": {
        "markers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": "integer"},
                    "role": {
                        "type": "string",
                        "enum": [
                            "heading",
                            "statement",
                            "rationale",
                            "requirement",
                            "guidance",
                        ],
                    },
                },
                "required": ["line", "role"],
                "propertyOrdering": ["line", "role"],
            },
        }
    },
    "required": ["markers"],
}


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


_RULES_PROMPT = """\
You are reading an enterprise standard so that submitted designs can be assessed \
against its rules. The document "{title}" is below, one numbered line per row{part}.

Tags in square brackets are hints from the file, not part of the text: [heading N] \
was styled as a level-N heading, [bullet] was a list item, and [T2 columns] and \
[T2 row] are the column line and a row of table T2, each cell written as \
"Column: value". A "--- page N ---" row marks where a page starts and is not a line.

You never write or reword any of the document. You answer only with line numbers; \
the text is taken from the document by those numbers afterwards.

Account for every line from {first} to {last}. Each line falls inside exactly one \
rule span or exactly one label range. Section headings are also listed in \
"sections", whether or not they sit inside a rule or a label.

RULES. A rule is something a submitted design can meet or fail: a constraint on \
what a system, solution, architecture or its data must, should or must not do. \
For each rule give:
- "heading": the line naming the rule, if it has one; otherwise null
- "from", "to": the first and last line of everything that belongs to the rule - \
its heading, part labels such as "Requirements:", statement, rationale, \
requirements, guidance, and any table listing its requirements
- "statement": the line(s) stating the rule itself
- "rationale": the line(s) explaining why the rule exists; empty if none
- "requirements": each separately testable obligation as its own entry, with the \
line(s) it spans and its strength - "must" (must, shall, required, prohibited, \
must not, never), "should" (should, recommended), "may" (may, optional). A table \
row stating an obligation is its own entry.
- "guidance": lines on how to implement the rule, when the document keeps them \
apart from its requirements; empty otherwise
- "references": lines elsewhere in the document this rule relies on to be \
understood, such as a classification table or a definition it names; empty if none

LABELS. Every line that is not part of a rule goes in a labelled range, with a \
reason of at most 12 words saying what it is:
- "furniture": cover page, document control, version or revision history, table of \
contents, approvals, sign-off, running headers and footers
- "scope": purpose, scope, audience, introduction, how the document is organised
- "reference": definitions, glossary, classification schemes, catalogues, \
templates, lists of related documents - material rules point to, not rules
- "process_rule": obligations about running the standard rather than about a \
design - exceptions and waivers, approvals, review cycles, compliance, \
enforcement, ownership of the document
- "guidance": advice, examples or patterns not attached to any one rule
- "other": anything else; the reason must say what it is

What matters most:
1. Use only line numbers from {first} to {last}. Ranges include both ends. Rule \
spans and label ranges must not overlap.
2. A line saying "must", "shall" or "required" belongs to a rule unless it plainly \
is not an obligation on a design. If you label it instead, the reason must say why.
3. Never merge two rules. A new heading or a new numbered rule normally starts a \
new rule; each gets its own entry.
4. A section that only describes, defines or introduces holds no rule. Never turn \
a description into a rule to fill a section.
5. When each row of a table is a rule of its own - a catalogue of principles or \
controls with a statement per row - make each row its own rule, and put the \
column line in the first row's span. Otherwise a table belongs whole to one rule \
or one label range.

Reply with JSON only, in this shape:
{{"sections": [{{"line": 5, "depth": 1}}],
  "labels": [{{"from": 0, "to": 4, "label": "furniture",
              "reason": "cover page and revision history"}}],
  "rules": [{{"heading": 6, "from": 6, "to": 14, "statement": [7], "rationale": [8],
             "requirements": [{{"lines": [10], "strength": "must"}},
                              {{"lines": [11, 12], "strength": "should"}}],
             "guidance": [], "references": []}}]}}

<document>
{numbered}
</document>"""

_LINES = {"type": "array", "items": {"type": "integer"}}

_RULES_SCHEMA = {
    "type": "object",
    "properties": {
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"line": {"type": "integer"}, "depth": {"type": "integer"}},
                "required": ["line", "depth"],
                "propertyOrdering": ["line", "depth"],
            },
        },
        "labels": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from": {"type": "integer"},
                    "to": {"type": "integer"},
                    "label": {
                        "type": "string",
                        "enum": [
                            "furniture",
                            "scope",
                            "reference",
                            "process_rule",
                            "guidance",
                            "other",
                        ],
                    },
                    "reason": {"type": "string"},
                },
                "required": ["from", "to", "label", "reason"],
                "propertyOrdering": ["from", "to", "label", "reason"],
            },
        },
        "rules": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "heading": {"type": "integer", "nullable": True},
                    "from": {"type": "integer"},
                    "to": {"type": "integer"},
                    "statement": _LINES,
                    "rationale": _LINES,
                    "requirements": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "lines": _LINES,
                                "strength": {"type": "string", "enum": ["must", "should", "may"]},
                            },
                            "required": ["lines", "strength"],
                            "propertyOrdering": ["lines", "strength"],
                        },
                    },
                    "guidance": _LINES,
                    "references": _LINES,
                },
                "required": [
                    "from",
                    "to",
                    "statement",
                    "rationale",
                    "requirements",
                    "guidance",
                    "references",
                ],
                "propertyOrdering": [
                    "heading",
                    "from",
                    "to",
                    "statement",
                    "rationale",
                    "requirements",
                    "guidance",
                    "references",
                ],
            },
        },
    },
    "required": ["sections", "labels", "rules"],
    "propertyOrdering": ["sections", "labels", "rules"],
}

# A reply names every line of a standard once, so it grows with the document.
# Well inside both providers' output limits, and far above what a part of
# `rules.MAX_LINES_PER_CALL` lines needs.
_RULES_MAX_TOKENS = 32_000


def _rules_temperature(attempt: int) -> float:
    """The first reading is deterministic. The second is the cross-check, so it
    is sampled rather than repeated: at temperature 0 both readings would make
    the same mistakes, and their agreeing would prove nothing."""
    return 0.0 if attempt <= 1 else 0.5


def _rules_prompt(*, document: str, title: str, first: int, last: int, whole: bool) -> str:
    part = (
        ""
        if whole
        else f" (this is one part of it, lines {first} to {last}; the rest is read separately)"
    )
    return _RULES_PROMPT.format(
        title=title.replace('"', "'"),
        part=part,
        first=first,
        last=last,
        numbered=document,
    )


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
        temperature: float | None = None,
        attempts: int = 4,
    ) -> str:
        config: dict = {
            "maxOutputTokens": max_tokens,
            "temperature": temperature if temperature is not None else (0.0 if schema else 0.2),
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
            attempts=attempts,
        )

        # Recorded here rather than in each of the three callers: this is the
        # single point every Gemini request passes through, so there is no way
        # to add a fourth kind of call and forget to account for it.
        prompt_tokens, output_tokens = usage.from_gemini(data)
        usage.record(
            kind="llm",
            provider="gemini",
            model=self.model,
            input_tokens=prompt_tokens,
            output_tokens=output_tokens,
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

    def summarise(self, document_text: str, *, title: str) -> str:
        return self._generate(
            [{"text": _SUMMARY_PROMPT.format(document=document_text[:120_000])}],
            system=f"You are reading the document '{title}'.",
            max_tokens=400,
        )


    def judge(
        self,
        *,
        reference: str,
        clause: str,
        extracts: str,
        precedents: str = "",
        document: str = "",
    ) -> dict:
        text = self._generate(
            [
                {
                    "text": _JUDGE_PROMPT.format(
                        reference=reference,
                        clause=clause,
                        extracts=extracts,
                        precedents=_precedent_block(precedents),
                        document_context=_document_block(document),
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

    def structure(
        self, *, numbered: str, first_line: int, last_line: int, tags: str = ""
    ) -> dict:
        text = self._generate(
            [
                {
                    "text": _STRUCTURE_PROMPT.format(
                        numbered=numbered,
                        first_line=first_line,
                        last_line=last_line,
                        tags=tags,
                    )
                }
            ],
            system=None,
            # Markers are terse, but a dense window can carry a hundred of them.
            max_tokens=4096,
            schema=_STRUCTURE_SCHEMA,
        )
        if not text:
            raise RuntimeError("gemini returned no structure")
        return _parse_json(text)

    def read_rules(
        self, *, document: str, title: str, first: int, last: int, whole: bool, attempt: int
    ) -> str:
        text = self._generate(
            [
                {
                    "text": _rules_prompt(
                        document=document, title=title, first=first, last=last, whole=whole
                    )
                }
            ],
            system=None,
            max_tokens=_RULES_MAX_TOKENS,
            schema=_RULES_SCHEMA,
            temperature=_rules_temperature(attempt),
            # rules.py retries a refused range itself, on smaller pieces. Four
            # transport retries of a three-minute call would outlive the lease.
            attempts=2,
        )
        if not text:
            raise RuntimeError("gemini returned no reading of the rules")
        return text


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

    def _send(self, payload: dict) -> dict:
        """Post, and account for it.

        Every Anthropic request goes through here for the same reason the Gemini
        client records inside `_generate` — so that adding a fifth kind of call
        cannot quietly stop being counted. The model comes off the payload
        rather than `self.model` because `contextualise` uses the fast one.
        """
        data = _post(self.BASE, self._headers(), payload)
        input_tokens, output_tokens = usage.from_anthropic(data)
        usage.record(
            kind="llm",
            provider="anthropic",
            model=str(payload.get("model") or self.model),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
        return data

    @staticmethod
    def _text_of(data: dict) -> str:
        return "".join(
            b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
        ).strip()

    def describe_figure(self, image_png: bytes, *, heading_path: str, caption: str | None) -> str:
        where = f"Location in document: {heading_path}"
        if caption:
            where += f"\nCaption as printed: {caption}"
        data = self._send(
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

        data = self._send(
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

    def summarise(self, document_text: str, *, title: str) -> str:
        data = self._send(
            {
                "model": self.fast_model,
                "max_tokens": 400,
                "system": f"You are reading the document '{title}'.",
                "messages": [
                    {
                        "role": "user",
                        "content": _SUMMARY_PROMPT.format(document=document_text[:180_000]),
                    }
                ],
            },
        )
        return self._text_of(data)

    def judge(
        self,
        *,
        reference: str,
        clause: str,
        extracts: str,
        precedents: str = "",
        document: str = "",
    ) -> dict:
        data = self._send(
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
                            document_context=_document_block(document),
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

    def structure(
        self, *, numbered: str, first_line: int, last_line: int, tags: str = ""
    ) -> dict:
        data = self._send(
            {
                "model": self.model,
                "max_tokens": 4096,
                "temperature": 0,
                "messages": [
                    {
                        "role": "user",
                        "content": _STRUCTURE_PROMPT.format(
                            numbered=numbered,
                            first_line=first_line,
                            last_line=last_line,
                            tags=tags,
                        ),
                    },
                    {"role": "assistant", "content": "{"},
                ],
            },
        )
        return _parse_json("{" + self._text_of(data))

    def read_rules(
        self, *, document: str, title: str, first: int, last: int, whole: bool, attempt: int
    ) -> str:
        payload = {
            "model": self.model,
            "max_tokens": _RULES_MAX_TOKENS,
            "temperature": _rules_temperature(attempt),
            "messages": [
                {
                    "role": "user",
                    "content": _rules_prompt(
                        document=document, title=title, first=first, last=last, whole=whole
                    ),
                },
                {"role": "assistant", "content": "{"},
            ],
        }
        data = _post(self.BASE, self._headers(), payload, attempts=2)
        input_tokens, output_tokens = usage.from_anthropic(data)
        usage.record(
            kind="llm",
            provider="anthropic",
            model=self.model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
        text = self._text_of(data)
        if not text:
            raise RuntimeError("claude returned no reading of the rules")
        return "{" + text


def _strict_schema(schema: dict) -> dict:
    """A Gemini response schema, rewritten as strict JSON Schema.

    The schemas above are written for Gemini. OpenAI's strict mode — which is
    what makes a reply conform rather than merely try to — wants every object
    closed with `additionalProperties: false` and every property listed as
    required, spells an optional value as a union with null instead of
    `nullable`, and rejects `propertyOrdering`. One source of truth for the
    shape, converted, rather than two copies that drift.
    """

    def convert(node, *, is_properties: bool = False):
        if isinstance(node, list):
            return [convert(item) for item in node]
        if not isinstance(node, dict):
            return node
        if is_properties:
            # Property names, not schema keywords: a field called "type" is a field.
            return {name: convert(value) for name, value in node.items()}
        out = {
            key: convert(value, is_properties=key == "properties")
            for key, value in node.items()
            if key not in ("propertyOrdering", "nullable")
        }
        if node.get("nullable") and "type" in out:
            kind = out["type"]
            out["type"] = [*kind, "null"] if isinstance(kind, list) else [kind, "null"]
        if out.get("type") == "object" and isinstance(out.get("properties"), dict):
            out["additionalProperties"] = False
            out["required"] = list(out["properties"])
        return out

    return convert(schema)


class OpenRouterLLM:
    """Models reached through OpenRouter's OpenAI-compatible API.

    Two things go with every request, because these are client documents:
    `data_collection: deny`, so no host that trains on prompts is ever chosen,
    and `only`, so the request is served by the model's own vendor rather than
    whichever host is cheapest that minute.

    Prompt caching on OpenAI's models is automatic for a repeated prefix, which
    is why `contextualise` puts the document first and the chunk last: every
    preamble in a document reuses the same leading tokens at a fraction of the
    price.
    """

    URL = "https://openrouter.ai/api/v1/chat/completions"

    def __init__(
        self,
        api_key: str,
        model: str,
        fast_model: str,
        *,
        providers: tuple[str, ...] = (),
        zdr: bool = False,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.fast_model = fast_model
        self.providers = tuple(providers)
        self.zdr = zdr

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "X-Title": "AIDP",
        }

    def _chat(
        self,
        messages: list[dict],
        *,
        max_tokens: int,
        model: str | None = None,
        temperature: float = 0.0,
        schema: dict | None = None,
        name: str = "reply",
        attempts: int = 4,
    ) -> str:
        chosen = model or self.model
        provider: dict = {"data_collection": "deny"}
        if self.providers:
            provider["only"] = list(self.providers)
        if self.zdr:
            provider["zdr"] = True
        payload: dict = {
            "model": chosen,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "provider": provider,
        }
        if schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": name, "strict": True, "schema": _strict_schema(schema)},
            }
            # Never route a schema request to a host that would ignore the schema.
            provider["require_parameters"] = True

        data = _post(self.URL, self._headers(), payload, attempts=attempts)
        if isinstance(data.get("error"), dict):
            raise RuntimeError(f"openrouter refused the request: {str(data['error'])[:200]}")

        input_tokens, output_tokens = usage.from_openai(data)
        usage.record(
            kind="llm",
            provider="openrouter",
            model=chosen,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

        choices = data.get("choices") or []
        if not choices:
            logs.warn(log, "openrouter returned no choices", model=chosen)
            return ""
        if choices[0].get("finish_reason") == "length":
            # Not raised: the caller's parse fails on a cut-off reply and its
            # own retry decides what to do. Logged so the cause is findable.
            logs.warn(log, "reply cut off at the output limit", model=chosen)
        content = (choices[0].get("message") or {}).get("content") or ""
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
        return str(content).strip()

    def describe_figure(self, image_png: bytes, *, heading_path: str, caption: str | None) -> str:
        where = f"Location in document: {heading_path}"
        if caption:
            where += f"\nCaption as printed: {caption}"
        text = self._chat(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": f"{where}\n\n{_FIGURE_PROMPT}"},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "data:image/png;base64,"
                                + base64.b64encode(image_png).decode()
                            },
                        },
                    ],
                }
            ],
            max_tokens=1200,
            temperature=0.2,
        )
        return "" if text.strip() == "NO_INFORMATION" else text

    def contextualise(self, document_text: str, chunk_text: str, *, title: str) -> str:
        return self._chat(
            [
                {
                    "role": "system",
                    "content": (
                        f"You are indexing the document '{title}'.\n\n"
                        f"<document>\n{document_text[:120_000]}\n</document>"
                    ),
                },
                {"role": "user", "content": _CONTEXT_PROMPT.format(chunk=chunk_text[:6000])},
            ],
            model=self.fast_model,
            max_tokens=200,
            temperature=0.2,
        )

    def summarise(self, document_text: str, *, title: str) -> str:
        # The main model, not the fast one: one call per document, and every
        # verdict on that document is reached with this paragraph in view.
        return self._chat(
            [
                {"role": "system", "content": f"You are reading the document '{title}'."},
                {
                    "role": "user",
                    "content": _SUMMARY_PROMPT.format(document=document_text[:200_000]),
                },
            ],
            max_tokens=400,
            temperature=0.2,
        )

    def judge(
        self,
        *,
        reference: str,
        clause: str,
        extracts: str,
        precedents: str = "",
        document: str = "",
    ) -> dict:
        text = self._chat(
            [
                {
                    "role": "user",
                    "content": _JUDGE_PROMPT.format(
                        reference=reference,
                        clause=clause,
                        extracts=extracts,
                        precedents=_precedent_block(precedents),
                        document_context=_document_block(document),
                    ),
                }
            ],
            max_tokens=1024,
            schema=_VERDICT_SCHEMA,
            name="verdict",
        )
        if not text:
            raise RuntimeError("openrouter returned an empty verdict")
        return _parse_json(text)

    def structure(
        self, *, numbered: str, first_line: int, last_line: int, tags: str = ""
    ) -> dict:
        text = self._chat(
            [
                {
                    "role": "user",
                    "content": _STRUCTURE_PROMPT.format(
                        numbered=numbered,
                        first_line=first_line,
                        last_line=last_line,
                        tags=tags,
                    ),
                }
            ],
            max_tokens=4096,
            schema=_STRUCTURE_SCHEMA,
            name="structure",
        )
        if not text:
            raise RuntimeError("openrouter returned no structure")
        return _parse_json(text)

    def read_rules(
        self, *, document: str, title: str, first: int, last: int, whole: bool, attempt: int
    ) -> str:
        text = self._chat(
            [
                {
                    "role": "user",
                    "content": _rules_prompt(
                        document=document, title=title, first=first, last=last, whole=whole
                    ),
                }
            ],
            max_tokens=_RULES_MAX_TOKENS,
            temperature=_rules_temperature(attempt),
            schema=_RULES_SCHEMA,
            name="rules",
            # rules.py retries a refused range itself, on smaller pieces.
            attempts=2,
        )
        if not text:
            raise RuntimeError("openrouter returned no reading of the rules")
        return text


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
    provider = cfg.llm_provider.lower()
    if provider == "openrouter":
        return bool(cfg.openrouter_api_key)
    if provider == "anthropic":
        return bool(cfg.anthropic_api_key)
    return bool(cfg.gemini_api_key)


def client() -> LLM:
    global _client
    if _client is None:
        cfg = get_config()
        provider = cfg.llm_provider.lower()
        if provider == "openrouter":
            if not cfg.openrouter_api_key:
                raise RuntimeError("OPENROUTER_API_KEY is not set")
            _client = OpenRouterLLM(
                cfg.openrouter_api_key,
                cfg.openrouter_model,
                cfg.openrouter_fast_model,
                providers=cfg.openrouter_providers,
                zdr=cfg.openrouter_zdr,
            )
        elif provider == "anthropic":
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


def structure(*, numbered: str, first_line: int, last_line: int, tags: str = "") -> dict:
    return client().structure(
        numbered=numbered, first_line=first_line, last_line=last_line, tags=tags
    )


def read_rules(
    *, document: str, title: str, first: int, last: int, whole: bool, attempt: int
) -> str:
    """The raw reply, unparsed — rules.py stores it whether or not it is believed."""
    return client().read_rules(
        document=document, title=title, first=first, last=last, whole=whole, attempt=attempt
    )


def parse_json(raw: str) -> dict:
    """`_parse_json`, for a caller that keeps the raw reply as well as the parse."""
    return _parse_json(raw)


def model_name() -> tuple[str, str]:
    """(provider, model) as configured — recorded against a run and a reading."""
    cfg = get_config()
    provider = cfg.llm_provider.lower()
    if provider == "openrouter":
        return "openrouter", cfg.openrouter_model
    if provider == "anthropic":
        return "anthropic", cfg.claude_model
    return "gemini", cfg.gemini_model


def judge(
    *,
    reference: str,
    clause: str,
    extracts: str,
    precedents: str = "",
    document: str = "",
) -> dict:
    # `document` has to be passed through here. Without it the analyse stage's
    # `document=` raised TypeError on every clause, which its per-clause guard
    # caught — so every clause of every run failed, quietly.
    return client().judge(
        reference=reference,
        clause=clause,
        extracts=extracts,
        precedents=precedents,
        document=document,
    )


def summarise(document_text: str, *, title: str) -> str:
    """One sentence-or-four on what a document is for. Empty when it cannot.

    Never raises. A document with no summary is assessed exactly as it was
    before this existed — the judge simply goes without — and failing a whole
    ingest because one summarisation call timed out would be the worse trade.
    """
    if not available():
        return ""
    try:
        return client().summarise(document_text, title=title).strip()
    except Exception as exc:  # noqa: BLE001 — deliberate degrade-not-fail
        logs.warn(log, "summary unavailable, continuing without", error=str(exc)[:200])
        return ""


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
