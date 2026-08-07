-- AlterTable
ALTER TABLE "document" ADD COLUMN     "structureConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "structureConfirmedBy" TEXT,
ADD COLUMN     "structureInferred" BOOLEAN NOT NULL DEFAULT false;
