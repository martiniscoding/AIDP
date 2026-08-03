-- Indexes Prisma cannot express, for the assessment tables.

-- One live run per document. A double-click on "Run assessment" must not start
-- two, and a resumed run must find its own row rather than racing a twin.
CREATE UNIQUE INDEX "assessment_run_live_document_idx"
    ON "assessment_run" ("documentId")
    WHERE "state" IN ('queued', 'running');

-- The review queue: everything a human still has to look at. Partial, because
-- confirmed findings are the majority once a run has been worked through and
-- there is no reason to keep them in this index.
CREATE INDEX "finding_pending_review_idx"
    ON "finding" ("runId", "verdict")
    WHERE "reviewerState" = 'pending';
