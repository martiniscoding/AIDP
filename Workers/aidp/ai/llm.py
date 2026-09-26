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

# Sent with every OpenRouter request. The value is arbitrary; holding it still is
# the point, so that two runs of the same assessment differ as little as the
# provider allows.
_SEED = 7

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
standard. Decide whether the design satisfies the clause.

The extracts below are not a sample of the document. They are the passages a search \
of the WHOLE submitted document ranked closest to this clause, by meaning and by \
keyword together, with every rule, table row, figure description and section of it \
searched separately. If the design addressed this clause, its words would almost \
certainly be among them.
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
- "absent"       — the extracts are about other subjects; the design does not
                   engage with this clause at all
- "needs_review" — the extracts are on the subject, but their wording is genuinely
                   ambiguous, so a person has to read them

Rules that matter:

1. "covered", "partial" and "contradicts" MUST cite at least one extract id. A
   claim about a document that cites nothing in it is invented.
2. Decide. "The extracts do not explicitly confirm X" is not a reason to answer
   "needs_review" — that is what "partial" means. Keep "needs_review" for wording
   two careful readers could read two different ways, never for your own
   uncertainty about the rest of the document.
3. "absent" is for a clause whose mechanism the extracts never engage. Engaging the
   subject area is not engaging the mechanism: storing data is not a retention
   schedule, keeping logs is not a disposal process, and naming the clause as an
   open item still to be decided is "absent". Where the extracts do engage the
   mechanism and leave part of it unmet, that is "partial", and the rationale must
   name what is missing. Anything you call absent is read again against the whole
   document before it reaches a report.
3a. A breach is never "partial". If the extracts show the design doing something the
   clause forbids, or refusing something it requires, the verdict is "contradicts" —
   whatever else in the clause is met, and however the design excuses it. If your
   rationale says the design violates, breaches or conflicts with a requirement,
   answer "contradicts". Explicitly discarding, dropping or bypassing required data,
   messages or controls is such a breach: dropping failed messages after retries
   where dead-lettering or durability is required, deleting inside a retention
   period, routing around an approved gateway, or skipping a required check is
   "contradicts". Silent omission of a secondary detail is "partial"; choosing not
   to do what the clause requires is not silence.
3b. Equally, do not withhold "covered" over detail the clause does not ask for. To
   answer "partial" you must be able to name a requirement of this clause that is
   unmet; if you cannot, and the extracts meet what it asks, the verdict is
   "covered".
4. Judge only what the clause requires. Do not reward the design for good
   practice the clause does not ask for.
5. confidence is your own certainty in the verdict, 0 to 1.
6. Standing decisions, where any are given, are this organisation's own settled
   rulings and outrank your general judgement about what good practice looks
   like. If one resolves the clause, follow it and list its id in
   appliedDecisions. Never list an id you were not given. A decision marked
   "on a related clause" is guidance, not a ruling — it can inform a verdict but
   cannot settle one on its own.
7. rationale is ONE sentence, under 220 characters, giving the decisive fact or
   the requirement left unmet. Start with the substance. No throat-clearing:
   never open with "The extracts show", "Based on the extracts", "It appears
   that" or "This clause".
8. For "contradicts", "partial" and "absent" the rationale must also say what
   would satisfy the clause, in concrete technical terms — the mechanism,
   setting or control needed, not "address the requirement". Two short
   sentences are allowed here, still within 280 characters: what is wrong, then
   what is needed. "No retention period is stated; set a 7-year retention
   policy on the audit log store" — not "retention is not addressed".
9. Build that fix out of what the design already has. Name the components,
   services, protocols and stores the extracts themselves name, and extend
   them: if the design runs Kafka, the fix is a Kafka topic, not "a message
   broker"; if it names an Oracle billing database, say so. Do not introduce a
   product the document never mentions, and never name a vendor or tool the
   design does not already use. Where the design names nothing that could carry
   the fix, say what capability is missing instead of inventing a product.

