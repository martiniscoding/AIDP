-- Sharpen the lexical half of hybrid retrieval.
--
-- Two problems, both measured on the live corpus with one clause (Data
-- Standards 6.3 Encryption) against one design (Customer Portal Modernisation,
-- 28 chunks):
--
--   1. The query admitted 17 of 28 chunks — 60% of the document. A clause
--      flattened into a tsquery carries three dozen lexemes, and after the '&'
--      is swapped for '|' any single one is enough to match. The ones doing the
--      matching were 'data', 'must', 'use' and 'standard', which appear in
--      nearly every chunk of a compliance corpus and discriminate nothing. The
--      word 'data' alone matched 7 chunks on its own.
--
--   2. Every lexeme was weighted equally, so 'tls' and '1.2' — the terms that
--      actually decide whether a passage is about encryption — counted for no
--      more than 'data'.
--
-- Both fixes live here as functions rather than in the two callers, because
-- there ARE two callers: Workers/aidp/retrieval.py assesses, and
-- src/lib/ingest/retrieval.ts searches the library. They had already drifted
-- once and carried a comment asking a human to keep them in step. A definition
-- in the database cannot drift.

-- The stop list.
--
-- Deliberately narrow. Every word here is one that appears across essentially
-- every clause AND every chunk of this corpus, so its presence in a match
-- carries no information: obligation verbs that open every rule, the generic
-- nouns of governance prose, and the filler adjectives of specification
-- writing. Domain nouns that *look* generic but discriminate — 'access',
-- 'key', 'network', 'log' — are deliberately absent.
--
-- 'data' and 'system' are the aggressive entries and the reason the fallback
-- below exists: in a data-standards corpus they are pure noise, but a clause
-- consisting of little else would otherwise reduce to nothing.
CREATE OR REPLACE FUNCTION aidp_search_query(input text)
RETURNS tsquery
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    -- Preferred: the clause with corpus-wide filler removed.
    NULLIF(
      replace(
        plainto_tsquery(
          'english',
          regexp_replace(
            lower(coalesce(input, '')),
            '\m(must|shall|should|may|will|can|standard|standards|requirement|requirements|'
            'policy|policies|guideline|guidelines|document|documents|documented|documentation|'
            'use|used|using|ensure|ensures|ensuring|provide|provides|provided|include|includes|'
            'including|apply|applies|applied|maintain|maintained|define|defines|defined|'
            'appropriate|relevant|applicable|necessary|current|currently|equivalent|'
            'data|system|systems|information|organisation|organization|process|processes)\M',
            ' ',
            'g'
          )
        )::text,
        '&',
        '|'
      ),
      ''
    )::tsquery,
    -- Fallback: a clause made entirely of stop words is rare but must still
    -- search for something. A weak query beats an empty one, which would drop
    -- the lexical half of the fusion and silently make retrieval dense-only —
    -- the exact failure the '&' to '|' swap was introduced to fix.
    replace(plainto_tsquery('english', coalesce(input, ''))::text, '&', '|')::tsquery
  )
$$;

-- The document side, weighted.
--
-- The heading path is the strongest short signal a chunk carries: a passage
-- filed under "4.3 Transport and Storage Encryption" is about encryption
-- whatever its prose does. Weight A against D gives it ten times the rank
-- contribution under ts_rank_cd's default weights, without excluding anything.
--
-- The path is already prepended to `text` by the chunk stage, so it is counted
-- twice on purpose — once weighted, once as ordinary body.
CREATE OR REPLACE FUNCTION aidp_chunk_vector(heading text, body text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('english', coalesce(heading, '')), 'A')
      || setweight(to_tsvector('english', coalesce(body, '')), 'D')
$$;

-- Re-point the index at the weighted vector. An index on the old expression
-- would simply never be used again: a GIN expression index only serves queries
-- whose expression matches it exactly.
DROP INDEX IF EXISTS "chunk_fts_idx";

CREATE INDEX "chunk_fts_idx"
    ON "chunk" USING GIN (aidp_chunk_vector("headingPath", "text"));
