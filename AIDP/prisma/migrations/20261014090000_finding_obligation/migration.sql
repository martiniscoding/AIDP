-- How strongly the clause bound, recorded on the finding that was judged against it.
--
-- Severity was a function of the verdict and the model's own confidence, so a
-- design breaching an advisory "may" and one breaching a mandatory "shall"
-- produced the same finding at the same severity — and every confirmed "absent"
-- came out Critical, which is how a missing page of paperwork arrived in a
-- report beside a real breach and read the same.
--
-- Denormalised rather than joined to the clause, for the same reason
-- "clauseRef" is: a report has to keep explaining its own severities after the
-- clause behind them has been sharpened or retired.
--
-- Defaults to 'unstated', which is deliberately NOT a synonym for advisory. It
-- means the standard did not establish the obligation, and every finding that
-- already exists is in exactly that position — none of them was judged with an
-- obligation in the prompt, so backfilling a value would be inventing one.
ALTER TABLE "finding" ADD COLUMN "obligation" TEXT NOT NULL DEFAULT 'unstated';

-- Where the obligation came from, weakest claim last: 'parsed' (the standard's
-- own recorded structure), 'read' (a modal verb in the clause's wording),
-- 'judge' (the model's reading), or 'unstated'. Kept beside the value so a
-- reviewer can see which kind of answer a severity rests on.
ALTER TABLE "finding" ADD COLUMN "obligationSource" TEXT NOT NULL DEFAULT 'unstated';

-- The executive summary counts mandatory breaches and mandatory evidence gaps
-- separately from advisory ones, which is this index's only reader.
CREATE INDEX "finding_run_obligation_idx" ON "finding" ("runId", "obligation");
