-- Phase 0 of the architecturally-significant review workflow: the four tables
-- the governance layer stands on.
--
-- A request is one submission through the five-step workflow — Intake, an
-- Architecture Criteria Check and an Architecture Review running in parallel
-- off the same intake data, a combined Review Report, and a Decision.
--
-- Nothing here is read by the Python workers. They address twenty tables by
-- name and none of these is among them, so this layer surrounds the engine
-- without being able to reach into it. No existing table gains a column: the
-- only statements against one are the foreign keys pointing at it from here.
--
-- Three index declarations were added to schema.prisma in the same change.
-- They are NOT created here, because the database already has them — they were
-- created by 20261002094000, 20261007090000 and 20261014090000 and were never
-- written into the schema, so every `prisma migrate` since has been offering to
-- drop three live indexes as collateral on whatever unrelated change came next.
-- Declaring them makes the schema say what the database already holds.

-- CreateTable
CREATE TABLE "architecture_request" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT,
    "diagramDocumentId" TEXT,
    "runId" TEXT,
    "requestedById" TEXT,
    "requestedByName" TEXT NOT NULL DEFAULT '',
    "team" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "plannedStart" TIMESTAMP(3),
    "problemStatement" TEXT NOT NULL DEFAULT '',
    "solutionOverview" TEXT NOT NULL DEFAULT '',
    "technologies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "newTechnologyComponent" BOOLEAN NOT NULL DEFAULT false,
    "newTechnologyComponentName" TEXT NOT NULL DEFAULT '',
    "replacesTechnologyComponent" BOOLEAN NOT NULL DEFAULT false,
    "replacedTechnologyComponentName" TEXT NOT NULL DEFAULT '',
    "integrationPoints" TEXT NOT NULL DEFAULT '',
    "authMechanism" TEXT NOT NULL DEFAULT '',
    "dataStores" TEXT NOT NULL DEFAULT '',
    "dataClassification" TEXT NOT NULL DEFAULT '',
    "newOrDuplicatedStorage" BOOLEAN NOT NULL DEFAULT false,
    "hostingEnvironment" TEXT NOT NULL DEFAULT '',
    "estimatedCost" DECIMAL(18,2),
    "newLicenceRequired" BOOLEAN NOT NULL DEFAULT false,
    "newLicenceVendor" TEXT NOT NULL DEFAULT '',
    "linesOfBusiness" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "newBusinessCapability" BOOLEAN NOT NULL DEFAULT false,
    "regulatoryImpact" BOOLEAN NOT NULL DEFAULT false,
    "regulatoryImpactDetail" TEXT NOT NULL DEFAULT '',
    "securityDomainChange" BOOLEAN NOT NULL DEFAULT false,
    "securityDomainChangeDetail" TEXT NOT NULL DEFAULT '',
    "applicationDecommissioned" BOOLEAN NOT NULL DEFAULT false,
    "applicationDecommissionedName" TEXT NOT NULL DEFAULT '',
    "applicationCriticality" TEXT NOT NULL DEFAULT 'standard',
    "newApplicationStandard" BOOLEAN NOT NULL DEFAULT false,
    "dataGovernanceEscalation" BOOLEAN NOT NULL DEFAULT false,
    "standardsChangeProposed" BOOLEAN NOT NULL DEFAULT false,
    "standardsChangeDetail" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'draft',
    "significance" TEXT,
    "significanceAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "architecture_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "significance_criterion" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "significance_criterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "significance_result" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "categoryLabel" TEXT NOT NULL,
    "conditionText" TEXT NOT NULL DEFAULT '',
    "triggered" BOOLEAN NOT NULL DEFAULT false,
    "triggeredBy" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "significance_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_assignment" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "assignedToId" TEXT,
    "assignedToName" TEXT NOT NULL DEFAULT '',
    "assignedById" TEXT,
    "assignedByName" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'active',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "architecture_request_organisationId_state_idx" ON "architecture_request"("organisationId", "state");

-- CreateIndex
CREATE INDEX "architecture_request_projectId_idx" ON "architecture_request"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "architecture_request_organisationId_reference_key" ON "architecture_request"("organisationId", "reference");

-- CreateIndex
CREATE INDEX "significance_criterion_organisationId_active_idx" ON "significance_criterion"("organisationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "significance_criterion_organisationId_category_key" ON "significance_criterion"("organisationId", "category");

-- CreateIndex
CREATE INDEX "significance_result_requestId_triggered_idx" ON "significance_result"("requestId", "triggered");

-- CreateIndex
CREATE UNIQUE INDEX "significance_result_requestId_criterionId_key" ON "significance_result"("requestId", "criterionId");

-- CreateIndex
CREATE INDEX "review_assignment_requestId_state_idx" ON "review_assignment"("requestId", "state");

-- CreateIndex
CREATE INDEX "review_assignment_assignedToId_state_idx" ON "review_assignment"("assignedToId", "state");

-- AddForeignKey
ALTER TABLE "architecture_request" ADD CONSTRAINT "architecture_request_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_request" ADD CONSTRAINT "architecture_request_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_request" ADD CONSTRAINT "architecture_request_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "significance_criterion" ADD CONSTRAINT "significance_criterion_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "significance_result" ADD CONSTRAINT "significance_result_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "architecture_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_assignment" ADD CONSTRAINT "review_assignment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "architecture_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_assignment" ADD CONSTRAINT "review_assignment_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

