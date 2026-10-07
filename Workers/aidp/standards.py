"""Sharpening one clause from one confirmed `partial`, with the checks.

Every other model call in this system reports on a design. This one writes
towards the standards library, so it is the only place a model's words can end
up binding future assessments — and it is bounded accordingly.

What a `partial` actually means is that the clause could not be judged. "Ensure
resilience" against a design that retries without a dead-letter path is partial
for ever: the design does some of it, the clause never said what the rest was,
and the next design gets the same useless verdict. A reviewer who has just
confirmed that verdict knows what the clause meant. This turns that knowledge
into requirement lines.

The model may add requirement lines and do nothing else. It does not rewrite the
statement, does not touch the rationale, and decides nothing — a person approves
every line before it reaches the library. See the prompt in `ai/llm.py`.

Four checks, all deterministic, because a prompt rule that is only *mostly*
followed is not a guarantee:

  * **Normative.** A line without "must" or "shall" is an observation about one
    design, not a requirement on every design.
  * **Not already required.** The clause's own lines are in the prompt; a
    restatement of one would mean the same clause saying the same thing twice,
    and both halves reaching the judge as independent requirements.
  * **Not lifted.** A line that appears verbatim in the design, or that uses the
    design's own proper names, is a fact about one system. This is the mirror of
    the quote check everywhere else: there a claim must be in the document, here
    it must *not* be.
  * **Built on something it was given.** Each line names the evidence passage
    that showed the gap. A number the model was never given is an invented
    basis, exactly as `_applied` treats an invented decision id in the analyse
    stage.

What is refused is kept with its reason, so a reviewer looking at one
requirement can see the two that were thrown away.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import db, logs
from .ai import llm

log = logs.get(__name__)

# At most this many lines reach a reviewer, however many come back. The prompt
# asks for three; this is the floor under it.
MAX_REQUIREMENTS = 3

# A requirement longer than this is a paragraph, and a paragraph is two
# requirements that cannot be checked separately.
MAX_CHARS = 240

# Below this a line cannot be naming a mechanism and a target state.
MIN_WORDS = 6

MAX_NOTE = 200

# What makes a line a rule rather than a remark. Checked rather than trusted:
# the prompt asks for "must", and a model that drifts into "should consider"
# has written advice, which is a different product.
_NORMATIVE = re.compile(r"\b(must|shall|is\s+required\s+to|are\s+required\s+to)\b", re.IGNORECASE)

# Words that make a requirement unjudgeable. A standard nobody can fail is not
# a standard, and these are the ways a model writes one by accident. Kept in
# step with rule 5 of `_SHARPEN_SYSTEM`.
_VAGUE = re.compile(
    r"\b("
    r"appropriate(ly)?|adequate(ly)?|as\s+necessary|where\s+possible|where\s+appropriate"
    r"|best\s+practices?|consider(ing|ed)?|proper(ly)?|robust|sufficient(ly)?"
    r"|as\s+needed|if\s+required|suitable|reasonable"
    r")\b",
    re.IGNORECASE,
)

# Two or more capitalised words in a row — "Customer Portal", "Field Telemetry
# Ingestion". Single capitalised tokens are left alone: "TLS", "API" and "MFA"
# belong in a standard, and refusing them would throw away the good lines with
# the bad.
#
# Matched against the design's own *name* only, and not against the prose of a
# quoted passage or the titles of its sections. A passage is full of capitalised
# phrases that belong in a standard ("Dead Letter Queue", "Transport Layer
# Security"), and a section is headed with generic ones ("Message Handling") —
# refusing those would be worse than the problem: a requirement thrown away for
# using the right words.
#
# A single-token product name ("Keycloak") therefore is not caught here. Rule 2
# of the prompt forbids it and the approver reads every line before it binds —
# this is the floor, not the whole guarantee.
_PROPER = re.compile(r"\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)+\b")

# A heading path is "Field Telemetry Ingestion SAD › 4.2 Message Handling": the
# document's own title, then its sections. Only the first segment is the name of
# the design — see `heading_path` in parsing/sections.py, which joins with this.
_PATH = " › "


def _words(text: str) -> str:
    """Lowercased, punctuation-free, single-spaced — for comparing meaning-ish."""
    return " ".join(re.sub(r"[^a-z0-9\s]+", " ", text.lower()).split())


@dataclass
class Drafted:
    """What one sharpening produced, in the shape the draft row stores."""

    state: str = "ready"
    requirements: list[str] = field(default_factory=list)
    note: str = ""
    model: str | None = None
    error: str | None = None
    set_aside: list[dict] = field(default_factory=list)

    def refuse(self, text: str, reason: str) -> None:
        self.set_aside.append({"text": text[:MAX_CHARS], "reason": reason})


def render_clause(clause: dict) -> str:
    """The clause as the model is shown it: every part, and its existing lines.

    The existing requirements are numbered because rule 3 tells the model to
    read them before writing anything, and an unnumbered list invites it to add
    a fourth that restates the second.
    """
    lines = [f"Reference: {clause.get('clauseRef') or '(unnumbered)'}"]
    if clause.get("title"):
        lines.append(f"Title: {clause['title']}")
    if clause.get("statement"):
        lines.append(f"Statement: {clause['statement']}")
    if clause.get("rationale"):
        lines.append(f"Rationale: {clause['rationale']}")

    existing = [r for r in (clause.get("requirements") or []) if str(r).strip()]
    if existing:
        lines.append("Requirements it already has:")
        lines.extend(f"  {i}. {r}" for i, r in enumerate(existing, start=1))
    else:
        # Worth saying out loud. A clause with a statement and no requirements
        # is the commonest shape in a half-written library, and the model
        # otherwise reads the empty list as an omission from the prompt.
        lines.append("Requirements it already has: none.")

    guidance = [g for g in (clause.get("guidance") or []) if str(g).strip()]
    if guidance:
        lines.append("Guidance beside it (not binding): " + " | ".join(guidance))
    return "\n".join(lines)


def render_finding(finding: dict) -> str:
    """The verdict and the reason it was reached, as the case for sharpening."""
    lines = [
        f"Verdict: {finding.get('verdict') or 'partial'} (confirmed by a reviewer)",
        f"Reason given: {finding.get('rationale') or '(none recorded)'}",
    ]
    if finding.get("reviewerNote"):
        lines.append(f"Reviewer's note: {finding['reviewerNote']}")
    return "\n".join(lines)


def evidence_of(finding: dict) -> list[dict]:
    """The cited passages, as stored on the finding, kept in order.

    Read defensively for the reason coverage.ts gives about the same JSON: a
    malformed entry is dropped, never guessed at.
    """
    raw = finding.get("evidence")
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        excerpt = str(item.get("excerpt") or "").strip()
        if not excerpt:
            continue
        out.append(
            {
                "excerpt": excerpt,
                "headingPath": str(item.get("headingPath") or ""),
                "page": item.get("page") if isinstance(item.get("page"), int) else None,
                "documentTitle": str(item.get("documentTitle") or ""),
            }
        )
    return out


def render_evidence(evidence: list[dict]) -> str:
    """The passages, numbered from 1 — the numbers the model answers in."""
    if not evidence:
        return "(the assessment cited no passages)"
    blocks = []
    for number, item in enumerate(evidence, start=1):
        where = item["headingPath"] or item["documentTitle"] or "the design"
        page = f", page {item['page']}" if item["page"] is not None else ""
        blocks.append(f"[{number}] {where}{page}\n{item['excerpt']}")
    return "\n\n".join(blocks)


def _design_words(evidence: list[dict]) -> str:
    """Everything of the design the model was shown, flattened for comparison."""
    return _words(" ".join(item["excerpt"] for item in evidence))


def _windows(phrase: str) -> set[str]:
    """Every run of two or more consecutive words in a phrase.

    Because a design is referred to by part of its name as often as by all of
    it. The evidence carries "Field Telemetry Ingestion SAD"; the line that has
    to be refused says "the Field Telemetry Ingestion consumer must…", and
    checking only the whole phrase would have let it through.
    """
    words = phrase.split()
    return {
        " ".join(words[start:stop])
        for start in range(len(words))
        for stop in range(start + 2, len(words) + 1)
    }


def _proper_names(evidence: list[dict]) -> set[str]:
    """The design's own name, and the parts of it that stand for the whole.

    From its title only — never the quoted prose, never its section headings.
    See the note on `_PROPER` for why that line is drawn where it is.
    """
    names: set[str] = set()
    for item in evidence:
        titles = [item["documentTitle"]]
        if item["headingPath"]:
            titles.append(item["headingPath"].split(_PATH)[0])
        for title in titles:
            for match in _PROPER.finditer(title or ""):
                names.update(_windows(match.group(0)))
    return names


def check(
    reply: dict,
    *,
    clause: dict,
    evidence: list[dict],
    model: str | None = None,
) -> Drafted:
    """One reply, checked line by line into a draft a person can be shown.

    Pure: no database and no network, so every refusal below is testable
    without either. `record` is the part that reads and writes.
    """
    out = Drafted(model=model)

    offered = reply.get("requirements") if isinstance(reply.get("requirements"), list) else []
    existing = [_words(str(r)) for r in (clause.get("requirements") or []) if str(r).strip()]
    design = _design_words(evidence)
    names = _proper_names(evidence)
    allowed = set(range(1, len(evidence) + 1))
    kept: list[str] = []

    for item in offered:
        if not isinstance(item, dict):
            continue
        text = " ".join(str(item.get("text") or "").split())
        if not text:
            continue

        if len(text) > MAX_CHARS:
            out.refuse(text, "longer than one requirement")
            continue
        if len(text.split()) < MIN_WORDS:
            out.refuse(text, "too short to name a mechanism")
            continue
        if not _NORMATIVE.search(text):
            out.refuse(text, "not written as a requirement")
            continue
        if _VAGUE.search(text):
            out.refuse(text, "wording a design could not be failed on")
            continue

        # The basis has to be a passage the model was actually given. A number
        # outside the list is an invented citation, and a requirement resting
        # on one has nothing behind it.
        basis = item.get("basis")
        if not isinstance(basis, int) or basis not in allowed:
            out.refuse(text, "cites a passage that was not given")
            continue

        plain = _words(text)
        if any(plain == line or plain in line or line in plain for line in existing):
            out.refuse(text, "the clause already requires this")
            continue
        if any(plain == _words(other) for other in kept):
            out.refuse(text, "repeats another proposed line")
            continue

        # The mirror of the quote check. A line that is in the design is a
        # description of one system; a standard has to outlive it.
        if plain and plain in design:
            out.refuse(text, "copied from the design rather than written as a rule")
            continue
        # Longest first: "Field Telemetry Ingestion" says more to a reviewer
        # than "Field Telemetry", and both will have matched.
        named = sorted((name for name in names if name in text), key=len, reverse=True)
        if named:
            out.refuse(text, f"names the design itself ({named[0]})")
            continue

        kept.append(text)
        if len(kept) >= MAX_REQUIREMENTS:
            break

    out.requirements = kept
    out.note = " ".join(str(reply.get("note") or "").split())[:MAX_NOTE]

    if not kept:
        # Not a failure. "This clause is already specific enough" is a real and
        # useful answer, and the prompt says so — but the reviewer has to be
        # told which it was, so the note carries it and the state does not lie.
        out.state = "ready"
        logs.info(
            log,
            "sharpening produced no requirements",
            refused=len(out.set_aside),
            clauseRef=clause.get("clauseRef"),
        )
    return out


_CLAUSE = """
SELECT cl."id", cl."title", cl."statement", cl."rationale", cl."requirements",
       cl."guidance", cl."supersededById",
       s."numberText", s."headingPath",
       d."title" AS "documentTitle"
  FROM "clause" cl
  JOIN "document_section" s ON s."id" = cl."sectionId"
  JOIN "document" d ON d."id" = s."documentId"
 WHERE cl."id" = %s
