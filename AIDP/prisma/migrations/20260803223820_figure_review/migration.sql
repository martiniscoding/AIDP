-- AlterTable
ALTER TABLE "figure" ADD COLUMN     "complexity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "correctedDescription" TEXT,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewState" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "reviewedAt" TIMESTAMP(3);

-- The review queue: figures still awaiting a human, hardest first. Partial,
-- because once a library has been worked through most figures are confirmed and
-- there is no reason to keep them in this index.
CREATE INDEX "figure_pending_review_idx"
    ON "figure" ("complexity" DESC)
    WHERE "reviewState" = 'pending';