Reply with JSON only, no prose around it:
{{"verdict": "...", "confidence": 0.0, "rationale": "one sentence under 220 chars; add the concrete fix when not covered, 280 max",
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
    def judge_document(
        self, *, document: str, reference: str, clause: str, precedents: str = ""
    ) -> dict: ...
    def find_uncovered(self, *, design: str, standards: str, title: str) -> dict: ...
    def suggest_improvements(self, *, design: str, findings: str, title: str) -> dict: ...
    def find_technologies(self, *, design: str, products: str, title: str) -> dict: ...
    def confirm_absent(self, *, document: str, clauses: str) -> dict: ...


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


_DOCUMENT_JUDGE_SYSTEM = """\
You are auditing a submitted design document against an enterprise standard, one \
clause at a time. The complete design document is below, page by page, exactly as it \
was read from the file. In a slide deck a page is a slide; in a workbook it is a sheet.

{document}

For each clause you are given, decide whether this design satisfies it, using only the \
document above.

Choose exactly one verdict:
- "covered"      - the document addresses every requirement in the clause
- "partial"      - it addresses the clause but leaves at least one requirement unmet
- "contradicts"  - it states something the clause forbids, or forbids something the
                   clause requires
- "absent"       - nothing in the document addresses this clause
- "needs_review" - you cannot tell: the document touches the subject but is
                   ambiguous, or the only support is a figure description

Rules that matter more than being decisive:

1. Evidence is quotations copied exactly, character for character, from the document \
text above, each with the page it is on. Never paraphrase, never join words from two \
places into one quote, and never quote a figure description or these instructions. \
Every quote is checked against the document, and a quote that is not there word for \
word throws the verdict out.
2. "covered", "partial" and "contradicts" MUST give at least one quote: the passage \
that decides it, a full sentence or table row where there is one.
3. "covered" means every requirement of the clause is met, so give a quote for each \
one. A requirement with no passage that meets it makes the verdict "partial", and the \
rationale must name it. A general statement ("data is encrypted") does not meet a \
specific requirement ("TLS 1.2 or higher").
3a. But judge the clause as written, not an ideal version of it. Where the design \
commits to the mechanism or policy the clause asks for, covering what is in scope for \
this system, that is "covered". Do not downgrade to "partial" over detail the clause \
never demanded, over an object type the design has no instance of, or because the \
document does not restate a requirement it plainly satisfies. "Partial" names a \
requirement of THIS clause that is unmet; if you cannot quote that requirement, the \
verdict is not "partial".
4. A quote must bear on what the clause requires. A passage about a neighbouring \
subject is not partial compliance: authentication quoted for an encryption clause, or \
logging quoted for an access-control clause, meets none of it. If nothing in the \
document addresses any requirement of the clause itself, the verdict is "absent" or \
"needs_review", not "partial".
5. Choose "absent" when the document is silent on the mechanism the clause requires. \
Silence on the mechanism is what counts, not silence on the subject area: a design \
that stores data, keeps logs or takes backups has not thereby addressed a retention, \
archival or disposal schedule, and one that names a database has not thereby \
addressed ownership. Naming a neighbouring topic, or listing the clause as an open \
item still to be decided, is "absent". Reserve "partial" for a design that does \
engage the mechanism and leaves part of it unmet.
6. "contradicts" comes first, and it is never softened to "partial". A breach of ANY \
prohibition or mandatory requirement in the clause is "contradicts", however many of \
the clause's other requirements the design meets, and however the document excuses it — \
temporary, agreed, carried over, or justified by a private network or a team's view. \
These clauses list several requirements each; breaching one is breaching the clause. \
Check yourself before you answer: if your rationale says the design violates, \
breaches, conflicts with, is prohibited by, or does not meet a requirement, then the \
verdict is "contradicts" and not "partial".
6a. Explicitly discarding, dropping or bypassing required data, messages or controls \
is an active breach, and an active breach is "contradicts". Dropping failed messages \
after retries where dead-lettering or durability is required, deleting records inside \
a retention period, routing around an approved gateway, disabling or skipping a \
required check — each states an action the clause forbids, however the design \
justifies it. Silent omission of a secondary detail is "partial"; choosing not to do \
what the clause requires is not silence.
7. Judge only what the clause requires. Do not reward the design for good practice the \
clause does not ask for.
8. Standing decisions, where any are given, are this organisation's own settled \
rulings and outrank your general judgement. If one resolves the clause, follow it and \
list its id in appliedDecisions. Never list an id you were not given. A decision \
marked "on a related clause" can inform a verdict but cannot settle one on its own.
9. confidence is your own certainty in the verdict, 0 to 1.
10. "rationale" is ONE sentence, under 220 characters, giving the decisive fact or the \
requirement left unmet. Start with the substance. No throat-clearing: never open with \
"The document states", "Based on the extracts", "It appears that" or "This clause".
11. For "contradicts", "partial" and "absent" the rationale must also say what would \
satisfy the clause, in concrete technical terms — the mechanism, setting or control \
needed, never "address the requirement". Two short sentences are allowed here, still \
within 280 characters: what is wrong, then what is needed. "No retention period is \
stated; set a 7-year retention policy on the audit log store" — not "retention is not \
addressed".
12. Build that fix out of what the design already has. Name the components, services, \
protocols and stores the document itself names, and extend them: if it runs Kafka the \
fix is a Kafka topic, not "a message broker"; if it names an Oracle billing database, \
say so. Never introduce a product or vendor the document does not mention. Where it \
names nothing that could carry the fix, say what capability is missing instead of \
inventing a product.

Reply with JSON only, no prose around it:
{{"verdict": "...", "confidence": 0.0, "rationale": "one sentence under 220 chars; add the concrete fix when not covered, 280 max",
  "evidence": [{{"quote": "exact words from the document", "page": 12}}],
  "appliedDecisions": ["decision id", ...]}}"""

_DOCUMENT_JUDGE_CLAUSE = """\
<standard_clause>
Reference: {reference}
{clause}
</standard_clause>
{precedents}
Give your verdict on this clause for the design document."""

_DOCUMENT_VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {
            "type": "string",
            "enum": ["covered", "partial", "absent", "contradicts", "needs_review"],
        },
        "confidence": {"type": "number"},
        "rationale": {"type": "string"},
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "quote": {"type": "string"},
                    "page": {"type": "integer", "nullable": True},
                },
                "required": ["quote", "page"],
                "propertyOrdering": ["quote", "page"],
            },
        },
        "appliedDecisions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["verdict", "confidence", "rationale", "evidence", "appliedDecisions"],
    "propertyOrdering": ["verdict", "confidence", "rationale", "evidence", "appliedDecisions"],
}


