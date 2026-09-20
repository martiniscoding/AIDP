-- The parts of a submitted design that no standard clause governs, and the
-- standards a model suggests adding to cover them. Written once per run by the
-- analyse worker (see Workers/aidp/coverage.py) and read by the report's
-- "Absent" section. Nullable: runs from before this existed have none.
ALTER TABLE "assessment_run" ADD COLUMN "coverage" JSONB;
