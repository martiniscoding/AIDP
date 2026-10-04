"""Hybrid retrieval, for the analyse stage.

Mirrors src/lib/ingest/retrieval.ts. The two have to agree, because the app
embeds questions and this embeds reference clauses against the same vectors —
divergence would show up as quietly worse results rather than as an error.

Dense vectors plus Postgres full-text, fused with Reciprocal Rank Fusion. Both
halves matter here more than anywhere else in the system: the analyse stage has
to tell "this requirement is genuinely unaddressed" from "retrieval missed it",
and that rests entirely on recall. Dense search is soft on exactly the tokens
these documents turn on — "TLS 1.2", "RPO", "snake_case", "MFA".
"""

from __future__ import annotations

import re

from dataclasses import dataclass

import psycopg

from . import db
from .ai import embeddings
from .config import get_config

# Reciprocal Rank Fusion constant, from the original paper.
RRF_K = 60


@dataclass
class Candidate:
    chunk_id: str
    heading_path: str
    text: str
    page_start: int | None
    score: float
    vector_rank: int | None
    lexical_rank: int | None
    # Where the passage came from. "figure" means it is a *model's reading of a
    # diagram*, not text lifted off the page — which the judge is told, and
    # which the guards in analyse.py refuse to let decide a verdict alone.
    source_kind: str = "clause"
    # The row this chunk was derived from. For a figure that is the figure id,
    # which is what lets a finding render the diagram beside the model's reading
    # of it — verification at the point of use rather than at ingest.
    source_id: str | None = None
    # Which design this passage is from. A project run searches every design in
    # the project at once, so "page 4" is only an address when the document is
    # named beside it — and a finding has to tell the reviewer which file to
    # open. Defaulted so a single-design caller need not pass it.
    document_id: str = ""
    document_title: str = ""

    @property
    def is_generated(self) -> bool:
        return self.source_kind == "figure"

    @property
    def excerpt(self) -> str:
        """The passage as a reviewer will read it.

        Prose can have its line breaks collapsed — a PDF wraps mid-sentence and
        those breaks mean nothing. A table's rows are the opposite: which value
        sits in which column *is* the content. Collapsing them fuses the last
        cell of one row onto the first of the next ("Example Table",
        "CustomerOrders Column"), and the result cannot be untangled afterwards
        because the join is indistinguishable from a two-word cell.
        """
        if self.source_kind in ("table", "table_row"):
            body = "\n".join(
                " ".join(line.split()) for line in self.text.splitlines() if line.strip()
            )
        else:
            body = " ".join(self.text.split())
        return body if len(body) <= 700 else body[:700] + "…"


_SEARCH = """
WITH dense AS (
    SELECT c."id",
           ROW_NUMBER() OVER (ORDER BY e."vector" <=> %(vector)s::vector) AS rank
      FROM "chunk" c
      JOIN "embedding" e ON e."chunkId" = c."id" AND e."model" = %(model)s
     WHERE c."organisationId" = %(org)s
       AND c."documentId" = ANY(%(docs)s)
     ORDER BY e."vector" <=> %(vector)s::vector
     LIMIT %(pool)s
),
lexical AS (
    SELECT c."id",
           ROW_NUMBER() OVER (
             ORDER BY ts_rank_cd(
               aidp_chunk_vector(c."headingPath", c."text"), q.query
             ) DESC
           ) AS rank
      FROM "chunk" c
     -- Both functions are defined in the migration, not here, because
     -- src/lib/ingest/retrieval.ts runs the same search over the same index and
     -- the two had already drifted once. `aidp_search_query` ORs the lexemes
     -- (a clause AND-ed matches nothing) and drops the corpus-wide filler that
     -- made the query match most of a document; `aidp_chunk_vector` weights the
     -- heading path above the body and is what the GIN index is built on.
     --
     -- Never write a percent sign anywhere in this string, comments included.
     -- psycopg scans the whole statement for placeholders, so a stray one
     -- either fails as a truncated placeholder or, worse, parses as a real
     -- named one with no matching parameter. Both fail at execute time rather
     -- than at import, so a comment can break retrieval in production. Spell
     -- the word out instead.
     CROSS JOIN (SELECT aidp_search_query(%(query)s) AS query) q
     WHERE c."organisationId" = %(org)s
       AND c."documentId" = ANY(%(docs)s)
       AND aidp_chunk_vector(c."headingPath", c."text") @@ q.query
     LIMIT %(pool)s
),
fused AS (
    SELECT COALESCE(d."id", l."id") AS id,
           COALESCE(1.0 / (%(k)s + d.rank), 0)
         + COALESCE(1.0 / (%(k)s + l.rank), 0) AS score,
           d.rank AS vector_rank,
           l.rank AS lexical_rank
      FROM dense d
      FULL OUTER JOIN lexical l ON l."id" = d."id"
)
SELECT c."id", c."documentId", c."headingPath", c."text", c."pageStart",
       c."sourceKind", c."sourceId",
       f.score::float8 AS score, f.vector_rank, f.lexical_rank
  FROM fused f
  JOIN "chunk" c ON c."id" = f.id
 ORDER BY f.score DESC
 LIMIT %(limit)s
"""