_COVERAGE_SYSTEM = """\
You are reviewing a submitted design document for an organisation that governs its \
designs with a library of standards. Every clause in that library is listed below, \
followed by the design document section by section, exactly as it was read from the \
file. In a slide deck a section is usually a slide.

<standard_clauses>
{standards}
</standard_clauses>

<design_document title="{title}">
{design}
</design_document>

Your task is the reverse of an assessment. Do not judge whether the design meets the \
clauses. Find the parts of the design that none of the clauses governs at all - \
things the design builds, integrates, stores, processes or operates that no clause \
constrains in any way - and say which standards the organisation would need to add \
so that those parts are governed too.

GAPS. For each section of the design that describes something no clause governs:
- "section": its number, from the "=== S<number>" line that starts it
- "what": what the design does there, in ONE sentence of at most 180 characters,
  in the design's own terms
- "quote": one sentence or table row copied exactly, character for character, from \
that section, showing what it describes. Never paraphrase, never join words from two \
places, never quote these instructions or a clause.
- "page": the page the quote is on

SUGGESTIONS. The standards the organisation should add to govern those gaps. For each:
- "title": the name of the standard, at most 10 words
- "covers": what it should govern, at most 40 words and 280 characters, named as
  concrete architectural additions to the components this design already has
- "why": the part of this design that shows it is needed, one sentence of at most
  200 characters
- "sections": the numbers of the gap sections it would govern

In "what", "covers" and "why", describe the parts of the design by what they do - \
"the storefront caches card numbers" - never by section number: a reader sees the \
design's own headings, not the numbers above.

Rules that matter:
1. A section is governed when any clause constrains what it describes, even loosely \
or only in part. Report a section only when no clause applies to it at all. A clause \
on data classification governs a section that stores customer data; a clause on \
authentication governs a section about signing in. When in doubt, it is governed.
2. Only sections describing the system itself count - what it builds, stores, moves, \
exposes, integrates, runs or retains. Never report how the work is organised or sold: \
front matter, revision history, contents, agendas, team or company introductions, \
team structure, ways of working, RACI charts, delivery plans, sprint or phase \
timelines, effort or duration estimates, commercial terms, pricing, assumptions, \
glossaries or closing slides. A section whose subject is people, schedule or money is \
never a gap, however little the clauses say about it.
3. Use only section numbers that appear above. Every quote is checked against the \
document, and a gap whose quote is not in that section word for word is thrown out.
4. Suggest standards an enterprise architecture, security or data team would own - \
for example "Payment card data handling" or "Third-party carrier integrations" - each \
general enough to govern future designs, not only this one. Do not cite external \
frameworks by clause number.
5. Group related gaps under one suggestion, and put every gap in some suggestion's \
sections.
6. If every part of the design is governed, return empty lists. That is a correct and \
expected answer.
7. Say something a reader could act on. "what", "covers" and "why" name the design's \
own components, stores, interfaces and flows and what should govern them — not the \
fact that governance is absent. These words are banned outright: "consider", \
"ensure proper", "review and update", "where appropriate", "as appropriate", "follow \
best practices", "align with stakeholders". A sentence that would fit any design at \
all is not worth returning.

Reply with JSON only:
{{"gaps": [{{"section": 12, "what": "...", "quote": "...", "page": 31}}],
  "suggestions": [{{"title": "...", "covers": "...", "why": "...", "sections": [12]}}]}}"""

_COVERAGE_USER = (
    "List the parts of this design that no clause governs, and the standards that would "
    "govern them."
)

_COVERAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "gaps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "section": {"type": "integer"},
                    "what": {"type": "string"},
                    "quote": {"type": "string"},
                    "page": {"type": "integer", "nullable": True},
                },
                "required": ["section", "what", "quote", "page"],
                "propertyOrdering": ["section", "what", "quote", "page"],
            },
        },
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "covers": {"type": "string"},
                    "why": {"type": "string"},
                    "sections": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["title", "covers", "why", "sections"],
                "propertyOrdering": ["title", "covers", "why", "sections"],
            },
        },
    },
    "required": ["gaps", "suggestions"],
    "propertyOrdering": ["gaps", "suggestions"],
}

# A long design can have many ungoverned sections, each with a quote.
_COVERAGE_MAX_TOKENS = 8192

# Improvements to a design, after it has been assessed. See Workers/aidp/advice.py:
# every section number and quote in the reply is checked before anything is kept.
_ADVICE_SYSTEM = """\
You are a senior solution architect reviewing the design document "{title}" before \
it is built. It has already been assessed clause by clause against the \
organisation's own standards, and those results are reported separately. Your task \
is different: find the improvements an experienced architect would still ask for in \
this design's own architecture — its components, technologies, integrations, data \
flows, environments and delivery.

The design is below, section by section. Each section starts with a line like \
"=== S12: 3.4 Backup (page 40) ===". Refer to a section only by that number.

<design>
{design}
</design>

Already reported against the standards. Do not suggest these again:

<findings>
{findings}
</findings>

Review the design the way a design review board would, for example:
- single points of failure, high availability, backup and disaster recovery for the \
components it names
- failure handling between its components and with external systems: timeouts, \
bounded retries, dead-letter queues, idempotency, back-pressure
- security of each interface and environment it describes: service-to-service \
authentication, secrets, network exposure, least privilege
- data: consistency between stores, replication, migration, residency, caching and \
invalidation
- scalability and performance under the load the design implies
- observability of the flows it describes: logs, metrics, tracing, alerting
- deployment, environments, testing and release safety
- technology choices: lock-in, fit, and components whose support status should be \
confirmed
- cost

Rules that matter more than finding many suggestions:

1. Every suggestion is about a named part of this design. "component" is the \
component, technology, interface or flow it concerns, copied exactly as the design \
names it (for example "RabbitMQ" or "API Gateway"), and it must appear in the \
section you give. Give one name, not a list, and never a label made by combining \
names. A suggestion that cannot be tied to something the design names is general \
advice, and is not wanted.
1a. Build every suggestion on the passage you quote, naming three things in at most \
two sentences: (a) the existing component or flow being extended, in the design's own \
words; (b) the exact parameter, mechanism or protocol to add or change; and (c) the \
runtime state that results — what is then true when the system runs. Extend the \
stack the design already has rather than replacing it: propose a product it does not \
already name only when nothing it names could do the job, and say why.
2. "recommendation" is one concrete engineering change to that component, at most \
two crisp sentences and 280 characters. Name the mechanism, parameter, protocol or \
failure mode, and the target state: not "add retries" but "bound the Orders API \
retry to 3 attempts with exponential backoff and a 30s dead-letter queue". Advice \
that would fit any design is not a suggestion, and these words are banned outright: \
"consider", "ensure proper", "review and update", "confirm support status", "where \
appropriate", "best practices". If you cannot name the mechanism and the target \
state, omit the suggestion.
3. Never repeat anything listed as already reported, even in other words. A \
suggestion may go further than a finding — a concrete change to a named component \
that would also resolve it — and then "clauses" gives that finding's reference, the \
text inside its square brackets, without the brackets. Otherwise "clauses" is empty.
4. "section" is the number of the section where the component is described.
5. "kind" is "improve" when the design states something that should change: quote \
the design's own words that state it, copied exactly — a whole sentence, table row \
or line, not a fragment of one — with its page. "kind" is "add" when something the \
design needs is missing: quote the passage that describes the component if there is \
one, otherwise leave "quote" empty and "page" null. A passage you cannot copy exactly \
— a table you would have to reassemble, say — is left unquoted, never reworded.
6. Every quote and component is checked word for word against the design, inside \
the section you name. One that is not there throws the suggestion out. Never \
paraphrase, never join words from separate places, and never quote these \
instructions or the findings.
7. "priority" is "high" for a risk of a security breach, data loss, an outage or a \
regulatory failure; "medium" for a real weakness that can be lived with for a \
while; "low" for worthwhile polish.
7a. Two kinds of suggestion are always "high", and they come first in the list. \
The first is a concrete change to a component a reported finding says contradicts a \
standard — the design is breaching a rule today, and the fix is the most valuable \
thing you can offer. The second is anything that loses data or takes the system down: \
messages dropped or discarded rather than dead-lettered, unencrypted transport, state \
held in one process's memory, a single instance or store with no standby, a \
dependency with no timeout or fallback. Rank these above polish however tidy the rest \
of the design is, and remember rule 3: a suggestion that only restates a finding is \
still not wanted — go further, and name the change.
8. "category" is one of: security, resilience, data, integration, operations, \
performance, cost, maintainability, documentation.
9. You cannot check today's date, release notes or security advisories. Never state \
that a product or version is out of support, end of life, deprecated or vulnerable, \
and never suggest confirming a support status or planning an upgrade path — that is \
checked elsewhere and is not a suggestion. Say nothing about versions or support \
unless the design itself states a version constraint, and then address only what it \
states.
10. "why" is a single sentence, at most 200 characters, naming the concrete failure \
mode or operational risk this avoids for this design — the outage, breach, data loss \
or cost it prevents. Never a restatement of the recommendation.
11. At most 15 suggestions, the most important first. Fewer is fine, and a sound \
design may need few.
"""

