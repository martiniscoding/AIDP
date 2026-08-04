"""Standing decisions, retrieved for the analyse stage.

Mirrors `forClause` in src/lib/ingest/decisions.ts — the app shows a reviewer
which decisions the next run will weigh, and this is what the run actually
weighs. The two have to agree or the preview is a lie.

A decision is what the customer concluded when a standard last met a real
design. Feeding them back in is the difference between a tool that assesses and
one that remembers: without it, an architect overrides the same finding on every
submission and the product never learns anything from being corrected.

Retrieval is a union of two things, not a ranking of one:

  * every active decision anchored to this clause reference — an explicit ruling
    on this clause is never outranked by something that merely reads similarly
  * the nearest remaining decisions by meaning, so a ruling recorded against
    §3.2 still surfaces on §7.1 when both are about key management

Expiry is checked here as well as swept on read by the app. The sweep only
happens when someone opens the register, and a run that starts before that would
otherwise be handed a decision whose term has ended.

Decisions with no vector (the embedding call failed when they were recorded)
participate in the first half only. That is a degraded match, not a broken one,
and the register flags them.
"""

from __future__ import annotations

from dataclasses import dataclass

import psycopg

from . import db, logs
from .ai import embeddings
from .config import get_config

log = logs.get(__name__)

# What each effect means, in the words the model is given. Kept in step with
# `effectDirective` in src/lib/ingest/decision-effects.ts.
_DIRECTIVE = {
    "accepts": "This arrangement has been accepted as satisfying the clause.",
    "rejects": "This arrangement has been ruled insufficient for the clause.",
    "context": (
        "Background the organisation has recorded. It does not settle the clause by itself."
    ),
}


@dataclass
class Decision:
    id: str
    title: str
    statement: str
    rationale: str
    effect: str
    clause_ref: str
    decided_by: str
    # True when this came back from the clause-reference half of the union. An
    # explicit ruling on this clause carries more weight than a near neighbour,
    # and the prompt says so.
    anchored: bool = False

    @property
    def directive(self) -> str:
        return _DIRECTIVE.get(self.effect, _DIRECTIVE["context"])


_ANCHORED = """
SELECT "id", "title", "statement", "rationale", "effect", "clauseRef", "decidedByName"
  FROM "decision"
 WHERE "organisationId" = %(org)s
   AND "status" = 'active'
   AND ("expiresAt" IS NULL OR "expiresAt" > now())
   AND "clauseRef" <> ''
   AND "clauseRef" = %(clause_ref)s
 ORDER BY "createdAt" DESC
 LIMIT %(limit)s
"""

_NEAREST = """
SELECT "id", "title", "statement", "rationale", "effect", "clauseRef", "decidedByName",
       "vector" <=> %(vector)s::vector AS distance
  FROM "decision"
 WHERE "organisationId" = %(org)s
   AND "status" = 'active'
   AND ("expiresAt" IS NULL OR "expiresAt" > now())
   AND "vector" IS NOT NULL
   AND NOT ("id" = ANY(%(exclude)s))
 ORDER BY distance
 LIMIT %(limit)s
"""

# Cosine distance above which a decision is not really about this clause. The
# register is small, and unfiltered neighbours would mean every clause dragging
# in the same three rulings regardless of subject.
#
# Measured against gemini-embedding-001, which packs everything into a narrow
# band — "0.5 means unrelated" is wrong here. Against a decision about key
# rotation: on topic 0.27, adjacent 0.39, unrelated 0.48, nonsense 0.50. Kept in
# step with MAX_DISTANCE in src/lib/ingest/decisions.ts, and worth re-measuring
# if the embedding model changes.
MAX_DISTANCE = 0.42


def _row_to_decision(row: dict, *, anchored: bool) -> Decision:
    return Decision(
        id=row["id"],
        title=row["title"],
        statement=row["statement"],
        rationale=row["rationale"] or "",
        effect=row["effect"],
        clause_ref=row["clauseRef"] or "",
        decided_by=row["decidedByName"] or "",
        anchored=anchored,
    )


def for_clause(
    conn: psycopg.Connection,
    *,
    organisation_id: str,
    clause_ref: str,
    query: str,
    limit: int = 3,
    vector: str | None = None,
) -> list[Decision]:
    """The decisions that should be in front of the model for one clause.

    Capped hard. This runs once per clause across a hundred-odd clauses, so the
    prompt cost of an unbounded register would land on every run.
    """
    found: list[Decision] = []

    if clause_ref:
        rows = db.query(
            conn, _ANCHORED, {"org": organisation_id, "clause_ref": clause_ref, "limit": limit}
        )
        found.extend(_row_to_decision(r, anchored=True) for r in rows)

    if len(found) >= limit or not query.strip():
        return found[:limit]

    if vector is None:
        try:
            vector = embeddings.to_pgvector(embeddings.embed_all([query], "query")[0])
        except Exception as exc:  # noqa: BLE001 — a run must not die over the register
            logs.warn(log, "could not embed clause for decision lookup", error=str(exc)[:160])
            return found[:limit]

    rows = db.query(
        conn,
        _NEAREST,
        {
            "org": organisation_id,
            "vector": vector,
            "exclude": [d.id for d in found],
            "limit": limit - len(found),
        },
    )
    for row in rows:
        if float(row["distance"]) <= MAX_DISTANCE:
            found.append(_row_to_decision(row, anchored=False))

    return found[:limit]


def render(decisions: list[Decision]) -> str:
    """The precedent block, as the model sees it."""
    if not decisions:
        return ""

    blocks = []
    for d in decisions:
        scope = "on this clause" if d.anchored else "on a related clause"
        lines = [
            f"[decision:{d.id}] {d.title} ({scope})",
            f"  Ruling: {d.statement}",
            f"  Effect: {d.directive}",
        ]
        if d.rationale and d.rationale != d.statement:
            lines.append(f"  Reason given: {d.rationale}")
        if d.decided_by:
            lines.append(f"  Decided by: {d.decided_by}")
        blocks.append("\n".join(lines))

    return "\n\n".join(blocks)


def conflicting(decisions: list[Decision]) -> bool:
    """Two decisions pulling opposite ways on the same clause.

    Not resolved here and deliberately not resolved by recency either. A
    register that contradicts itself is a governance problem the customer needs
    to see, and quietly picking the newer one would hide it. The stage turns
    this into `needs_review`.
    """
    effects = {d.effect for d in decisions if d.anchored}
    return "accepts" in effects and "rejects" in effects
