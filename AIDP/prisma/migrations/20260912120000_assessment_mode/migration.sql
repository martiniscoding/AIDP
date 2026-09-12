-- How the judge saw a design.
--
-- "retrieval" is the existing assessment: for each clause, the passages a
-- search found. "document" reads the whole document and quotes it, and every
-- quote is checked against the stored page text. Existing runs read as
-- "retrieval", which is what they were. `note` says when a run did not use the
-- mode it was asked for; `comparedWithId` links the two runs of a comparison.

-- AlterTable
ALTER TABLE "assessment_run" ADD COLUMN     "comparedWithId" TEXT,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'retrieval',
ADD COLUMN     "note" TEXT;
