-- A standing decision can now apply to one project instead of to everything.
--
-- A review board routinely allows a breach for one piece of work: a migration
-- that keeps a legacy protocol until it is retired, a pilot exempted while it
-- is a pilot. Until now the register had one reach — every future assessment —
-- so recording that exemption turned it into policy, and the next design
-- inherited an allowance nobody had granted it.
--
-- Existing rows are organisation-wide, which is what they were recorded as.
ALTER TABLE "decision" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'organisation';

-- Nullable, and null for every row above: a project-wide reach has no project.
--
-- ON DELETE SET NULL rather than CASCADE, for the reason Document.projectId
-- gives — a project is archived, not deleted, and a ruling an audit may ask
-- about must outlive one if it ever is removed. "scope" is what keeps that
-- safe: a project-scoped row whose project has gone matches no run at all,
-- where a null-means-everywhere rule would have widened it to the whole
-- organisation the moment the project row went.
ALTER TABLE "decision" ADD COLUMN "projectId" TEXT;

ALTER TABLE "decision"
    ADD CONSTRAINT "decision_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Every clause lookup in a run filters on the scope pair, once per clause
-- across a hundred-odd clauses. See `for_clause` in Workers/aidp/decisions.py.
CREATE INDEX "decision_organisationId_scope_projectId_idx"
    ON "decision" ("organisationId", "scope", "projectId");
