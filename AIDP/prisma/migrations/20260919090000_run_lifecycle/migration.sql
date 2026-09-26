-- Whether the technologies a submitted design names are still supported by their
-- vendors, looked up on endoflife.date by product id alone once the clauses are
-- judged. Written once per run by the analyse worker (see Workers/aidp/lifecycle.py)
-- and read by the report's "Technology support" section. Facts with a source and
-- a date, never a verdict. Nullable: runs from before this existed have none.
ALTER TABLE "assessment_run" ADD COLUMN "lifecycle" JSONB;
