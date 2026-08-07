-- Move the technology reference from the person to the organisation.
--
-- It was keyed to the user, which put it out of reach of the assessment
-- pipeline: a run belongs to an organisation, so there was no answer to "whose
-- stack applies here?" once two consultants shared a customer.
--
-- Nothing is deleted. Rows that cannot be attached to an organisation keep
-- every field and simply hold a NULL — Postgres allows many NULLs under a
-- unique index, so they coexist and can be reconciled by hand.

-- DropIndex
DROP INDEX "tech_assessment_userId_key";

-- AlterTable
ALTER TABLE "tech_assessment" ADD COLUMN     "organisationId" TEXT;

-- Backfill: adopt the organisation its author most recently joined, which is
-- the same one `resolveActive` hands them in the app.
UPDATE "tech_assessment" ta
   SET "organisationId" = m."organisationId"
  FROM (
    SELECT DISTINCT ON ("userId") "userId", "organisationId"
      FROM "membership"
     ORDER BY "userId", "createdAt" DESC
  ) m
 WHERE m."userId" = ta."userId";

-- Where two people in one organisation each saved a reference, only one row can
-- be the organisation's. Keep the most recently updated and detach the rest
-- rather than dropping them: the losing row still holds real answers somebody
-- typed, and a unique-constraint failure at migrate time would be worse than
-- either.
UPDATE "tech_assessment" ta
   SET "organisationId" = NULL
 WHERE ta."organisationId" IS NOT NULL
   AND ta."id" NOT IN (
     SELECT DISTINCT ON ("organisationId") "id"
       FROM "tech_assessment"
      WHERE "organisationId" IS NOT NULL
      ORDER BY "organisationId", "updatedAt" DESC
   );

-- CreateIndex
CREATE UNIQUE INDEX "tech_assessment_organisationId_key" ON "tech_assessment"("organisationId");

-- AddForeignKey
ALTER TABLE "tech_assessment" ADD CONSTRAINT "tech_assessment_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
