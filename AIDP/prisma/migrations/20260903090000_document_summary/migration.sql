-- What a document as a whole is trying to do, so a verdict reached on eight
-- passages still knows what it is looking at. Nullable: documents ingested
-- before this existed have none, and the judge goes without.
ALTER TABLE "document" ADD COLUMN "summary" TEXT;
