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

    @property
    def excerpt(self) -> str:
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
             ORDER BY ts_rank_cd(to_tsvector('english', c."text"), q.query) DESC
           ) AS rank
      FROM "chunk" c
     CROSS JOIN (
       -- OR, not AND. plainto_tsquery joins every lexeme with '&', and a query
       -- built from a whole clause carries a dozen of them — requiring all to
       -- co-occur inside one document returns nothing at all, which is exactly
       -- what it did: every hit came back dense-only.
       SELECT replace(plainto_tsquery('english', %(query)s)::text, '&', '|')::tsquery AS query
     ) q
     WHERE c."organisationId" = %(org)s
       AND c."documentId" = %(doc)s
       AND to_tsvector('english', c."text") @@ q.query
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
SELECT c."id", c."headingPath", c."text", c."pageStart",
       f.score::float8 AS score, f.vector_rank, f.lexical_rank
  FROM fused f
  JOIN "chunk" c ON c."id" = f.id
 ORDER BY f.score DESC
 LIMIT %(limit)s
"""


def search_document(
    conn: psycopg.Connection,
    *,
    organisation_id: str,
    document_id: str,
    query: str,
    limit: int = 8,
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
    vector = embeddings.to_pgvector(embeddings.embed_all([query], "query")[0])

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
