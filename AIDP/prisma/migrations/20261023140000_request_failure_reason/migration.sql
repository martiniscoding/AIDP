-- Why a request stopped, in words its requestor can act on.
--
-- The bridge from an intake form to an assessment has two failures that are
-- nobody's mistake and that the requestor cannot otherwise see: their
-- organisation has no standards indexed yet, so there is nothing to measure
-- against, and the rendered document failed to parse. Without somewhere to say
-- so, a request in either case sits in "submitted" for ever while the person
-- who filed it waits for a report that is never coming — which is the silent
-- failure the ingest_issue table exists to prevent, arriving one layer up.
ALTER TABLE "architecture_request" ADD COLUMN "failureReason" TEXT;
