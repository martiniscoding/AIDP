-- Group submitted designs into projects.

ALTER TABLE "document" ADD COLUMN "projectId" TEXT;

CREATE TABLE "project" (
    "id"             TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "description"    TEXT NOT NULL DEFAULT '',
    "status"         TEXT NOT NULL DEFAULT 'active',
    "createdById"    TEXT,
    "createdByName"  TEXT NOT NULL DEFAULT '',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_organisationId_status_idx" ON "project"("organisationId", "status");
CREATE UNIQUE INDEX "project_organisationId_name_key" ON "project"("organisationId", "name");

ALTER TABLE "project" ADD CONSTRAINT "project_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project" ADD CONSTRAINT "project_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "document" ADD CONSTRAINT "document_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Give existing submissions a home.
--
-- Every design now belongs to a project, so designs that predate the idea would
-- otherwise sit outside the grouping forever — visible nowhere, or in a
-- permanent "ungrouped" bucket that never empties.
--
-- One project per organisation, named plainly rather than after the first
-- document in it. We do not know how these would have been grouped, and naming
-- it "Unsorted" says so and invites a rename; naming it after one submission
-- would be a guess that reads like a decision.
--
-- Attributed to whoever uploaded the earliest of them, so it is not authored by
-- nobody. Reference standards are deliberately left alone: they belong to the
-- organisation, not to any project.
INSERT INTO "project" ("id", "organisationId", "name", "description", "status",
                       "createdById", "createdByName", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  d."organisationId",
  'Unsorted',
  'Designs submitted before projects existed. Rename this, or move them into projects of your own.',
  'active',
  first_upload."uploadedById",
  coalesce(u."name", ''),
  min(d."createdAt"),
  now()
FROM "document" d
LEFT JOIN LATERAL (
  SELECT d2."uploadedById"
  FROM "document" d2
  WHERE d2."organisationId" = d."organisationId" AND d2."role" = 'assessed'
  ORDER BY d2."createdAt"
  LIMIT 1
) first_upload ON true
LEFT JOIN "user" u ON u."id" = first_upload."uploadedById"
WHERE d."role" = 'assessed'
GROUP BY d."organisationId", first_upload."uploadedById", u."name"
ON CONFLICT ("organisationId", "name") DO NOTHING;

UPDATE "document" d
SET "projectId" = p."id"
FROM "project" p
WHERE p."organisationId" = d."organisationId"
  AND p."name" = 'Unsorted'
  AND d."role" = 'assessed'
  AND d."projectId" IS NULL;
