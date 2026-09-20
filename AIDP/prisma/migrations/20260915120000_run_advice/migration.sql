-- Improvements to a submitted design itself, suggested by a model once the clauses
-- are judged and the coverage is worked out. Written once per run by the analyse
-- worker (see Workers/aidp/advice.py) and read by the report's "Suggested
-- improvements" section. Advice, never a verdict. Nullable: runs from before this
-- existed have none.
ALTER TABLE "assessment_run" ADD COLUMN "advice" JSONB;
