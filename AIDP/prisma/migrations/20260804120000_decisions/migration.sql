-- AlterTable
ALTER TABLE "finding" ADD COLUMN     "appliedDecisions" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "decision" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "rationale" TEXT NOT NULL DEFAULT '',
    "effect" TEXT NOT NULL DEFAULT 'context',
    "clauseId" TEXT,
    "clauseRef" TEXT NOT NULL DEFAULT '',
    "clauseTitle" TEXT NOT NULL DEFAULT '',
    "sourceFindingId" TEXT,
    "sourceRunId" TEXT,
    "sourceDocumentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "supersededById" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedByName" TEXT NOT NULL DEFAULT '',
    "vector" vector(1024),
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decision_supersededById_key" ON "decision"("supersededById");

-- CreateIndex
CREATE INDEX "decision_organisationId_status_idx" ON "decision"("organisationId", "status");

-- CreateIndex
CREATE INDEX "decision_organisationId_clauseRef_idx" ON "decision"("organisationId", "clauseRef");

-- AddForeignKey
ALTER TABLE "decision" ADD CONSTRAINT "decision_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision" ADD CONSTRAINT "decision_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision" ADD CONSTRAINT "decision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
