-- A run over a whole project, not one design.
--
-- A design document rarely stands alone: a solution is described across a
-- proposal, an architecture deck and a data model, and what one leaves out the
-- next one answers. Judged one document at a time, those answers were reported
-- as gaps — the "absent" count moved with which file you happened to open. So a
-- run may now name a project instead, and a clause is judged once against every
-- design in it.
--
-- `documentId` becomes nullable rather than being replaced: every existing run
-- is a single-design run and keeps its document, the per-design report keeps
-- reading them by it, and exactly one of the two columns is set on any row.
ALTER TABLE "assessment_run" ALTER COLUMN "documentId" DROP NOT NULL;

ALTER TABLE "assessment_run" ADD COLUMN "projectId" TEXT;

-- SetNull, not Cascade: a project is archived rather than deleted, but if one is
-- ever removed its reports must survive it, exactly as documents do.
ALTER TABLE "assessment_run"
  ADD CONSTRAINT "assessment_run_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The project page asks for "this project's runs, newest first" on every load.
CREATE INDEX "assessment_run_projectId_state_idx" ON "assessment_run"("projectId", "state");

-- One of the two scopes, never both and never neither. The engine branches on
-- which is set, so a row with both would be read as a project run with a stray
-- document and a row with neither would assess nothing at all.
ALTER TABLE "assessment_run"
  ADD CONSTRAINT "assessment_run_one_scope"
  CHECK (("documentId" IS NULL) <> ("projectId" IS NULL));
