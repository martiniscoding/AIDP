-- An analyse job for a project run is about every design in the project, not
-- one of them, so it has no document to name. The run id on its payload is what
-- identifies it; see latestProjectRun in src/lib/ingest/projects.ts.
--
-- Parse, chunk and embed jobs still always have one: they are the stages that
-- read a file, and nothing queues them without it.
ALTER TABLE "job" ALTER COLUMN "documentId" DROP NOT NULL;

-- Finding a project run's job by the run on its payload, rather than scanning
-- every analyse job in the organisation.
CREATE INDEX "job_stage_payload_run_idx" ON "job" ("stage", (("payload" ->> 'runId')));
