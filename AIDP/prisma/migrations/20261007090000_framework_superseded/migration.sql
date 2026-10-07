-- A framework version stops being usable when a standard inside it is removed.
--
-- "framework_document" rows cascade away with the document, so after a removal
-- the set comparison in resolveFramework sees no change — the evidence of the
-- change was deleted along with it. The same framework id then meant a smaller
-- set of standards than the runs pinned to it had been measured against, which
-- is precisely what versioning frameworks exists to prevent.
--
-- Nullable and unset: every framework on record is current until something
-- removes a standard from it.
ALTER TABLE "framework" ADD COLUMN "supersededAt" TIMESTAMP(3);

-- resolveFramework asks for the newest version that has not been superseded, on
-- every assessment.
CREATE INDEX "framework_organisationId_supersededAt_idx"
    ON "framework" ("organisationId", "supersededAt");
