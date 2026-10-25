/**
 * The criteria check: who gets a human's attention, and why.
 *
 * The brief's Step 2, FR-16. This is what decides whether a piece of work goes
 * in front of an architecture review board or is approved without anyone
 * reading it — so it lands in a governance audit, and the first thing anybody
 * who disagrees with a classification will ask is *why*.
 *
 * What this proves:
 *
 *   · every operator answers what it is asked, and nothing else;
 *   · an unanswered question never triggers anything — a null cost is not a
 *     cost below the threshold, it is an answer nobody gave;
 *   · a rule an administrator has broken says so rather than quietly never
 *     firing, which is the failure that would leave a category looking
 *     configured and doing nothing;
 *   · time is measured from a fixed moment, so a submission classified in
 *     January still reads the same in March;
 *   · the record says which categories were checked, not only which fired;
 *   · and the brief's own nine defaults behave as the brief describes.
 *
 * Pure: no database, no model, no network.
 *
 * Run with:  npx tsx scripts/verify-significance.mts
 */
import { DEFAULT_CRITERIA, PLACEHOLDER_COST_THRESHOLD } from "../src/lib/significance/criteria";
import {
  classify,
  evaluateCriterion,
  readConditions,
  type Answers,
  type StoredCriterion,
} from "../src/lib/significance/evaluate";

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

const ASOF = new Date("2026-10-24T00:00:00Z");

/** One criterion carrying one condition, for testing an operator on its own. */
const rule = (field: string, operator: string, value?: unknown): StoredCriterion => ({
  id: `c-${field}-${operator}`,
  category: "test",
  label: "Test",
  active: true,
  conditions: [{ field, operator, value, text: `${field} ${operator}` }],
});

const fired = (criterion: StoredCriterion, answers: Answers): boolean =>
  evaluateCriterion(criterion, answers, ASOF).triggered;

const problem = (criterion: StoredCriterion, answers: Answers): string | undefined =>
  evaluateCriterion(criterion, answers, ASOF).conditions.find((c) => c.problem)?.problem;

// ---------------------------------------------------------------------------
console.log("\nis_true — a yes/no question that was answered yes");

const yesNo = rule("newTechnologyComponent", "is_true");
ok("yes triggers", fired(yesNo, { newTechnologyComponent: true }));
ok("no does not", !fired(yesNo, { newTechnologyComponent: false }));
ok("and neither does an unanswered one", !fired(yesNo, { newTechnologyComponent: null }));
// Only a real boolean. A non-empty string is not a yes, because a form that
// sent "false" or "0" would otherwise trigger every category it touched.
ok('the string "true" is not a yes', !fired(yesNo, { newTechnologyComponent: "true" }));
ok('nor is "false"', !fired(yesNo, { newTechnologyComponent: "false" }));

// ---------------------------------------------------------------------------
console.log("\nat_least — a figure against a threshold");

const cost = rule("estimatedCost", "at_least", 5_000_000);
ok("above triggers", fired(cost, { estimatedCost: 7_500_000 }));
ok("exactly on the threshold triggers", fired(cost, { estimatedCost: 5_000_000 }));
ok("below does not", !fired(cost, { estimatedCost: 4_999_999 }));
// The one that matters most: an unanswered cost must not read as a small one.
ok("unanswered does not", !fired(cost, { estimatedCost: null }));
ok("and nor does an empty string", !fired(cost, { estimatedCost: "" }));
// Prisma hands back a Decimal object, not a number.
ok(
  "a Decimal-like object is read through its string form",
  fired(cost, { estimatedCost: { toString: () => "7500000.00" } }),
);
ok("text that is not a number does not trigger", !fired(cost, { estimatedCost: "about five million" }));

// ---------------------------------------------------------------------------
console.log("\ncount_at_least — how many entries a list has");

const lines = rule("linesOfBusiness", "count_at_least", 2);
ok("two triggers", fired(lines, { linesOfBusiness: ["Retail", "Wholesale"] }));
ok("one does not", !fired(lines, { linesOfBusiness: ["Retail"] }));
ok("none does not", !fired(lines, { linesOfBusiness: [] }));
// Blank entries are not entries: "Retail, , ," is one line of business.
ok("blank entries are not counted", !fired(lines, { linesOfBusiness: ["Retail", "", "  "] }));
ok(
  "a field that is not a list is reported",
  (problem(lines, { linesOfBusiness: "Retail, Wholesale" }) ?? "").includes("cannot be counted"),
  problem(lines, { linesOfBusiness: "Retail, Wholesale" }),
);

