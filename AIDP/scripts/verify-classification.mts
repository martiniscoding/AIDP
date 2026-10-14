/**
 * What a verdict and an obligation together mean for a reviewer.
 *
 * The engine's worst habit was turning a document that does not say into a
 * confirmed violation. Every `absent` the re-read confirmed was recorded at
 * CONFIRM_CONFIDENCE (0.7), `severityOf` treated anything at or above 0.7 as
 * settled, and settled absents were Critical — so "the design names GKE but
 * includes no approval record" arrived in a report beside a real breach, at the
 * same severity, under a blurb that read "The design breaks this requirement".
 *
 * Two things fix that, and this is where both are pinned down:
 *
 *   · `not_assessable` exists, meaning the design is on the subject with the
 *     evidence needed to judge it missing. It is never Critical, whatever the
 *     obligation, because the document not saying is a question for its author
 *     and not a defect in the architecture.
 *   · severity reads the clause's obligation. A breach of an advisory "may" and
 *     a breach of a mandatory "shall" are no longer the same finding, and
 *     `unstated` is not treated as either — the engine will not invent mandatory
 *     language, and it will not invent permission.
 *
 * The cases below are lettered to the brief they come from, so a failure says
 * which requirement regressed. Pure functions only: no database, no model.
 *
 * Run with:  npx tsx scripts/verify-classification.mts
 */
import {
  OBLIGATIONS,
  SETTLED_CONFIDENCE,
  VERDICTS,
  VERDICT_META,
  applyLens,
  emptyCounts,
  readObligation,
  severityOf,
  type Obligation,
  type Verdict,
} from "../src/lib/ingest/verdicts";

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

const SURE = SETTLED_CONFIDENCE; // what a confirmed absent is recorded at
const UNSURE = 0.6;

console.log("\nCase B — approval evidence missing is not a violation");
for (const obligation of OBLIGATIONS) {
  ok(
    `not_assessable is never critical (obligation: ${obligation})`,
    severityOf("not_assessable", 1, obligation) !== "critical",
    severityOf("not_assessable", 1, obligation),
  );
}
ok(
  "a mandatory clause's evidence gap still outranks an advisory one",
  severityOf("not_assessable", SURE, "must") === "moderate" &&
    severityOf("not_assessable", SURE, "should") === "check",
);
ok(
  "and it is not softened to nothing — an evidence gap is still a finding",
  severityOf("not_assessable", SURE, "must") !== null,
);

console.log("\nCase C — an actual mandatory violation is still Critical");
ok("a breach of a must is critical", severityOf("contradicts", SURE, "must") === "critical");
ok(
  "and stays critical however unsure the model was, because the conflict is stated",
  severityOf("contradicts", 0.1, "must") === "critical",
);
ok(
  "a breach of an explicitly advisory rule is moderate, not critical",
  severityOf("contradicts", SURE, "should") === "moderate" &&
    severityOf("contradicts", SURE, "may") === "moderate",
);
ok(
  "an unstated obligation does not become permission to breach",
  severityOf("contradicts", SURE, "unstated") === "critical",
);

console.log("\nCase A — technology chosen, rationale missing");
// The regression the brief names: a design that picks GKE with no placement
// rationale. The engine must not reach "contradicts", and the gap it does
// report must not outrank a real breach.
ok(
  "an unaddressed mandatory mechanism is critical",
  severityOf("absent", SURE, "must") === "critical",
);
ok(
  "but an unaddressed clause whose obligation was never stated is not",
  severityOf("absent", SURE, "unstated") === "moderate",
);
ok(
  "and a low-confidence absent is still only worth a look",
  severityOf("absent", UNSURE, "must") === "check" &&
    severityOf("absent", UNSURE, "unstated") === "check",
);
ok(
  "an advisory clause the design ignores is moderate",
  severityOf("absent", SURE, "should") === "moderate",
);

console.log("\nCase D — partial compliance sits below a breach");
ok("a partly met must is moderate", severityOf("partial", SURE, "must") === "moderate");
ok(
  "a partly met optional rule only needs a look",
  severityOf("partial", SURE, "may") === "check",
);

console.log("\nCase J — not applicable is not a failure");
for (const obligation of OBLIGATIONS) {
  ok(
    `not_applicable carries no severity (obligation: ${obligation})`,
    severityOf("not_applicable", 1, obligation) === null,
  );
}
ok("and neither does covered", severityOf("covered", 1, "must") === null);
ok(
  "a clause that does not apply is not in the review queue",
  applyLens(
    [
      { verdict: "not_applicable" },
      { verdict: "covered" },
      { verdict: "not_assessable" },
      { verdict: "contradicts" },
    ],
    "attention",
  ).map((f) => f.verdict).join(",") === "not_assessable,contradicts",
);
ok(
  "but it is still reachable, so a reviewer can audit what was waved away",
  applyLens([{ verdict: "not_applicable" }], "not_applicable").length === 1,
);

console.log("\nCase H — confidence cannot stand in for evidence");
ok(
  "a certain not_assessable is still not a violation",
  severityOf("not_assessable", 1, "must") !== "critical",
);
ok(
  "needs_review is never promoted by confidence",
  severityOf("needs_review", 1, "must") === "check",
);
ok(
  "and a verdict this code has never been taught is treated as a question",
  severityOf("something_new", 1, "must") === "check",
);

console.log("\nThe vocabulary holds together");
ok("every verdict has a meaning on screen", VERDICTS.every((v) => Boolean(VERDICT_META[v])));
ok(
  "the review queue is ordered worst first",
  VERDICTS.indexOf("contradicts") < VERDICTS.indexOf("partial") &&
    VERDICTS.indexOf("partial") < VERDICTS.indexOf("covered") &&
    VERDICTS.indexOf("covered") < VERDICTS.indexOf("not_applicable"),
  VERDICTS,
);
ok(
  "a count starts at zero for all of them, including the new ones",
  Object.keys(emptyCounts()).length === VERDICTS.length &&
    emptyCounts().not_assessable === 0 &&
    emptyCounts().not_applicable === 0,
);
ok(
  "only the two 'nothing to do' verdicts carry no severity",
  VERDICTS.filter((v: Verdict) => severityOf(v, SURE, "must") === null).join(",") ===
    "covered,not_applicable",
  VERDICTS.filter((v: Verdict) => severityOf(v, SURE, "must") === null),
);

console.log("\nAn obligation off the wire is never trusted blindly");
ok("a known one is kept", readObligation("must") === "must");
ok("an unknown one becomes unstated, not mandatory", readObligation("MUST!") === "unstated");
for (const value of [null, undefined, 7, "", "critical", {}]) {
  ok(
    `“${String(value)}” reads as unstated`,
    readObligation(value) === "unstated",
  );
}
ok(
  "and unstated is the default, so a finding from before this existed is not called mandatory",
  (severityOf("absent", SURE) as string) === "moderate",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
