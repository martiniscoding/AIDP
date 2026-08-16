-- AlterTable
ALTER TABLE "document" ADD COLUMN     "uploadedById" TEXT;

-- AlterTable
ALTER TABLE "membership" ALTER COLUMN "role" SET DEFAULT 'member';

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "roster_entry" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "jobTitle" TEXT NOT NULL DEFAULT '',
    "department" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'imported',
    "role" TEXT NOT NULL DEFAULT 'member',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "userId" TEXT,
    "allowedAt" TIMESTAMP(3),
    "allowedById" TEXT,
    "allowedByName" TEXT NOT NULL DEFAULT '',
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_usage" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT,
    "documentId" TEXT,
    "runId" TEXT,
    "stage" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roster_entry_organisationId_status_idx" ON "roster_entry"("organisationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "roster_entry_organisationId_email_key" ON "roster_entry"("organisationId", "email");

-- CreateIndex
CREATE INDEX "token_usage_organisationId_createdAt_idx" ON "token_usage"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "token_usage_organisationId_userId_idx" ON "token_usage"("organisationId", "userId");

-- CreateIndex
CREATE INDEX "token_usage_documentId_idx" ON "token_usage"("documentId");

-- AddForeignKey
ALTER TABLE "roster_entry" ADD CONSTRAINT "roster_entry_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_entry" ADD CONSTRAINT "roster_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the roster from existing memberships.
--
-- Without this, every organisation created before today opens the People page
-- to an empty list while its members carry on working — the roster would claim
-- nobody has access to a workspace several people are signed in to.
--
-- Everyone who already holds a membership is 'active' by definition: they have
-- an account and they are in. 'owner' carries over as-is; 'consultant' and
-- 'viewer' predate the two-role model and map to 'member', which is what
-- toRole() in src/lib/access/roles.ts does with them at read time.
INSERT INTO "roster_entry" (
  "id", "organisationId", "email", "name", "status", "role", "source",
  "userId", "allowedAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  m."organisationId",
  lower(u."email"),
  u."name",
  'active',
  CASE WHEN m."role" = 'owner' THEN 'owner' ELSE 'member' END,
  'signup',
  u."id",
  m."createdAt",
  m."createdAt",
  now()
FROM "membership" m
JOIN "user" u ON u."id" = m."userId"
ON CONFLICT ("organisationId", "email") DO NOTHING;

-- Attribute existing documents to the organisation's administrator.
--
-- Historic spend has no recorded author, so the closest true statement is that
-- it belongs to whoever runs the workspace. Only fills rows that are still
-- null, and only where the organisation has exactly one administrator — a
-- guess between two of them would be worse than leaving it unattributed.
UPDATE "document" d
SET "uploadedById" = sole."userId"
FROM (
  SELECT "organisationId", min("userId") AS "userId"
  FROM "membership"
  WHERE "role" = 'owner'
  GROUP BY "organisationId"
  HAVING count(*) = 1
) sole
WHERE d."organisationId" = sole."organisationId"
  AND d."uploadedById" IS NULL;