_ADVICE_USER = "Suggest improvements to this design."

_ADVICE_SCHEMA = {
    "type": "object",
    "properties": {
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "kind": {"type": "string", "enum": ["improve", "add"]},
                    "category": {
                        "type": "string",
                        "enum": [
                            "security",
                            "resilience",
                            "data",
                            "integration",
                            "operations",
                            "performance",
                            "cost",
                            "maintainability",
                            "documentation",
                        ],
                    },
                    "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                    "section": {"type": "integer"},
                    "component": {"type": "string"},
                    "quote": {"type": "string"},
                    "page": {"type": "integer", "nullable": True},
                    "recommendation": {"type": "string"},
                    "why": {"type": "string"},
                    "clauses": {"type": "array", "items": {"type": "string"}},
                },
                "required": [
                    "title",
                    "kind",
                    "category",
                    "priority",
                    "section",
                    "component",
                    "quote",
                    "page",
                    "recommendation",
                    "why",
                    "clauses",
                ],
                "propertyOrdering": [
                    "title",
                    "kind",
                    "category",
                    "priority",
                    "section",
                    "component",
                    "quote",
                    "page",
                    "recommendation",
                    "why",
                    "clauses",
                ],
            },
        },
    },
    "required": ["suggestions"],
    "propertyOrdering": ["suggestions"],
}

_ADVICE_MAX_TOKENS = 8192


def _advice_system(*, design: str, findings: str, title: str) -> str:
    return _ADVICE_SYSTEM.format(design=design, findings=findings, title=title.replace('"', "'"))


def advice_prompt_identity() -> str:
    """Everything about the suggestions request that is not the design itself.

    Part of the cache key for suggested improvements (see advice.py), so that
    editing the instructions, the schema or the reply budget retires every
    stored answer the old wording produced — without anyone having to remember
    to bump a version number.
    """
    return "\x00".join(
        (
            _ADVICE_SYSTEM,
            _ADVICE_USER,
            json.dumps(_ADVICE_SCHEMA, sort_keys=True),
            str(_ADVICE_MAX_TOKENS),
        )
    )


# The technologies a design uses, for the support check. See Workers/aidp/lifecycle.py:
# every product id is checked against endoflife.date's own list, and every quote
# against the design, before anything is looked up.
_LIFECYCLE_SYSTEM = """\
You are reading the design document "{title}" to list the technologies it uses, \
so that whether each one is still supported can be looked up afterwards. You do \
not look anything up and you do not judge the design.

The design is below, section by section. Each section starts with a line like \
"=== S12: 3.4 Backup (page 40) ===". Refer to a section only by that number.

<design>
{design}
</design>

The products whose support dates can be looked up, one per line as \
"id — name (also: other names)":

<products>
{products}
</products>

List every technology this design uses or proposes to use: programming languages \
and runtimes, frameworks and libraries, databases and caches, message brokers, \
application and web servers, operating systems, container and cloud platforms, \
and delivery tools.

Rules:
1. "name" is the technology exactly as the design names it.
2. "product" is the id from the list above that is this technology, copied \
exactly, or "" when none of them is. Never invent an id and never choose a merely \
similar product: a managed service is only its open-source namesake when the list \
says so, and one vendor's product is not another's.
3. "version" is the version the design states for this technology, copied \
exactly as written (for example "11", "2.7.3", "1.8"), or "" when it states none. \
Never guess a version, never take one from a different technology, and never give \
a range or "latest" as a version.
4. "section" is the number of the section that names the technology with that \
version.
5. "quote" is the design's own words naming the technology, with its version when \
there is one, copied exactly: a whole sentence, table row or line. It is checked \
word for word against that section, and one that is not there throws the \
technology out. Never join words from separate places.
6. One entry per technology and version: the same technology at two versions is \
two entries, and the same one named twice is one. Leave out technologies the \
design mentions only to reject them or to compare against.
7. At most 60 entries.
8. Every field is a fact copied from the design, never a judgement and never \
prose. Do not explain, qualify or recommend anything: no "consider upgrading", no \
"confirm support status", no note on whether a version is current or wise. Whether \
a technology is still supported is looked up from its dates afterwards, and a \
sentence of opinion here would be shown to a reviewer as though it were one of \
those facts.
"""

