"""Smoke test for whole-document assessment — no database, no network.

What has to hold for a verdict reached by reading the whole document to be
trusted as much as one reached by search:

  · the document      every page, headings marked, table rows bound to their
                      columns, figure descriptions labelled as a model's reading
                      and kept apart from the document's own words
  · quotes            found word for word despite typography, line and page
                      breaks; moved to the page they are really on; refused when
                      invented, too short to identify, or taken from a figure
  · the prompt        the document sits in an identical prefix for every clause,
                      so a provider caches it; schemas are strict everywhere
  · the guards        a verdict that needs evidence and has no checked quote is
                      demoted, a partly invented set of quotes says so, and every
                      guard the search path has still applies
  · page text         decks and workbooks become the same numbered lines as PDFs
                      and Word files, so any submission can be read whole

    PYTHONPATH=Workers python3 Workers/scripts/smoke_whole_document.py
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
os.environ.setdefault("STAGE", "analyse")
os.environ.setdefault("DATABASE_URL", "postgresql://smoke/test")
os.environ["LLM_PROVIDER"] = "openrouter"
os.environ["OPENROUTER_API_KEY"] = "test-key"

from aidp import whole_document  # noqa: E402
from aidp.ai import llm  # noqa: E402
from aidp.parsing import rules, sections, spans, tables  # noqa: E402
from aidp.stages import analyse  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


LINES = [
    {"page": 1, "kind": "heading", "text": "1. Security"},
    {
        "page": 1,
        "kind": "text",
        "text": "All administrative access uses multi-factor authentication via Okta.",
    },
    {
        "page": 1,
        "kind": "bullet",
        "text": "Secrets are stored in HashiCorp Vault and rotated every 90 days.",
    },
    {
        "page": 2,
        "kind": "table_row",
        "text": "Control: Encryption at rest | Minimum Standard: AES-256 for all databases",
    },
    {"page": 2, "kind": "text", "text": "Telemetry is transmitted over plain MQTT without"},
    {"page": 3, "kind": "text", "text": "transport encryption during the pilot."},
]
FIGURES = [
    {
        "page": 2,
        "description": "Diagram of an MQTT broker feeding ingestion workers.",
        "correctedDescription": None,
        "reviewState": "pending",
    },
    {
        "page": 3,
        "description": "A rejected reading of a logo.",
        "correctedDescription": None,
        "reviewState": "rejected",
    },
    {
        "page": 3,
        "description": "Wrong first reading.",
        "correctedDescription": "Deployment across two availability zones.",
        "reviewState": "corrected",
    },
]
doc = whole_document.build("Field Telemetry", LINES, FIGURES)


# ---------------------------------------------------------------------------
print("\n1. The document as the judge reads it")
ok("every page is marked", all(f"=== page {p} ===" in doc.text for p in (1, 2, 3)), doc.text)
ok(
    "headings and bullets keep their shape",
    "## 1. Security" in doc.text and "- Secrets are stored" in doc.text,
)
ok("a table row keeps its columns", "Control: Encryption at rest | Minimum Standard" in doc.text)
ok(
    "figure descriptions are labelled as a model's reading, apart from the document",
    "<figure_descriptions>" in doc.text
    and "never quote them" in doc.text
    and doc.text.index("</design_document>") < doc.text.index("<figure_descriptions>"),
)
ok(
    "a reviewer's correction replaces the reading, and a rejected one is left out",
    "two availability zones" in doc.text
    and "Wrong first reading" not in doc.text
    and "rejected reading" not in doc.text,
)
ok("size is estimated", doc.tokens == len(doc.text) // whole_document.CHARS_PER_TOKEN > 0)


# ---------------------------------------------------------------------------
print("\n2. Checking quotes")
check = doc.verify("All administrative access uses multi-factor authentication via Okta.", 1)
ok("an exact quote is found on its page", check.verified and check.page == 1, check)
check = doc.verify("“all  administrative ACCESS uses multi‑factor authentication”", 1)
ok("typography, case and spacing do not matter", check.verified, check)
check = doc.verify("Secrets are stored in HashiCorp Vault", 3)
ok(
    "a quote on another page is found and moved to the right page",
    check.verified and check.page == 1 and "found on page 1" in check.reason,
    check,
)
check = doc.verify("transmitted over plain MQTT without transport encryption", 2)
ok("a sentence running over a page break is one passage", check.verified and check.page == 2, check)
check = doc.verify("Encryption at rest | Minimum Standard: AES-256", 2)
ok("a table row is quotable as it reads", check.verified, check)
check = doc.verify("All administrative access … via Okta", 1)
ok("an ellipsis is allowed when every part is there, in order", check.verified, check)
check = doc.verify("via Okta … All administrative access", 1)
ok("but not when the parts are out of order", not check.verified, check)
check = doc.verify("All administrative access uses passwords only", 1)
ok("words that are not in the document are refused", not check.verified, check)
check = doc.verify("uses Okta", 1)
ok(
    "a quote too short to identify anything is refused",
    not check.verified and "too short" in check.reason,
    check,
)
check = doc.verify("multi-factor authentication via Okt", 1)
ok("half a word is not a match", not check.verified, check)
check = doc.verify("MQTT broker feeding ingestion workers", 2)
ok("a figure description is not the document's text", not check.verified, check)
check = doc.verify("Secrets are stored in HashiCorp Vault", None)
ok("a quote with no page is still found", check.verified and check.page == 1, check)


# ---------------------------------------------------------------------------
print("\n3. The prompt")
sent: list[dict] = []


def fake_post(url, headers, payload, attempts=4):
    sent.append(payload)
    return {
        "choices": [
            {
                "message": {
                    "content": json.dumps(
                        {
                            "verdict": "covered",
                            "confidence": 0.9,
                            "rationale": "Stated.",
                            "evidence": [
                                {"quote": "uses multi-factor authentication via Okta", "page": 1}
                            ],
                            "appliedDecisions": [],
                        }
                    )
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 900, "completion_tokens": 40},
    }


llm._post = fake_post
llm.usage.record = lambda **kwargs: None
client = llm.OpenRouterLLM(
    "k", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano", providers=("openai", "azure")
)
reply = client.judge_document(
    document=doc.text,
    reference="Security Standards — 3.2 MFA",
    clause="Title: MFA\nStatement: Privileged access must use MFA.",
)
client.judge_document(
    document=doc.text,
    reference="Security Standards — 4.1 Encryption",
    clause="Title: Encryption\nStatement: Data must be encrypted in transit.",
)
first, second = sent[0], sent[1]
ok("the reply is parsed", reply["verdict"] == "covered", reply)
ok(
    "the document is in the system message, the clause in the user message",
    "=== page 1 ===" in first["messages"][0]["content"]
    and "3.2 MFA" in first["messages"][1]["content"]
    and "=== page" not in first["messages"][1]["content"],
)
ok(
    "every clause of a run sends an identical prefix, so it is cached",
    first["messages"][0] == second["messages"][0] and first["messages"][1] != second["messages"][1],
)
evidence_items = first["response_format"]["json_schema"]["schema"]["properties"]["evidence"][
    "items"
]
ok(
    "quotes are required with a page that may be null, under a strict schema",
    first["response_format"]["json_schema"]["strict"] is True
    and evidence_items["required"] == ["quote", "page"]
    and evidence_items["properties"]["page"]["type"] == ["integer", "null"]
    and evidence_items["additionalProperties"] is False,
    evidence_items,
)
ok(
    "sent with the same data policy as every call",
    first["provider"]["data_collection"] == "deny"
    and first["provider"]["only"] == ["openai", "azure"],
)

captured: dict = {}
gemini = llm.GeminiLLM("k", "gemini-x")


def fake_generate(parts, *, system, max_tokens, schema=None, temperature=None, attempts=4):
    captured.update(parts=parts, system=system, schema=schema)
    return json.dumps(
        {
            "verdict": "absent",
            "confidence": 0.8,
            "rationale": "x",
            "evidence": [],
            "appliedDecisions": [],
        }
    )


gemini._generate = fake_generate
gemini.judge_document(document=doc.text, reference="r", clause="c")
ok(
    "Gemini: document as the system instruction, clause as the turn, with a schema",
    "=== page 1 ===" in captured["system"]
    and "Reference: r" in captured["parts"][0]["text"]
    and captured["schema"] is llm._DOCUMENT_VERDICT_SCHEMA,
)

claude = llm.AnthropicLLM("k", "claude-x", "claude-fast")
claude._send = lambda payload: (
    captured.update(claude=payload)
    or {
        "content": [
            {
                "type": "text",
                "text": '"verdict": "absent", "confidence": 0.7, "rationale": "x", '
                '"evidence": [], "appliedDecisions": []}',
            }
        ]
    }
)
result = claude.judge_document(document=doc.text, reference="r", clause="c")
ok(
    "Claude: the document is a cached system block and the reply is prefilled",
    captured["claude"]["system"][0]["cache_control"] == {"type": "ephemeral"}
    and captured["claude"]["messages"][-1] == {"role": "assistant", "content": "{"}
    and result["verdict"] == "absent",
    captured["claude"]["system"][0].keys(),
)


# ---------------------------------------------------------------------------
print("\n4. Quotes into evidence, and the guards")


def judged(reply: dict, *, fabricated=(), conflicted=False):
    verdict, confidence, rationale, _, _ = analyse._normalise(reply)
    evidence, unverified = analyse._checked_quotes(reply, doc)
    verdict, rationale = analyse._guard_document(
        verdict,
        confidence,
        rationale,
        evidence=evidence,
        unverified=unverified,
        fabricated=list(fabricated),
        conflicted=conflicted,
    )
    return verdict, rationale, evidence


verdict, rationale, evidence = judged(
    {
        "verdict": "covered",
        "confidence": 0.9,
        "rationale": "MFA via Okta.",
        "evidence": [
            {"quote": "Secrets are stored in HashiCorp Vault and rotated every 90 days", "page": 2}
        ],
    }
)
ok(
    "a checked quote carries the verdict, on the page it was really found",
    verdict == "covered"
    and evidence
    and evidence[0]["page"] == 1
    and evidence[0]["claimedPage"] == 2
    and evidence[0]["sourceKind"] == "quote",
    evidence,
)
ok(
    "evidence has the shape the report already renders",
    {"chunkId", "headingPath", "page", "excerpt", "sourceKind", "figureId"} <= set(evidence[0]),
)

verdict, rationale, evidence = judged(
    {
        "verdict": "covered",
        "confidence": 0.95,
        "rationale": "Encrypted everywhere.",
        "evidence": [{"quote": "All traffic is encrypted with TLS 1.3 end to end", "page": 2}],
    }
)
ok(
    "an invented quote cannot carry a verdict",
    verdict == "needs_review" and "could not be found" in rationale and not evidence,
    rationale,
)

verdict, rationale, _ = judged(
    {"verdict": "contradicts", "confidence": 0.9, "rationale": "Plain MQTT.", "evidence": []}
)
ok(
    "a verdict that quotes nothing is demoted",
    verdict == "needs_review" and "quoted nothing" in rationale,
    rationale,
)

verdict, rationale, evidence = judged(
    {
        "verdict": "partial",
        "confidence": 0.8,
        "rationale": "Rotation is stated; storage is not.",
        "evidence": [
            {"quote": "rotated every 90 days", "page": 1},
            {"quote": "rotation is audited quarterly by security", "page": 1},
        ],
    }
)
ok(
    "a partly invented set of quotes keeps the real one and says the rest were set aside",
    verdict == "partial" and len(evidence) == 1 and "set aside" in rationale,
    (verdict, rationale),
)

verdict, rationale, _ = judged(
    {"verdict": "absent", "confidence": 0.3, "rationale": "Nothing.", "evidence": []}
)
ok("an unsure absent is a question", verdict == "needs_review" and "low confidence" in rationale)

verdict, rationale, _ = judged(
    {"verdict": "absent", "confidence": 0.9, "rationale": "Nothing.", "evidence": []}
)
ok("a confident absent stands here (search cross-checks it in the stage)", verdict == "absent")

verdict, rationale, _ = judged(
    {
        "verdict": "covered",
        "confidence": 0.9,
        "rationale": "Per decision.",
        "evidence": [{"quote": "uses multi-factor authentication via Okta", "page": 1}],
        "appliedDecisions": ["made-up"],
    },
    fabricated=["made-up"],
)
ok(
    "a decision nobody made still demotes, as on the search path",
    verdict == "needs_review" and "not on record" in rationale,
    rationale,
)

verdict, _, _ = judged(
    {
        "verdict": "covered",
        "confidence": 0.9,
        "rationale": "x",
        "evidence": [{"quote": "uses multi-factor authentication via Okta", "page": 1}],
    },
    conflicted=True,
)
ok("conflicting decisions still demote", verdict == "needs_review")

verdict, rationale, evidence = judged(
    {
        "verdict": "covered",
        "confidence": 0.9,
        "rationale": "x",
        "evidence": ["uses multi-factor authentication via Okta", {"quote": "", "page": 1}, 42],
    }
)
ok(
    "quotes given as bare strings are checked, empty or odd ones ignored",
    verdict == "covered" and len(evidence) == 1 and evidence[0]["claimedPage"] is None,
    evidence,
)


# ---------------------------------------------------------------------------
print("\n5. Page text for decks and workbooks")


def line(text: str, page: int) -> spans.Line:
    return spans.Line(
        text=text,
        page=page,
        y=0.0,
        x0=0.0,
        bbox=(0.0, 0.0, 0.0, 0.0),
        sig=("Arial", 12.0, False, False, 0),
    )


deck_lines = [
    line("Loblaws Objectives", 1),
    line("Grow B2B revenue", 1),
    line("Option | Cost | Time", 2),
    line("Custom | $2M | 9 months", 2),
    line("Speaker note about delivery risk", 2),
]
deck = SimpleNamespace(
    lines=deck_lines, hints={0: "title", 1: "body", 2: "table", 3: "table", 4: "notes"}
)
deck_sections = [
    sections.Section(
        1, None, "Loblaws Objectives", 1, "D › Loblaws Objectives", 1, 1, lines=[deck_lines[1]]
    ),
    sections.Section(
        2, None, "Solution Options", 1, "D › Solution Options", 2, 2, lines=deck_lines[2:5]
    ),
]
deck_source = rules.deck_source(deck, deck_sections)
ok(
    "a deck's title, rows and notes become typed lines, the slide as page",
    [s.kind for s in deck_source] == ["heading", "text", "table_row", "table_row", "text"]
    and [s.page for s in deck_source] == [1, 1, 2, 2, 2],
    [(s.kind, s.page) for s in deck_source],
)
ok(
    "each line lands in its slide's section",
    [s.section for s in deck_source] == [0, 0, 1, 1, 1],
    [s.section for s in deck_source],
)

book_lines = [line("Requirements", 1), line("Owner: Platform team", 1), line("Risks", 2)]
book = SimpleNamespace(
    lines=book_lines,
    hints={0: "sheet", 1: "text", 2: "sheet"},
    tables=[
        tables.Table(
            page_start=1,
            page_end=1,
            bbox=(0.0, 0.0, 0.0, 0.0),
            columns=["ID", "Requirement"],
            rows=[{"ID": "R1", "Requirement": "MFA for admins"}],
        ),
        tables.Table(
            page_start=2,
            page_end=2,
            bbox=(0.0, 0.0, 0.0, 0.0),
            columns=["Risk", "Owner"],
            rows=[{"Risk": "Vendor lock-in", "Owner": "CTO"}],
        ),
    ],
)
book_sections = [
    sections.Section(1, None, "Requirements", 1, "B › Requirements", 1, 1, lines=[book_lines[1]]),
    sections.Section(2, None, "Risks", 1, "B › Risks", 2, 2, lines=[]),
]
book_source = rules.workbook_source(
    book, book_sections, table_section=lambda t: 0 if t.page_start == 1 else 1
)
ok(
    "a workbook reads sheet by sheet: its lines, then its tables, rows bound to columns",
    [s.text for s in book_source]
    == [
        "Requirements",
        "Owner: Platform team",
        "ID | Requirement",
        "ID: R1 | Requirement: MFA for admins",
        "Risks",
        "Risk | Owner",
        "Risk: Vendor lock-in | Owner: CTO",
    ],
    [s.text for s in book_source],
)
ok(
    "sheet names are headings and each sheet is a page",
    [s.kind for s in book_source][0] == "heading" and [s.page for s in book_source][-1] == 2,
)

whole = whole_document.build(
    "Deck", [{"page": s.page, "kind": s.kind, "text": s.text} for s in deck_source], []
)
ok(
    "deck lines read whole, and a slide's table row is quotable",
    whole.verify("Custom | $2M | 9 months", 2).verified,
    whole.text,
)

# ---------------------------------------------------------------------------
print("\n6. Pages, and quotes stitched from two places")
check = doc.verify("transport encryption during the pilot.", 2)
ok(
    "a quote wholly on the next page is given that page, not the one before",
    check.verified and check.page == 3 and "found on page 3" in check.reason,
    check,
)
stitched = {
    "evidence": [
        {
            "quote": "Secrets are stored in HashiCorp Vault and rotated every 90 days. "
            "Telemetry is transmitted over plain MQTT without",
            "page": 1,
        }
    ]
}
evidence, unverified = analyse._checked_quotes(stitched, doc)
ok(
    "two real sentences joined into one quote are kept as two pieces, each on its page",
    [e["page"] for e in evidence] == [1, 2] and not unverified,
    (evidence, unverified),
)
invented = {
    "evidence": [
        {
            "quote": "Secrets are stored in HashiCorp Vault and rotated every 90 days. "
            "All traffic is encrypted with TLS 1.3 end to end.",
            "page": 1,
        }
    ]
}
evidence, unverified = analyse._checked_quotes(invented, doc)
ok(
    "one invented sentence refuses the whole quote",
    not evidence and len(unverified) == 1,
    (evidence, unverified),
)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
