-- pgvector must exist before the `vector(1024)` column below is created.
-- Neon ships 0.8.1, which is what makes iterative index scans available — see
-- the partial-filter note on the HNSW index at the foot of this file.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "organisation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'consultant',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'reference',
    "title" TEXT NOT NULL,
    "docCode" TEXT,
    "version" TEXT,
    "effectiveDate" TEXT,
    "sensitivity" TEXT,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "pageCount" INTEGER,
    "profile" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_section" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "numberText" TEXT,
    "title" TEXT NOT NULL,
    "headingPath" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 1,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "introText" TEXT NOT NULL DEFAULT '',
    "isEmpty" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "document_section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clause" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT,
    "statement" TEXT NOT NULL DEFAULT '',
    "rationale" TEXT NOT NULL DEFAULT '',
    "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "guidance" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pageStart" INTEGER,
    "pageEnd" INTEGER,

    CONSTRAINT "clause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_block" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "clauseId" TEXT,
    "ordinal" INTEGER NOT NULL,
    "caption" TEXT,
    "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rows" JSONB NOT NULL DEFAULT '[]',
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,

    CONSTRAINT "table_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "figure" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,
    "bbox" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "storageKey" TEXT NOT NULL,
    "caption" TEXT,
    "description" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "figure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunk" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT,
    "ordinal" INTEGER NOT NULL,
    "headingPath" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "sensitivity" TEXT,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "contentHash" TEXT NOT NULL,

    CONSTRAINT "chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embedding" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "vector" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "correlationId" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_issue" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "page" INTEGER,
    "sectionRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisation_slug_key" ON "organisation"("slug");

-- CreateIndex
CREATE INDEX "membership_organisationId_idx" ON "membership"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_userId_organisationId_key" ON "membership"("userId", "organisationId");

-- CreateIndex
CREATE INDEX "document_organisationId_status_idx" ON "document"("organisationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "document_organisationId_sha256_key" ON "document"("organisationId", "sha256");

-- CreateIndex
CREATE INDEX "document_section_documentId_idx" ON "document_section"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "document_section_documentId_ordinal_key" ON "document_section"("documentId", "ordinal");

-- CreateIndex
CREATE INDEX "clause_sectionId_idx" ON "clause"("sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "clause_sectionId_ordinal_key" ON "clause"("sectionId", "ordinal");

-- CreateIndex
CREATE INDEX "table_block_sectionId_idx" ON "table_block"("sectionId");

-- CreateIndex
CREATE INDEX "figure_sectionId_idx" ON "figure"("sectionId");

-- CreateIndex
CREATE INDEX "chunk_organisationId_idx" ON "chunk"("organisationId");

-- CreateIndex
CREATE INDEX "chunk_documentId_idx" ON "chunk"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "chunk_documentId_ordinal_key" ON "chunk"("documentId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "embedding_chunkId_model_key" ON "embedding"("chunkId", "model");

-- CreateIndex
CREATE INDEX "job_stage_state_runAfter_idx" ON "job"("stage", "state", "runAfter");

-- CreateIndex
CREATE INDEX "job_state_leaseUntil_idx" ON "job"("state", "leaseUntil");

-- CreateIndex
CREATE INDEX "job_documentId_idx" ON "job"("documentId");

-- CreateIndex
CREATE INDEX "ingest_issue_documentId_severity_idx" ON "ingest_issue"("documentId", "severity");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_section" ADD CONSTRAINT "document_section_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clause" ADD CONSTRAINT "clause_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "document_section"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_block" ADD CONSTRAINT "table_block_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "document_section"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_block" ADD CONSTRAINT "table_block_clauseId_fkey" FOREIGN KEY ("clauseId") REFERENCES "clause"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "figure" ADD CONSTRAINT "figure_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "document_section"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "chunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_issue" ADD CONSTRAINT "ingest_issue_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Indexes Prisma cannot express
-- ---------------------------------------------------------------------------

-- Vector search. Cosine distance matches how the embedding providers we target
-- normalise their output.
--
-- HNSW does not pre-filter: it walks the graph and *then* discards rows failing
-- the WHERE clause, so a tight `organisationId` predicate can return fewer than
-- k rows. pgvector 0.8 fixes this with iterative scan, which keeps scanning
-- until k survivors are found. Retrieval sets `hnsw.iterative_scan = relaxed_order`
-- per transaction; see src/lib/ingest/retrieval.ts.
CREATE INDEX "embedding_vector_hnsw_idx"
    ON "embedding" USING hnsw ("vector" vector_cosine_ops);

-- Lexical half of hybrid retrieval. An expression index rather than a stored
-- generated column, so Prisma sees no drift.
--
-- Dense retrieval is soft on exactly the tokens that matter most here — "TLS
-- 1.2", "RPO", "snake_case", "MFA". Absence detection in the analyse stage
-- rests on recall, so both halves ship together rather than BM25 arriving later
-- and every threshold needing a retune.
CREATE INDEX "chunk_fts_idx"
    ON "chunk" USING GIN (to_tsvector('english', "text"));

-- Queue: idempotency. One live job per document per stage, so a double-submit
-- or a retried enqueue cannot put the same work in the queue twice.
CREATE UNIQUE INDEX "job_live_document_stage_idx"
    ON "job" ("documentId", "stage")
    WHERE "state" IN ('queued', 'leased');

-- Queue: the claim path. Partial, because claimers only ever look at queued
-- rows and this keeps the index small enough to stay hot.
CREATE INDEX "job_claimable_idx"
    ON "job" ("stage", "runAfter")
    WHERE "state" = 'queued';

-- Queue: the reaper's sweep for expired leases.
CREATE INDEX "job_expired_lease_idx"
    ON "job" ("leaseUntil")
    WHERE "state" = 'leased';