def embed_query(query: str) -> str:
    """A query as a pgvector literal.

    Exposed so one clause can be embedded once and the vector shared between
    passage retrieval and the decision lookup, rather than paying the provider
    twice for the same string on every clause of every run.
    """
    return embeddings.to_pgvector(embeddings.embed_all([query], "query")[0])


def search_document(
    conn: psycopg.Connection,
    *,
    organisation_id: str,
    document_id: str,
    query: str,
    limit: int = 8,
    vector: str | None = None,
) -> list[Candidate]:
    """Best passages in one document for one query. See `search`."""
    return search(
        conn,
        organisation_id=organisation_id,
        document_ids=[document_id],
        query=query,
        limit=limit,
        vector=vector,
    )


def search(
    conn: psycopg.Connection,
    *,
    organisation_id: str,
    document_ids: list[str],
    query: str,
    limit: int = 8,
    vector: str | None = None,
    titles: dict[str, str] | None = None,
) -> list[Candidate]:
    """Best passages across one or more designs for one query.

    More than one when a project is assessed as a whole: a solution described
    across a proposal, an architecture deck and a data model is one design, and
    a clause answered in the second file is not a gap in the first.

    Each design is searched for its own window rather than all of them for one
    shared window, and this is the whole point. Fusion scores a passage against
    the other passages it is ranked with, so one shared window of eight goes to
    whichever design has the most text: on a real project the 52-chunk proposal
    took all eight slots and the 18-chunk telemetry design was never shown, so a
    clause it answered outright came back absent — the exact failure assessing a
    project together exists to fix, moved rather than removed. A design searched
    on its own is shown the passages it would have been shown had it been
    assessed alone, so the project's verdict can only be as good as the best of
    the individual ones.

    `titles` names the designs for the judge; a passage from a document not in
    it keeps an empty title rather than failing.

    `organisation_id` is required and lands in the predicate even though the
    document ids alone would be selective enough. Belt and braces: ids arriving
    from a job payload are not a capability check, and the tenant filter should
    be present on every path that reads chunks.
    """
    if not query.strip() or not document_ids:
        return []
    if vector is None:
        vector = embed_query(query)

    names = titles or {}
    if len(document_ids) == 1:
        return _in_one(conn, organisation_id, document_ids[0], query, limit, vector, names)

    windows = [
        _in_one(conn, organisation_id, document_id, query, limit, vector, names)
        for document_id in document_ids
    ]
    return _woven(windows, limit)


# The most passages a judge is shown for one clause, however many designs a
# project holds. Each design's best passage is in before any design's second,
# so a design is never silent; past this the tail is dropped.
MAX_PASSAGES = 24


def _woven(windows: list[list[Candidate]], limit: int) -> list[Candidate]:
    """Every design's window, best first, round by round.

    Round-robin rather than by score: a score is only comparable inside the
    search that produced it, and sorting the designs' windows together would
    hand the slots back to the largest design. The order still puts the best
    passages first, which is what the judge reads first.
    """
    out: list[Candidate] = []
    budget = min(MAX_PASSAGES, max(limit, limit * len(windows)))
    for rank in range(max((len(w) for w in windows), default=0)):
        for window in windows:
            if rank < len(window):
                out.append(window[rank])
                if len(out) >= budget:
                    return out
    return out


