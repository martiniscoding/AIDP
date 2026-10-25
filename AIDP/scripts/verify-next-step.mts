/**
 * What the brief's Step 5 says should happen to a submission.
 *
 * The two checks answer different questions — how big a change this is, and
 * whether it breaks anything — and the decision is a function of both. Until
 * now a reviewer held one screen in their head while reading the other.
 *
 * **The bug this file exists to prevent.** The brief's matrix has four rows,
 * keyed on "Critical / High findings present". That works only while every
 * finding carries a settled grade, and this engine deliberately produces some
 * that do not: `check` means "severity cannot be settled from the document; a
 * person has to look", and `briefSeverityOf` puts it at the bottom of a
 * four-tier scale because an unquantified finding has to sit somewhere in a
 * ranked list.
 *
 * Read literally, a submission whose every finding is unsettled has "no
 * Critical or High findings" and takes the fast path — the engine saying
 * *nobody has looked at this*, and the workflow answering *then approve it*.
 * Half these checks are that one case.
 *
 * Pure: no database, no model.
 *
 * Run with:  npx tsx scripts/verify-next-step.mts
 */
import { nextStep, type NextStepInput } from "../src/lib/ingest/next-step";
import type { BriefSeverity } from "../src/lib/ingest/verdicts";

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra: unknown = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`, extra);
  }
};

const counts = (over: Partial<Record<BriefSeverity, number>> = {}) =>
  ({ critical: 0, high: 0, medium: 0, low: 0, ...over }) as Record<BriefSeverity, number>;

const step = (over: Partial<NextStepInput> = {}) =>
  nextStep({
    significance: "not_significant",
    counts: counts(),
    unsettled: 0,
    unreviewed: 0,
    ...over,
  });

// ---------------------------------------------------------------------------
console.log("\nThe brief's four rows");

const clean = step();
ok("not significant, nothing breached → approve", clean.route === "auto_approve", clean.route);
ok("and it says why", clean.because.includes("not architecturally significant"));

const smallButBroken = step({ counts: counts({ critical: 1 }) });
ok(
  "not significant, but a breach → an architect",
  smallButBroken.route === "architect",
  smallButBroken.route,
);
// The brief is explicit: "a standards violation is never silently waived".
ok(
  "and says a breach is not waived for being small",
  smallButBroken.because.includes("never waived for being small"),
  smallButBroken.because,
);

const bigButClean = step({ significance: "significant" });
ok("significant, nothing breached → an architect", bigButClean.route === "architect");
ok(
  "and says nothing is breached",
  bigButClean.because.includes("nothing it was measured against is breached"),
);

const bigAndBroken = step({ significance: "significant", counts: counts({ critical: 2 }) });
ok("significant with Critical findings → the board", bigAndBroken.route === "board", bigAndBroken.route);
ok("counting them", bigAndBroken.because.includes("2 Critical findings"), bigAndBroken.because);

// ---------------------------------------------------------------------------
console.log("\nThe fifth row the brief does not have");

// A submission whose findings the engine could not grade. Read literally, the
// brief's table approves this. The engine is saying the opposite.
const allUnsettled = step({ unsettled: 12 });
ok(
  "unsettled findings are NOT approved",
  allUnsettled.route !== "auto_approve",
  allUnsettled.route,
);
ok("they go to an architect", allUnsettled.route === "architect");
ok(
  "and the reason says what unsettled means",
  allUnsettled.because.includes("a person has to look"),
  allUnsettled.because,
);
ok(
  "rather than implying there is nothing to see",
  allUnsettled.because.includes("not that there is nothing to see"),
);

// One is enough. A threshold here would be somebody deciding how much
// uncertainty is acceptable, which is not a decision this file gets to make.
ok("one unsettled finding is enough", step({ unsettled: 1 }).route === "architect");
ok("and none is not", step({ unsettled: 0 }).route === "auto_approve");

// Unsettled findings never outrank a real breach: the reason given has to be
// the breach, which is the thing to fix.
const both = step({ counts: counts({ high: 1 }), unsettled: 5 });
ok("a breach is still the stated reason", both.because.includes("High finding"), both.because);

// ---------------------------------------------------------------------------
console.log("\nHigh is blocking, Medium and Low are not");

ok("a High finding routes to a person", step({ counts: counts({ high: 1 }) }).route === "architect");
ok("Medium alone does not", step({ counts: counts({ medium: 9 }) }).route === "auto_approve");
ok("nor Low", step({ counts: counts({ low: 20 }) }).route === "auto_approve");
// The board is for Critical specifically. A pile of High findings is an
// architect's call to escalate, not the platform's.
ok(
  "and High alone does not reach the board",
  step({ significance: "significant", counts: counts({ high: 5 }) }).route === "architect",
);

// ---------------------------------------------------------------------------
console.log("\nA submission that was never classified");

// A design uploaded straight into a project has no intake answers, so the
// criteria cannot be checked against it. That is not "not significant".
const unclassified = step({ significance: null });
ok("it is not approved", unclassified.route !== "auto_approve", unclassified.route);
ok("it goes to an architect", unclassified.route === "architect");
ok(
  "and says there were no intake answers to check",
  unclassified.because.includes("no intake answers"),
  unclassified.because,
);
// Even with a breach, the reason stays the breach — that is the actionable part.
ok(
  "a breach still leads the reason",
  step({ significance: null, counts: counts({ critical: 1 }) }).because.includes("Critical finding"),
);

// ---------------------------------------------------------------------------
console.log("\nUnreviewed findings are mentioned, never blocking");

// Approving a report nobody has worked through is a legitimate call an
// architect is entitled to make — `SubmissionOutcome.snapshot` captures that it
// was made. So this is said, not enforced.
const unread = step({ unreviewed: 7 });
ok("they do not change the route", unread.route === "auto_approve", unread.route);
ok("but they are said", unread.because.includes("7 findings has not been read"), unread.because);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