// ---------------------------------------------------------------------------
console.log("\none_of — a choice among accepted answers");

const criticality = rule("applicationCriticality", "one_of", ["business_critical", "mission_critical"]);
ok("an accepted answer triggers", fired(criticality, { applicationCriticality: "mission_critical" }));
ok("another accepted answer triggers", fired(criticality, { applicationCriticality: "business_critical" }));
ok("one outside the list does not", !fired(criticality, { applicationCriticality: "standard" }));
ok("and neither does an unanswered one", !fired(criticality, { applicationCriticality: null }));

// ---------------------------------------------------------------------------
console.log("\nfurther_out_than_months — implementation beyond the window");

const window12 = rule("plannedStart", "further_out_than_months", 12);
ok(
  "a date beyond the window triggers",
  fired(window12, { plannedStart: new Date("2028-01-01T00:00:00Z") }),
);
ok(
  "a date inside it does not",
  !fired(window12, { plannedStart: new Date("2027-01-01T00:00:00Z") }),
);
// The boundary, exactly. "More than twelve months" excludes twelve months.
ok(
  "the window's own last day does not",
  !fired(window12, { plannedStart: new Date("2027-10-24T00:00:00Z") }),
);
ok(
  "the day after it does",
  fired(window12, { plannedStart: new Date("2027-10-25T00:00:00Z") }),
);
ok("an unanswered date does not", !fired(window12, { plannedStart: null }));
ok("nor does one in the past", !fired(window12, { plannedStart: new Date("2020-01-01T00:00:00Z") }));

// Measured from the moment passed in, never from today. A submission judged in
// January has to keep reading the same way in March.
const january = new Date("2026-01-15T00:00:00Z");
const march = new Date("2026-03-15T00:00:00Z");
const planned = { plannedStart: new Date("2027-02-01T00:00:00Z") };
ok(
  "the same request answers differently from different moments",
  evaluateCriterion(window12, planned, january).triggered !==
    evaluateCriterion(window12, planned, march).triggered,
);
ok(
  "which is why the moment is pinned, not read from the clock",
  classify([window12], planned, january).asOf.toISOString() === january.toISOString(),
);

// Month arithmetic a person would recognise. One month after 31 January is the
// end of February — not 3 March, which is where plain date arithmetic lands and
// which would quietly move the window for every request filed at a month end.
const window1 = rule("plannedStart", "further_out_than_months", 1);
const endOfJanuary = new Date("2026-01-31T00:00:00Z");
const atMonthEnd = (plannedStart: Date) =>
  evaluateCriterion(window1, { plannedStart }, endOfJanuary);

// February 2026 has 28 days, so the window closes on the 28th.
ok(
  "the window closes at the end of February, not in March",
  atMonthEnd(new Date("2026-02-28T00:00:00Z")).conditions[0]!.actual.includes(
    "window ends 2026-02-28",
  ),
  atMonthEnd(new Date("2026-02-28T00:00:00Z")).conditions[0]!.actual,
);
ok("so 28 February is inside it", !atMonthEnd(new Date("2026-02-28T00:00:00Z")).triggered);
ok("and 1 March is beyond it", atMonthEnd(new Date("2026-03-01T00:00:00Z")).triggered);
// What it would have been without the clamp: 3 March. If that ever starts
// passing, the window has silently grown by three days for anyone filing on the
// 31st.
ok("2 March is beyond it too", atMonthEnd(new Date("2026-03-02T00:00:00Z")).triggered);

// ---------------------------------------------------------------------------
console.log("\nRules an administrator has broken");

const missingField = evaluateCriterion(
  rule("favouriteColour", "is_true"),
  { estimatedCost: 1 },
  ASOF,
).conditions[0]!;
ok(
  "a field the form does not collect is reported",
  (missingField.problem ?? "").includes("no question called \"favouriteColour\""),
  missingField.problem,
);
ok(
  "and the reading says so too, rather than a bare \"no\"",
  missingField.actual === "no such question",
  missingField.actual,
);
ok(
  "a threshold nobody configured is reported",
  (problem(rule("estimatedCost", "at_least"), { estimatedCost: 9 }) ?? "").includes("No threshold"),
);
ok(
  "an empty accepted-answers list is reported",
  (problem(rule("applicationCriticality", "one_of", []), { applicationCriticality: "x" }) ?? "")
    .includes("No accepted answers"),
);
ok(
  "and none of them trigger",
  !fired(rule("favouriteColour", "is_true"), {}) &&
    !fired(rule("estimatedCost", "at_least"), { estimatedCost: 9 }),
);