def _in_one(
    conn: psycopg.Connection,
    organisation_id: str,
    document_id: str,
    query: str,
    limit: int,
    vector: str,
    titles: dict[str, str],
) -> list[Candidate]:
    """One design's best passages, fused and with room kept for a diagram."""
    cfg = get_config()

    # HNSW discards non-matching rows *after* walking the graph, so a filter as
    # tight as a single document can starve the result set. pgvector 0.8 keeps
    # scanning until k survivors are found.
    with conn.cursor() as cur:
        cur.execute("SET LOCAL hnsw.iterative_scan = 'relaxed_order'")

    rows = db.query(
        conn,
        _SEARCH,
        {
            "vector": vector,
            "model": cfg.embedding_model,
            "org": organisation_id,
            "docs": [document_id],
            "query": query,
            # Fuse from a wider pool than we return, or the two rankings barely
            # overlap and fusion has nothing to work with.
            "pool": max(limit * 4, 32),
            # Read past the window so `with_figure` has somewhere to find a
            # diagram that fused just outside it. Trimmed back to `limit` below.
            "limit": max(limit * 2, limit + FIGURE_LOOKAHEAD),
            "k": RRF_K,
        },
    )

    candidates = [
        Candidate(
            chunk_id=r["id"],
            document_id=r["documentId"],
            document_title=titles.get(r["documentId"], ""),
            heading_path=r["headingPath"],
            text=r["text"],
            page_start=r["pageStart"],
            score=float(r["score"] or 0),
            vector_rank=r["vector_rank"],
            lexical_rank=r["lexical_rank"],
            source_kind=r["sourceKind"],
            source_id=r["sourceId"],
        )
        for r in rows
    ]
    return with_figure(candidates, query, limit)


# How far past the window to look for a diagram worth carrying into it.
FIGURE_LOOKAHEAD = 8

# A word shorter than this carries no subject matter. Same floor as the figure
# guard in analyse.py, and for the same reason.
_KEYWORD_MIN_CHARS = 4

_WORD = re.compile(r"[a-z0-9]+")


def _keywords(text: str) -> set[str]:
    return {w for w in _WORD.findall((text or "").lower()) if len(w) >= _KEYWORD_MIN_CHARS}


def with_figure(candidates: list[Candidate], query: str, limit: int) -> list[Candidate]:
    """The top `limit` passages, keeping room for a diagram that belongs with them.

    Fusion ranks a diagram description against prose, and on a long document the
    prose wins: a 96-page design has hundreds of paragraphs and a handful of
    figures, so the figure is pushed out of the window even when the capability
    the clause asks about is drawn rather than written. The judge then reads
    eight paragraphs about other things and reports the clause absent.

    So when the window is all text, one figure is carried into it — but only a
    figure that earns the place: it has to sit on a page the window already
    reached, and share a substantive word with the clause. Both conditions
    matter. Without the page it is any diagram in the document; without the
    word it is a diagram about something else, which is what the guards in
    analyse.py spend their time refusing.

    The lowest-ranked text passage makes way, so the judge sees no more than it
    did before.
    """
    window = candidates[:limit]
    if limit <= 1 or any(c.is_generated for c in window):
        return window

    # Addressed by (design, page) and (design, heading), never by page alone.
    # Across a project every design has a page 4 and most have an "Architecture"
    # heading, and a diagram is only "on a page the window already reached" if
    # it is in the same document as that page.
    pages = {(c.document_id, c.page_start) for c in window if c.page_start is not None}
    headings = {(c.document_id, c.heading_path) for c in window if c.heading_path}
    wanted = _keywords(query)

    for candidate in candidates[limit:]:
        if not candidate.is_generated:
            continue
        near = (candidate.document_id, candidate.page_start) in pages or (
            candidate.document_id,
            candidate.heading_path,
        ) in headings
        if near and wanted & _keywords(candidate.text):
            return window[: limit - 1] + [candidate]
    return window


def clause_query(statement: str, requirements: list[str], title: str | None) -> str:
    """Turn a reference clause into a search query.

    The requirements bullets carry most of the useful vocabulary — they are
    where the concrete nouns live ("dead-letter queue", "TLS 1.2", "recovery
    point objective"), and those are what the other document will actually say.
    The statement alone is usually too abstract to match anything.
    """
    parts = [p for p in [title, statement, *requirements] if p]
    query = " ".join(parts)
    # plainto_tsquery copes with long input, but the embedding call does not
    # need the whole thing and the tail adds nothing.
    return query[:2000]
