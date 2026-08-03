-- DropIndex
DROP INDEX "embedding_vector_hnsw_idx";

-- CreateTable
CREATE TABLE "framework" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isBaseline" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_document" (
    "frameworkId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "framework_document_pkey" PRIMARY KEY ("frameworkId","documentId")
);

-- CreateTable
CREATE TABLE "assessment_run" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "totalClauses" INTEGER NOT NULL DEFAULT 0,
    "completedClauses" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "assessment_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "clauseId" TEXT NOT NULL,
    "clauseRef" TEXT NOT NULL,
    "clauseTitle" TEXT NOT NULL DEFAULT '',
    "clauseStatement" TEXT NOT NULL DEFAULT '',
    "verdict" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rationale" TEXT NOT NULL DEFAULT '',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "retrievalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewerState" TEXT NOT NULL DEFAULT 'pending',
    "reviewerVerdict" TEXT,
    "reviewerNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "framework_organisationId_idx" ON "framework"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "framework_organisationId_name_version_key" ON "framework"("organisationId", "name", "version");

-- CreateIndex
CREATE INDEX "framework_document_documentId_idx" ON "framework_document"("documentId");

-- CreateIndex
CREATE INDEX "assessment_run_organisationId_state_idx" ON "assessment_run"("organisationId", "state");

-- CreateIndex
CREATE INDEX "assessment_run_documentId_idx" ON "assessment_run"("documentId");

-- CreateIndex
CREATE INDEX "finding_runId_verdict_idx" ON "finding"("runId", "verdict");

-- CreateIndex
CREATE UNIQUE INDEX "finding_runId_clauseId_key" ON "finding"("runId", "clauseId");

-- AddForeignKey
ALTER TABLE "framework" ADD CONSTRAINT "framework_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_document" ADD CONSTRAINT "framework_document_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "framework"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_document" ADD CONSTRAINT "framework_document_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_run" ADD CONSTRAINT "assessment_run_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_run" ADD CONSTRAINT "assessment_run_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_run" ADD CONSTRAINT "assessment_run_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "framework"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "assessment_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