_LIFECYCLE_USER = "List the technologies this design uses."

_LIFECYCLE_SCHEMA = {
    "type": "object",
    "properties": {
        "technologies": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "product": {"type": "string"},
                    "version": {"type": "string"},
                    "section": {"type": "integer"},
                    "quote": {"type": "string"},
                    "page": {"type": "integer", "nullable": True},
                },
                "required": ["name", "product", "version", "section", "quote", "page"],
                "propertyOrdering": ["name", "product", "version", "section", "quote", "page"],
            },
        },
    },
    "required": ["technologies"],
    "propertyOrdering": ["technologies"],
}

_LIFECYCLE_MAX_TOKENS = 8192


def _lifecycle_system(*, design: str, products: str, title: str) -> str:
    return _LIFECYCLE_SYSTEM.format(
        design=design, products=products, title=title.replace('"', "'")
    )


def lifecycle_prompt_identity() -> str:
    """Everything about the technologies request except the design and the list.

    Part of the cache key for a design's technologies (see lifecycle.py), so a
    reworded prompt retires every reading the old wording produced.
    """
    return "\x00".join(
        (
            _LIFECYCLE_SYSTEM,
            _LIFECYCLE_USER,
            json.dumps(_LIFECYCLE_SCHEMA, sort_keys=True),
            str(_LIFECYCLE_MAX_TOKENS),
        )
    )


def _coverage_system(*, design: str, standards: str, title: str) -> str:
    return _COVERAGE_SYSTEM.format(
        standards=standards, design=design, title=title.replace('"', "'")
    )


_CONFIRM_SYSTEM = """\
A search of a submitted design document found nothing for the clauses in the next \
message, and each was recorded as "absent" — the design does not address it at all. \
Before that reaches a report, check it against the whole document, which is below, \
page by page, exactly as it was read from the file. In a slide deck a page is a \
slide; in a workbook it is a sheet.

{document}

For each clause you are given, answer with one verdict:

- "absent"       - nothing in the document addresses it. The search was right.
- "partial"      - the document addresses it but leaves a requirement unmet
- "covered"      - the document addresses every requirement of the clause
- "contradicts"  - the document states something the clause forbids, or forbids
                   something it requires
- "needs_review" - the document touches the subject but is genuinely ambiguous

Rules that matter:

1. Any verdict other than "absent" MUST quote the document: words copied exactly, \
character for character, from the text above, with the page they are on. Every quote \
is checked against the document, and one that is not there word for word is thrown \
away — the clause then stays "absent". Never paraphrase, never join words from two \
places, and never quote these instructions. A figure description may be quoted where \
the design states something only in a diagram; it is a model's reading of an image, so \
it supports "partial" or "needs_review", never "covered" on its own.
2. "absent" needs no quote. Leave the quote empty and say in one sentence what you \
looked for.
3. Weigh both answers evenly. A search miss and a genuine silence are equally \
likely here, so change the verdict whenever an exact quote — from any page, a table \
row, or a diagram description — shows the design engages with what the clause \
requires: "covered" when it meets every requirement, "partial" when it engages but \
leaves one unmet. Keep "absent" only where the document is genuinely silent on what \
the clause requires. A passage about a neighbouring subject is not engagement: \
authentication does not answer an encryption clause.

Reply with JSON only:
{{"clauses": [{{"clause": 1, "verdict": "absent", "quote": "", "page": null,
               "rationale": "one sentence"}}]}}"""

_CONFIRM_USER = "Check these clauses against the document:\n\n{clauses}"

_CONFIRM_SCHEMA = {
    "type": "object",
    "properties": {
        "clauses": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "clause": {"type": "integer"},
                    "verdict": {
                        "type": "string",
                        "enum": ["absent", "partial", "covered", "contradicts", "needs_review"],
                    },
                    "quote": {"type": "string"},
                    "page": {"type": "integer", "nullable": True},
                    "rationale": {"type": "string"},
                },
                "required": ["clause", "verdict", "quote", "page", "rationale"],
                "propertyOrdering": ["clause", "verdict", "quote", "page", "rationale"],
            },
        }
    },
    "required": ["clauses"],
    "propertyOrdering": ["clauses"],
}

# One reply carries a verdict, a quote and a sentence for every clause asked about.
_CONFIRM_MAX_TOKENS = 8192


def _confirm_system(*, document: str) -> str:
    return _CONFIRM_SYSTEM.format(document=document)


