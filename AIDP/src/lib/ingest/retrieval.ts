import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership } from "./org";

/**
 * The only way to search the corpus.
 *
 * Two things are enforced here rather than left to callers:
 *
 *  1. **The tenant filter.** `organisationId` is a required argument and lands
 *     in the SQL predicate, not in a prompt. Membership is checked before the
 *     query runs. There is deliberately no variant of this function without it.
 *
 *  2. **Hybrid retrieval.** Dense vectors plus Postgres full-text, fused. The
 *     analyse stage has to tell "this requirement is genuinely unaddressed"
 *     from "retrieval missed it", and that rests on recall. Dense search alone
 *     is soft on exactly the tokens that matter most in these documents —
 *     "TLS 1.2", "RPO", "snake_case", "MFA".
 */

export type Hit = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string;
  sourceKind: string;
  text: string;
  pageStart: number | null;
  score: number;
  vectorRank: number | null;
  lexicalRank: number | null;
};

export type SearchOptions = {
  userId: string;
  organisationId: string;
  query: string;
  limit?: number;
  /** Narrow to specific documents — how the analyse stage scopes to one submission. */
  documentIds?: string[];
  /**
   * Classifications the caller may see. Data Standards §8.1 defines the tiers;
   * omitting this returns everything the organisation holds, which is only
   * right for an internal consultant view.
   */
  sensitivities?: string[];
};

/** Reciprocal Rank Fusion constant. 60 is the value from the original paper. */
const RRF_K = 60;

/**
 * Embed text.
 *
 * Asymmetric on providers that support it: a question and a passage are
 * embedded differently, and getting `input_type` backwards degrades retrieval
 * quietly rather than loudly. Kept in step with Workers/aidp/ai/embeddings.py.
 *
 * `kind` is which side of that asymmetry the caller is on. Search queries are
 * "query"; anything stored to be *found* by a query — a passage, or a standing
 * decision in the register — is "passage".
 */
export async function embedText(
  text: string,
  kind: "query" | "passage" = "query",
): Promise<number[]> {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "gemini").toLowerCase();
  const model = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";
  const dims = Number(process.env.EMBEDDING_DIMS ?? 1024);

  if (provider === "gemini") {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          outputDimensionality: dims,
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini embeddings failed: ${res.status}`);
    const json = (await res.json()) as { embedding: { values: number[] } };
    return json.embedding.values;
  }

  if (provider === "voyage") {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error("VOYAGE_API_KEY is not set");
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: [text], input_type: kind === "query" ? "query" : "document" }),
    });
    if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data[0]!.embedding;
  }

  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set");
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: [text], dimensions: dims }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data[0]!.embedding;
  }

  throw new Error(`Unknown EMBEDDING_PROVIDER: ${provider}`);
}

export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function search(options: SearchOptions): Promise<Hit[]> {
  const { userId, organisationId, query, limit = 12 } = options;
  await requireMembership(userId, organisationId);
  if (!query.trim()) return [];

  const vector = toVectorLiteral(await embedText(query, "query"));
  const model = process.env.EMBEDDING_MODEL ?? "voyage-3";
  // Fuse from a wider candidate pool than we return, or the two rankings barely
  // overlap and fusion has nothing to work with.
  const pool = Math.max(limit * 4, 40);

  const documentFilter = options.documentIds?.length
    ? Prisma.sql`AND c."documentId" = ANY(${options.documentIds})`
    : Prisma.empty;
  const sensitivityFilter = options.sensitivities?.length
    ? Prisma.sql`AND (c."sensitivity" IS NULL OR c."sensitivity" = ANY(${options.sensitivities}))`
    : Prisma.empty;

  return prisma.$transaction(async (tx) => {
    // HNSW does not pre-filter: it walks the graph and *then* discards rows
    // failing the WHERE clause, so a tight organisation predicate can return
    // fewer than k rows. pgvector 0.8 keeps scanning until k survivors are
    // found. Neon ships 0.8.1, which is what makes this available.
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);

    return tx.$queryRaw<Hit[]>`
      WITH dense AS (
        SELECT c."id",
               ROW_NUMBER() OVER (ORDER BY e."vector" <=> ${vector}::vector) AS rank
          FROM "chunk" c
          JOIN "embedding" e ON e."chunkId" = c."id" AND e."model" = ${model}
         WHERE c."organisationId" = ${organisationId}
           ${documentFilter}
           ${sensitivityFilter}
         ORDER BY e."vector" <=> ${vector}::vector
         LIMIT ${pool}
      ),
      lexical AS (
        SELECT c."id",
               ROW_NUMBER() OVER (
                 ORDER BY ts_rank_cd(
                   aidp_chunk_vector(c."headingPath", c."text"), q.query
                 ) DESC
               ) AS rank
          FROM "chunk" c
         -- Defined in migration 20260807090000_lexical_weighting, and shared
         -- with Workers/aidp/retrieval.py rather than restated here — these two
         -- queries drifted apart once already. aidp_search_query ORs the
         -- lexemes and strips corpus-wide filler ('data', 'must', 'standard');
         -- aidp_chunk_vector weights the heading path above the body and is
         -- the expression chunk_fts_idx is built on, so it must match exactly
         -- or the index goes unused.
         CROSS JOIN (SELECT aidp_search_query(${query}) AS query) q
         WHERE c."organisationId" = ${organisationId}
           AND aidp_chunk_vector(c."headingPath", c."text") @@ q.query
           ${documentFilter}
           ${sensitivityFilter}
         LIMIT ${pool}
      ),
      fused AS (
        SELECT COALESCE(d."id", l."id") AS id,
               COALESCE(1.0 / (${RRF_K} + d.rank), 0)
             + COALESCE(1.0 / (${RRF_K} + l.rank), 0) AS score,
               d.rank AS vector_rank,
               l.rank AS lexical_rank
          FROM dense d
          FULL OUTER JOIN lexical l ON l."id" = d."id"
      )
      SELECT c."id"            AS "chunkId",
             c."documentId"    AS "documentId",
             doc."title"       AS "documentTitle",
             c."headingPath"   AS "headingPath",
             c."sourceKind"    AS "sourceKind",
             c."text"          AS "text",
             c."pageStart"     AS "pageStart",
             f.score::float8   AS "score",
             f.vector_rank::int  AS "vectorRank",
             f.lexical_rank::int AS "lexicalRank"
        FROM fused f
        JOIN "chunk" c ON c."id" = f.id
        JOIN "document" doc ON doc."id" = c."documentId"
       ORDER BY f.score DESC
       LIMIT ${limit}
    `;
  });
}
