-- A project assessment is signed off as one piece of work, so its outcome names
-- the project rather than a design. No foreign key on "projectId": this row is
-- the governance record of who accepted what and when, and it has to survive a
-- project being removed exactly as its denormalised document id does.
ALTER TABLE "submission_outcome" ALTER COLUMN "documentId" DROP NOT NULL;
ALTER TABLE "submission_outcome" ADD COLUMN "projectId" TEXT;

CREATE INDEX "submission_outcome_projectId_createdAt_idx"
  ON "submission_outcome" ("projectId", "createdAt");
