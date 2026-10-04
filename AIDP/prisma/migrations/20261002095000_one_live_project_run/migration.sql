-- Idempotency for a project assessment, the same guarantee
-- "job_live_document_stage_idx" gives a design: one live run per project, so a
-- double-submit or a retried enqueue cannot start the same work twice.
--
-- A design run is kept out of it by the WHERE: those are already covered by the
-- job index, and a project's designs may each have their own run running beside
-- the project's.
--
-- Postgres treats NULLs as distinct in a unique index, which is why this has to
-- say "IS NOT NULL" rather than relying on the column.
CREATE UNIQUE INDEX "assessment_run_live_project_idx"
    ON "assessment_run" ("projectId")
    WHERE "state" IN ('queued', 'running') AND "projectId" IS NOT NULL;
