-- A standard's rules, read by a model and checked by code.
--
-- The model only points: it sees the document as numbered lines and answers
-- with line numbers. These tables keep the evidence behind every rule — the
-- text exactly as read, each reading and why it was or was not believed, and
-- every range set aside as not a rule with the model's stated reason — so a
-- reviewer can see why a line is or is not a rule, and restore one that should
-- have been.
--
-- Additive only. Existing clauses read as origin 'parser', which is what they
-- are, and nothing already stored changes meaning.

-- AlterTable
ALTER TABLE "clause" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'parser',
ADD COLUMN     "sourceRefs" JSONB;

-- CreateTable
CREATE TABLE "source_line" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "page" INTEGER,
    "text" TEXT NOT NULL,
    "sectionOrdinal" INTEGER,
    "depth" INTEGER,

    CONSTRAINT "source_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_extraction" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "adopted" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "error" TEXT,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "calls" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_extraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "line_label" (
    "id" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "fromOrdinal" INTEGER NOT NULL,
    "toOrdinal" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "restoredAt" TIMESTAMP(3),
    "restoredBy" TEXT,
    "restoredClauseId" TEXT,

    CONSTRAINT "line_label_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_line_documentId_ordinal_key" ON "source_line"("documentId", "ordinal");

-- CreateIndex
CREATE INDEX "rule_extraction_documentId_idx" ON "rule_extraction"("documentId");

-- CreateIndex
CREATE INDEX "line_label_documentId_idx" ON "line_label"("documentId");

-- CreateIndex
CREATE INDEX "line_label_extractionId_idx" ON "line_label"("extractionId");

-- AddForeignKey
ALTER TABLE "source_line" ADD CONSTRAINT "source_line_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_extraction" ADD CONSTRAINT "rule_extraction_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_label" ADD CONSTRAINT "line_label_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "rule_extraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_label" ADD CONSTRAINT "line_label_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
