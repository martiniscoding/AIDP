-- CreateTable
CREATE TABLE "tech_assessment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL DEFAULT '',
    "primaryContact" TEXT NOT NULL DEFAULT '',
    "roleTitle" TEXT NOT NULL DEFAULT '',
    "dateCompleted" TEXT NOT NULL DEFAULT '',
    "dataSources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dataWarehousing" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "biReporting" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primaryCloud" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workloads" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "additionalNotes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tech_assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tech_platform_preference" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "platformKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "currentUsage" TEXT,
    "interestLevel" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tech_platform_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tech_assessment_userId_key" ON "tech_assessment"("userId");

-- CreateIndex
CREATE INDEX "tech_platform_preference_assessmentId_idx" ON "tech_platform_preference"("assessmentId");

-- CreateIndex
CREATE UNIQUE INDEX "tech_platform_preference_assessmentId_platformKey_key" ON "tech_platform_preference"("assessmentId", "platformKey");

-- AddForeignKey
ALTER TABLE "tech_assessment" ADD CONSTRAINT "tech_assessment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_platform_preference" ADD CONSTRAINT "tech_platform_preference_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "tech_assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