const empty: StoredCriterion = { id: "e", category: "e", label: "Empty", active: true, conditions: [] };
ok("a category with no conditions cannot trigger", !evaluateCriterion(empty, {}, ASOF).triggered);
ok(
  "and says so, because on the screen it looks configured",
  (evaluateCriterion(empty, {}, ASOF).conditions[0]?.problem ?? "").includes("never be triggered"),
);

const malformed: StoredCriterion = {
  id: "m", category: "m", label: "Malformed", active: true,
  conditions: { not: "a list" },
};
ok("a malformed conditions column is read as none", readConditions(malformed.conditions).length === 0);
ok("and does not throw", !evaluateCriterion(malformed, {}, ASOF).triggered);

const unknownOperator: StoredCriterion = {
  id: "u", category: "u", label: "Unknown", active: true,
  conditions: [{ field: "estimatedCost", operator: "exceeds_vibes", value: 1, text: "?" }],
};
ok(
  "an operator this build does not know is dropped, not obeyed",
  !evaluateCriterion(unknownOperator, { estimatedCost: 999 }, ASOF).triggered,
);

// ---------------------------------------------------------------------------
console.log("\nWhat the whole check records");

const criteria: StoredCriterion[] = DEFAULT_CRITERIA.map((seed, index) => ({
  id: `seed-${index}`,
  category: seed.category,
  label: seed.label,
  active: true,
  conditions: seed.conditions,
}));

/** A request that answers nothing. The floor. */
const nothing: Answers = {
  newTechnologyComponent: false, replacesTechnologyComponent: false,
  newLicenceRequired: false, estimatedCost: null,
  newBusinessCapability: false, linesOfBusiness: [], regulatoryImpact: false,
  securityDomainChange: false, applicationDecommissioned: false,
  applicationCriticality: "standard", newApplicationStandard: false,
  dataGovernanceEscalation: false, newOrDuplicatedStorage: false,
  plannedStart: new Date("2026-11-01T00:00:00Z"), standardsChangeProposed: false,
};

const quiet = classify(criteria, nothing, ASOF);
ok("a routine change is not significant", quiet.significance === "not_significant", quiet.triggered.map((t) => t.category));
ok("every active category was still checked", quiet.results.length === 9, quiet.results.length);
ok("none of them triggered", quiet.triggered.length === 0);
ok("and nothing is reported broken", quiet.problems.length === 0, quiet.problems.map((p) => p.problem));

// The worked example: one new component, over the cost threshold, two lines of
// business, and a licence.
const real: Answers = {
  ...nothing,
  newTechnologyComponent: true,
  estimatedCost: 7_500_000,
  linesOfBusiness: ["Retail", "Wholesale"],
  newLicenceRequired: true,
};
const loud = classify(criteria, real, ASOF);
ok("a real change is significant", loud.significance === "significant");
ok(
  "on exactly the four categories that fired",
  loud.triggered.map((t) => t.category).sort().join(",") ===
    "business_impact,cost_impact,licensing,major_technology_change",
  loud.triggered.map((t) => t.category),
);
ok("and the other five were checked and did not", loud.results.length === 9);

// The working, which is what an auditor reads.
const costResult = loud.results.find((r) => r.category === "cost_impact")!;
ok("the record names the field that fired", costResult.conditions[0]!.field === "estimatedCost");
ok("the threshold it was measured against", costResult.conditions[0]!.value === PLACEHOLDER_COST_THRESHOLD);
ok("and what the request actually said", costResult.conditions[0]!.actual === "7500000", costResult.conditions[0]!.actual);
ok("in the brief's own words", costResult.conditionText.includes("Estimated cost is at least"));

// One category is enough. This is the brief's rule, and the thing most likely
// to be "optimised" later into a count or a score.
const oneThing = classify(criteria, { ...nothing, standardsChangeProposed: true }, ASOF);
ok("a single trigger is enough to be significant", oneThing.significance === "significant");
ok("and it is named", oneThing.triggered[0]!.category === "standards_change");

console.log("\nInactive categories");

const switchedOff = criteria.map((c) =>
  c.category === "cost_impact" ? { ...c, active: false } : c,
);
const withOneOff = classify(switchedOff, real, ASOF);
ok("an inactive category is not checked", withOneOff.results.length === 8, withOneOff.results.length);
ok("so it cannot trigger", !withOneOff.triggered.some((t) => t.category === "cost_impact"));
ok("and the rest still do", withOneOff.significance === "significant");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