"""

_FINDING = """
SELECT "id", "verdict", "rationale", "evidence", "reviewerState", "reviewerVerdict",
       "reviewerNote", "clauseRef", "clauseTitle"
  FROM "finding"
 WHERE "id" = %s
"""


def record(draft_id: str) -> dict:
    """Work out one draft and store it. Returns the draft's new state.

    Never raises for a model's sake: a failure is written onto the draft so the
    reviewer who asked for it sees why, rather than a row that sits "drafting"
    for ever with the reason only in a log.
    """
    with db.connection() as conn:
        draft = db.one(
            conn,
            'SELECT "id", "clauseId", "sourceFindingId", "state" FROM "clause_draft" '
            "WHERE \"id\" = %s",
            (draft_id,),
        )
        if draft is None:
            raise RuntimeError(f"clause draft {draft_id} no longer exists")
        clause = db.one(conn, _CLAUSE, (draft["clauseId"],))
        finding = db.one(conn, _FINDING, (draft["sourceFindingId"],))

    if draft["state"] != "drafting":
        # Discarded, or already applied, while the job waited for a worker.
        logs.info(log, "draft is no longer being worked out", draftId=draft_id, state=draft["state"])
        return {"state": draft["state"]}

    if clause is None or finding is None:
        return _store(draft_id, Drafted(state="failed", error="The clause or the finding behind this draft no longer exists."))
    if clause["supersededById"]:
        return _store(
            draft_id,
            Drafted(
                state="failed",
                error="That clause has already been replaced by a sharper version. "
                "Assess again and start from the new one.",
            ),
        )

    clause = dict(clause, clauseRef=clause["numberText"] or clause["headingPath"] or "")
    evidence = evidence_of(finding)
    if not evidence:
        # Reachable: a `partial` whose evidence was emptied by the guards. There
        # is nothing for a requirement to rest on, and rule 6 would refuse
        # every line anyway — so this is said plainly instead of paying for a
        # model call that cannot succeed.
        return _store(
            draft_id,
            Drafted(
                state="failed",
                error="This finding cites no passage of the design, so there is nothing "
                "to write a requirement from.",
            ),
        )

    try:
        reply = llm.sharpen_clause(
            clause=render_clause(clause),
            finding=render_finding(finding),
            evidence=render_evidence(evidence),
        )
    except Exception as exc:  # noqa: BLE001 — the reviewer has to be told
        logs.warn(log, "sharpening call failed", draftId=draft_id, error=str(exc)[:200])
        return _store(draft_id, Drafted(state="failed", error=str(exc)[:400]))

    drafted = check(reply, clause=clause, evidence=evidence, model=llm.model_name()[1])
    return _store(draft_id, drafted)


def _store(draft_id: str, drafted: Drafted) -> dict:
    from psycopg.types.json import Jsonb

    with db.transaction() as conn:
        db.execute(
            conn,
            """
            UPDATE "clause_draft"
               SET "state" = %s,
                   "requirements" = %s,
                   "note" = %s,
                   "model" = %s,
                   "error" = %s,
                   "setAside" = %s,
                   "updatedAt" = now()
             WHERE "id" = %s
            """,
            (
                drafted.state,
                drafted.requirements,
                drafted.note,
                drafted.model,
                drafted.error,
                Jsonb(drafted.set_aside),
                draft_id,
            ),
        )
    logs.info(
        log,
        "clause draft worked out",
        draftId=draft_id,
        state=drafted.state,
        requirements=len(drafted.requirements),
        refused=len(drafted.set_aside),
    )
    return {
        "state": drafted.state,
        "requirements": drafted.requirements,
        "note": drafted.note,
        "setAside": drafted.set_aside,
        "error": drafted.error,
    }
