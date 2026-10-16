-- Make project assessment scope explicit. Existing projects describe one
-- solution assembled from several documents unless their owner chooses
-- alternative candidates in the project form.
ALTER TABLE "project"
  ADD COLUMN "designRelationship" TEXT NOT NULL DEFAULT 'components';

ALTER TABLE "project"
  ADD CONSTRAINT "project_designRelationship_check"
  CHECK ("designRelationship" IN ('components', 'alternatives'));

-- Runs snapshot their design relationship so a resumed assessment cannot be
-- silently reinterpreted after somebody edits the project settings.
ALTER TABLE "assessment_run"
  ADD COLUMN "designIds" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "unreadyDesignIds" TEXT[] NOT NULL DEFAULT '{}';

-- A project assessment can now hold one result per clause per design. Preserve
-- historical project-wide findings with designKey='', and backfill single-
-- design findings to their assessed document so they remain attributable.
ALTER TABLE "finding"
  ADD COLUMN "documentId" TEXT,
  ADD COLUMN "designKey" TEXT NOT NULL DEFAULT '';

UPDATE "finding" AS f
   SET "documentId" = r."documentId",
       "designKey" = COALESCE(r."documentId", '')
  FROM "assessment_run" AS r
 WHERE f."runId" = r."id"
   AND r."documentId" IS NOT NULL;

-- Severity is no longer derived from the model's self-rated confidence. Keep
-- older pending absences below the former 0.7 settled threshold from being
-- promoted to a critical finding just because their obligation is mandatory.
UPDATE "finding"
   SET "verdict" = 'needs_review',
       "rationale" = left(
         'This historical absence was below the previous confidence threshold and needs review. '
         || "rationale",
         5000
       )
 WHERE "verdict" = 'absent'
   AND "confidence" < 0.7
   AND "reviewerState" = 'pending';

ALTER TABLE "finding"
  DROP CONSTRAINT IF EXISTS "finding_runId_clauseId_key";

DROP INDEX IF EXISTS "finding_runId_clauseId_key";

ALTER TABLE "finding"
  ADD CONSTRAINT "finding_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "document"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "finding_runId_clauseId_designKey_key"
  ON "finding"("runId", "clauseId", "designKey");

CREATE INDEX "finding_runId_documentId_idx"
  ON "finding"("runId", "documentId");

-- A run records the relationship it was judged under, so a report stays
-- interpretable after the project's owner changes that setting. Defaulted to
-- 'components' because every run recorded before this read its designs as
-- parts of one solution.
ALTER TABLE "assessment_run"
  ADD COLUMN "designRelationship" TEXT NOT NULL DEFAULT 'components';

ALTER TABLE "assessment_run"
  ADD CONSTRAINT "assessment_run_designRelationship_check"
  CHECK ("designRelationship" IN ('components', 'alternatives'));
