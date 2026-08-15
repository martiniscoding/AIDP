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
       AND c."documentId" = %(doc)s
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
       AND c."documentId" = %(doc)s
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
SELECT c."id", c."headingPath", c."text", c."pageStart", c."sourceKind", c."sourceId",
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
    """Best passages in one document for one query.

    `organisation_id` is required and lands in the predicate even though
    `document_id` alone would be selective enough. Belt and braces: a document
    id arriving from a job payload is not a capability check, and the tenant
    filter should be present on every path that reads chunks.
    """
    if not query.strip():
        return []

    cfg = get_config()
    if vector is None:
        vector = embed_query(query)

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
            "doc": document_id,
            "query": query,
            # Fuse from a wider pool than we return, or the two rankings barely
            # overlap and fusion has nothing to work with.
            "pool": max(limit * 4, 32),
            "limit": limit,
            "k": RRF_K,
        },
    )

    return [
        Candidate(
            chunk_id=r["id"],
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
