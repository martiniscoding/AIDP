-- A clause can be sharpened, and sharpening replaces it rather than rewriting it.
--
-- "Ensure resilience" cannot be judged. A design that retries without a
-- dead-letter path comes back `partial` on every assessment for ever, and the
-- thing that would fix it — writing down what the clause meant — had nowhere to
-- go. This is that somewhere.
--
-- Never an edit in place. "finding" denormalises a clause's ref, title and
-- statement but NOT its requirements, and requirements are exactly what
-- sharpening adds. Rewritten in place, a report from six months ago would say
-- "covered" against requirements that no longer exist anywhere, which is the
-- one question an assessment has to be able to answer.
ALTER TABLE "clause" ADD COLUMN "supersededById" TEXT;
ALTER TABLE "clause" ADD COLUMN "sourceFindingId" TEXT;
ALTER TABLE "clause" ADD COLUMN "sourceRunId" TEXT;
ALTER TABLE "clause" ADD COLUMN "authoredByName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "clause" ADD COLUMN "authoredAt" TIMESTAMP(3);

-- One replacement per clause, so a chain cannot fork into two live versions.
CREATE UNIQUE INDEX "clause_supersededById_key" ON "clause" ("supersededById");

ALTER TABLE "clause"
    ADD CONSTRAINT "clause_supersededById_fkey"
    FOREIGN KEY ("supersededById") REFERENCES "clause"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The ordinal is a clause's place in its section, and the superseded row keeps
-- the one it had: §9.3 stays §9.3, and reading order does not shuffle because a
-- requirement was added. So uniqueness has to apply to the live clause only —
-- one live per ordinal, any number of retired ones behind it.
--
-- Prisma cannot express a partial unique index, so this one is invisible to it,
-- exactly like "assessment_run_live_project_idx". A violation therefore arrives
-- as Postgres's 23505 rather than Prisma's P2002, which `isUniqueViolation` in
-- src/app/dashboard/documents/actions.ts already handles.
--
-- Safe to swap directly: every existing row has a null "supersededById", so the
-- partial index covers exactly the rows the full one did.
DROP INDEX "clause_sectionId_ordinal_key";
CREATE UNIQUE INDEX "clause_live_sectionId_ordinal_key"
    ON "clause" ("sectionId", "ordinal")
    WHERE "supersededById" IS NULL;

-- Every clause lookup starts from a section and leaves the superseded out —
-- the framework's clause list, the clause count, the parsed-document page.
CREATE INDEX "clause_sectionId_supersededById_idx"
    ON "clause" ("sectionId", "supersededById");

-- A proposed sharpening, waiting for a person.
--
-- A model writes the requirement lines and code checks them; nothing reaches
-- the library unread. Staged rather than applied directly so that a library
-- does not gain a requirement every time somebody confirms a verdict, and so
-- there is one place to see what is pending.
CREATE TABLE "clause_draft" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "clauseId" TEXT NOT NULL,
    "clauseRef" TEXT NOT NULL DEFAULT '',
    "clauseTitle" TEXT NOT NULL DEFAULT '',
    "sourceFindingId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'drafting',
    "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "error" TEXT,
    "setAside" JSONB NOT NULL DEFAULT '[]',
    "appliedClauseId" TEXT,
    "requestedById" TEXT,
    "requestedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clause_draft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "clause_draft_organisationId_state_idx"
    ON "clause_draft" ("organisationId", "state");
CREATE INDEX "clause_draft_clauseId_idx" ON "clause_draft" ("clauseId");

-- One live draft per finding. A reviewer pressing twice must not queue two
-- model calls against the same clause, and two drafts from one finding would
-- read as two independent proposals agreeing.
CREATE UNIQUE INDEX "clause_draft_live_finding_key"
    ON "clause_draft" ("sourceFindingId")
    WHERE "state" IN ('drafting', 'ready');

ALTER TABLE "clause_draft"
    ADD CONSTRAINT "clause_draft_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "organisation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "clause_draft"
    ADD CONSTRAINT "clause_draft_clauseId_fkey"
    FOREIGN KEY ("clauseId") REFERENCES "clause"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "clause_draft"
    ADD CONSTRAINT "clause_draft_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "user"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
