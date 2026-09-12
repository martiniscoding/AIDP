-- What a claimed job is doing right now: its current step, a count where there
-- is one, and the steps it has finished. Written by the workers (see
-- Workers/aidp/progress.py) and read by the document pages. Nullable, and never
-- required: a worker that cannot write it carries on without it.
ALTER TABLE "job" ADD COLUMN "progress" JSONB;
