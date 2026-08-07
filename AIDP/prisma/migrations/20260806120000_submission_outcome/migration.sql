-- CreateTable
CREATE TABLE "submission_outcome" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "decidedById" TEXT,
    "decidedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_outcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "submission_outcome_organisationId_createdAt_idx" ON "submission_outcome"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "submission_outcome_documentId_createdAt_idx" ON "submission_outcome"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "submission_outcome_runId_idx" ON "submission_outcome"("runId");

-- AddForeignKey
ALTER TABLE "submission_outcome" ADD CONSTRAINT "submission_outcome_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_outcome" ADD CONSTRAINT "submission_outcome_runId_fkey" FOREIGN KEY ("runId") REFERENCES "assessment_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_outcome" ADD CONSTRAINT "submission_outcome_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