def _document_judge_messages(
    *, document: str, reference: str, clause: str, precedents: str
) -> tuple[str, str]:
    """(system, user). The document lives in the system half and nowhere else,
    so every clause of a run sends an identical prefix — which is what lets a
    provider's prompt cache charge for the document once rather than per clause."""
    return (
        _DOCUMENT_JUDGE_SYSTEM.format(document=document),
        _DOCUMENT_JUDGE_CLAUSE.format(
            reference=reference, clause=clause, precedents=_precedent_block(precedents)
        ),
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

    def judge_document(
        self, *, document: str, reference: str, clause: str, precedents: str = ""
    ) -> dict:
        system, user = _document_judge_messages(
            document=document, reference=reference, clause=clause, precedents=precedents
        )
        text = self._generate(
            [{"text": user}],
            system=system,
            max_tokens=2048,
            schema=_DOCUMENT_VERDICT_SCHEMA,
        )
        if not text:
            raise RuntimeError("gemini returned an empty verdict")
        return _parse_json(text)

    def suggest_improvements(self, *, design: str, findings: str, title: str) -> dict:
        text = self._generate(
            [{"text": _ADVICE_USER}],
            system=_advice_system(design=design, findings=findings, title=title),
            max_tokens=_ADVICE_MAX_TOKENS,
            schema=_ADVICE_SCHEMA,
        )
        if not text:
            raise RuntimeError("gemini returned no suggestions")
        return _parse_json(text)

    def find_technologies(self, *, design: str, products: str, title: str) -> dict:
        text = self._generate(
            [{"text": _LIFECYCLE_USER}],
            system=_lifecycle_system(design=design, products=products, title=title),
            max_tokens=_LIFECYCLE_MAX_TOKENS,
            schema=_LIFECYCLE_SCHEMA,
        )
        if not text:
            raise RuntimeError("gemini returned no technologies")
        return _parse_json(text)

    def find_uncovered(self, *, design: str, standards: str, title: str) -> dict:
        text = self._generate(
            [{"text": _COVERAGE_USER}],
            system=_coverage_system(design=design, standards=standards, title=title),
            max_tokens=_COVERAGE_MAX_TOKENS,
            schema=_COVERAGE_SCHEMA,
        )
        if not text:
            raise RuntimeError("gemini returned no coverage")
        return _parse_json(text)

    def confirm_absent(self, *, document: str, clauses: str) -> dict:
        text = self._generate(
            [{"text": _CONFIRM_USER.format(clauses=clauses)}],
            system=_confirm_system(document=document),
            max_tokens=_CONFIRM_MAX_TOKENS,
            schema=_CONFIRM_SCHEMA,
        )
        if not text:
            raise RuntimeError("gemini returned nothing on the absent clauses")
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

    def judge_document(
        self, *, document: str, reference: str, clause: str, precedents: str = ""
    ) -> dict:
        system, user = _document_judge_messages(
            document=document, reference=reference, clause=clause, precedents=precedents
        )
        data = self._send(
            {
                "model": self.model,
                "max_tokens": 2048,
                "temperature": 0,
                # The document is the same for every clause of a run.
                "system": [
                    {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
                ],
                "messages": [
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": "{"},
                ],
            },
        )
        return _parse_json("{" + self._text_of(data))

    def suggest_improvements(self, *, design: str, findings: str, title: str) -> dict:
        data = self._send(
            {
                "model": self.model,
                "max_tokens": _ADVICE_MAX_TOKENS,
                "temperature": 0,
                "system": _advice_system(design=design, findings=findings, title=title),
                "messages": [
                    {"role": "user", "content": _ADVICE_USER},
                    {"role": "assistant", "content": "{"},
                ],
            },
        )
        return _parse_json("{" + self._text_of(data))

    def find_technologies(self, *, design: str, products: str, title: str) -> dict:
        data = self._send(
            {
                "model": self.model,
                "max_tokens": _LIFECYCLE_MAX_TOKENS,
                "temperature": 0,
                "system": _lifecycle_system(design=design, products=products, title=title),
                "messages": [
                    {"role": "user", "content": _LIFECYCLE_USER},
                    {"role": "assistant", "content": "{"},
                ],
            },
        )
        return _parse_json("{" + self._text_of(data))

    def find_uncovered(self, *, design: str, standards: str, title: str) -> dict:
        data = self._send(
            {
                "model": self.model,
                "max_tokens": _COVERAGE_MAX_TOKENS,
                "temperature": 0,
                "system": _coverage_system(design=design, standards=standards, title=title),
                "messages": [
                    {"role": "user", "content": _COVERAGE_USER},
                    {"role": "assistant", "content": "{"},
                ],
            },
        )
        return _parse_json("{" + self._text_of(data))

    def confirm_absent(self, *, document: str, clauses: str) -> dict:
        data = self._send(
            {
                "model": self.model,
                "max_tokens": _CONFIRM_MAX_TOKENS,
                "temperature": 0,
                # The document is the same for every clause in the batch.
                "system": [
                    {
                        "type": "text",
                        "text": _confirm_system(document=document),
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                "messages": [
                    {"role": "user", "content": _CONFIRM_USER.format(clauses=clauses)},
                    {"role": "assistant", "content": "{"},
                ],
            },
        )
        return _parse_json("{" + self._text_of(data))


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
            # Best effort, not a promise: a provider that supports it gives the
            # same answer to the same prompt more often with a seed held still.
            # Providers that do not support it ignore it.
            "seed": _SEED,
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
            # As on Gemini. At 1024 a client deck's verdict was cut off mid-reply,
            # failed to parse, and cost that clause its verdict.
            max_tokens=2048,
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

    def judge_document(
        self, *, document: str, reference: str, clause: str, precedents: str = ""
    ) -> dict:
        system, user = _document_judge_messages(
            document=document, reference=reference, clause=clause, precedents=precedents
        )
        text = self._chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=2048,
            schema=_DOCUMENT_VERDICT_SCHEMA,
            name="verdict",
        )
        if not text:
            raise RuntimeError("openrouter returned an empty verdict")
        return _parse_json(text)

    def suggest_improvements(self, *, design: str, findings: str, title: str) -> dict:
        text = self._chat(
            [
                {
                    "role": "system",
                    "content": _advice_system(design=design, findings=findings, title=title),
                },
                {"role": "user", "content": _ADVICE_USER},
            ],
            max_tokens=_ADVICE_MAX_TOKENS,
            schema=_ADVICE_SCHEMA,
            name="suggestions",
        )
        if not text:
            raise RuntimeError("openrouter returned no suggestions")
        return _parse_json(text)

    def find_technologies(self, *, design: str, products: str, title: str) -> dict:
        text = self._chat(
            [
                {
                    "role": "system",
                    "content": _lifecycle_system(design=design, products=products, title=title),
                },
                {"role": "user", "content": _LIFECYCLE_USER},
            ],
            max_tokens=_LIFECYCLE_MAX_TOKENS,
            schema=_LIFECYCLE_SCHEMA,
            name="technologies",
        )
        if not text:
            raise RuntimeError("openrouter returned no technologies")
        return _parse_json(text)

    def find_uncovered(self, *, design: str, standards: str, title: str) -> dict:
        text = self._chat(
            [
                {
                    "role": "system",
                    "content": _coverage_system(design=design, standards=standards, title=title),
                },
                {"role": "user", "content": _COVERAGE_USER},
            ],
            max_tokens=_COVERAGE_MAX_TOKENS,
            schema=_COVERAGE_SCHEMA,
            name="coverage",
        )
        if not text:
            raise RuntimeError("openrouter returned no coverage")
        return _parse_json(text)

    def confirm_absent(self, *, document: str, clauses: str) -> dict:
        text = self._chat(
            [
                {"role": "system", "content": _confirm_system(document=document)},
                {"role": "user", "content": _CONFIRM_USER.format(clauses=clauses)},
            ],
            max_tokens=_CONFIRM_MAX_TOKENS,
            schema=_CONFIRM_SCHEMA,
            name="confirmation",
        )
        if not text:
            raise RuntimeError("openrouter returned nothing on the absent clauses")
        return _parse_json(text)


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


def judge_document(*, document: str, reference: str, clause: str, precedents: str = "") -> dict:
    """A verdict on one clause from the whole document, with quotes to check.

    See `whole_document.py`: the reply's quotes are evidence only once found in
    the document word for word, which the analyse stage checks before believing
    any of them.
    """
    return client().judge_document(
        document=document, reference=reference, clause=clause, precedents=precedents
    )


def suggest_improvements(*, design: str, findings: str, title: str) -> dict:
    """Improvements to a design, each anchored to one of its sections.

    Section numbers and quotes only; see `advice.py`, which checks every one
    against the design before any suggestion is kept.
    """
    return client().suggest_improvements(design=design, findings=findings, title=title)


def find_technologies(*, design: str, products: str, title: str) -> dict:
    """The technologies a design uses, each as an endoflife.date product id.

    Ids, versions and quotes only; see `lifecycle.py`, which checks every one
    against the product list and the design before anything is looked up.
    """
    return client().find_technologies(design=design, products=products, title=title)


def find_uncovered(*, design: str, standards: str, title: str) -> dict:
    """The design sections no standard clause governs, and standards to add.

    Section numbers and quotes only; see `coverage.py`, which checks every one
    against the design before any gap is kept.
    """
    return client().find_uncovered(design=design, standards=standards, title=title)


def confirm_absent(*, document: str, clauses: str) -> dict:
    """Read the whole document once for every clause a search found nothing for.

    Search judges a clause on eight passages, which is enough to say "here it
    is" and never enough to say "it is nowhere". This is the second half of that
    answer, and it is one call for the whole batch rather than one per clause.
    The analyse stage changes a verdict only on a quote it finds in the document
    word for word.
    """
    return client().confirm_absent(document=document, clauses=clauses)


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
