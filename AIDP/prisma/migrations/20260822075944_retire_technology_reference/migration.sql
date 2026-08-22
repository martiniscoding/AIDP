-- Retire the Technology Stack & Architecture Reference.
--
-- The feature is gone from the product: it collected a customer's platform
-- choices and fed them to the judge as background context. What replaces it is
-- a plain company profile, which is what the two useful fields on the old
-- form actually were.

-- Company details, edited on /dashboard/profile.
ALTER TABLE "organisation"
  ADD COLUMN "primaryContact" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "contactEmail"   TEXT NOT NULL DEFAULT '',
  ADD COLUMN "contactPhone"   TEXT NOT NULL DEFAULT '',
  ADD COLUMN "country"        TEXT NOT NULL DEFAULT '',
  ADD COLUMN "industry"       TEXT NOT NULL DEFAULT '',
  ADD COLUMN "notes"          TEXT NOT NULL DEFAULT '';

-- Carry forward what the retired form already knew before dropping it.
--
-- Section 1 of that form was "Client information", and two of its fields are
-- exactly the new ones. Dropping the table without this would throw away a
-- contact name somebody had typed and then ask them to type it again.
--
-- Only fills a blank, and only from a row that belongs to an organisation:
-- the table permitted rows with a null organisationId, which described nobody.
UPDATE "organisation" o
SET "primaryContact" = t."primaryContact"
FROM "tech_assessment" t
WHERE t."organisationId" = o."id"
  AND o."primaryContact" = ''
  AND coalesce(t."primaryContact", '') <> '';

-- `tech_platform_preference` cascades off `tech_assessment`, but drop it first
-- so the order does not depend on that.
DROP TABLE IF EXISTS "tech_platform_preference";
DROP TABLE IF EXISTS "tech_assessment";
