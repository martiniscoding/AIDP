/**
 * Risk, along the five dimensions the brief names.
 *
 * FR-06 asks for scoring on single points of failure, security exposure,
 * scalability, vendor lock-in and data residency. Nothing here is new analysis:
 * it arranges what the run already worked out along those axes, so a reviewer
 * deciding whether to escalate gets "where is this weak?" instead of "here are
 * sixty things".
 *
 * The rule this exists to defend: **a dimension nothing spoke to is "not
 * assessed", never "no risk".** Those are different claims and only one of them
 * is ever supported. A run from before the lock-in category existed has no
 * lock-in suggestions, and reading "low risk" off that would be the report
 * inventing reassurance about the one thing it knows least.
 *
 * Pure: no database, no model.
 *
 * Run with:  npx tsx scripts/verify-risk.mts
 */
import { buildRisk, categoriesFor, type RiskFinding } from "../src/lib/ingest/risk";
import type { AdviceView } from "../src/lib/ingest/advice";
import type { LifecycleView } from "../src/lib/ingest/lifecycle";

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

/** A suggestion, with only the fields the risk view reads. */
const suggest = (category: string, priority: string, clauses: string[] = []) =>
  ({ category, priority, clauses }) as unknown as AdviceView["suggestions"][number];

const adviceOf = (...suggestions: AdviceView["suggestions"]) =>
  ({ suggestions }) as AdviceView;

const finding = (clauseRef: string, verdict: string, obligation: string): RiskFinding => ({
  clauseRef,
  verdict,
  obligation,
});

const row = (view: ReturnType<typeof buildRisk>, dimension: string) =>
  view.rows.find((r) => r.dimension === dimension)!;

// ---------------------------------------------------------------------------
console.log("\nThe five dimensions the brief names");

const empty = buildRisk([], null, null);
ok("all five are present", empty.rows.length === 5, empty.rows.length);
ok(
  "in the brief's own order",
  empty.rows.map((r) => r.dimension).join(",") ===
    "availability,security,scalability,lock_in,data_residency",
  empty.rows.map((r) => r.dimension),
);

// ---------------------------------------------------------------------------
console.log("\nNothing to go on is not the same as nothing wrong");

ok("a run with no advice assesses nothing", empty.unassessed.length === 5, empty.unassessed);
ok("so every dimension is unassessed", empty.rows.every((r) => !r.assessed));
// The line that matters. A severity here would read as "we looked and it was
// fine", which is the one thing the run cannot support.
ok("and none of them carries a severity", empty.rows.every((r) => r.severity === null));

// ---------------------------------------------------------------------------
console.log("\nA suggestion reaches its dimension");

const mapped = buildRisk(
  [],
  adviceOf(
    suggest("resilience", "high"),
    suggest("security", "medium"),
    suggest("performance", "low"),
    suggest("lock_in", "high"),
    suggest("data", "medium"),
  ),
  null,
);
for (const [category, dimension] of [
  ["resilience", "availability"],
  ["security", "security"],
  ["performance", "scalability"],
  ["lock_in", "lock_in"],
  ["data", "data_residency"],
] as const) {
  ok(`${category} answers ${dimension}`, row(mapped, dimension).suggestions === 1);
  ok(`  and ${dimension} is assessed`, row(mapped, dimension).assessed);
}

// A category the brief's risk axes do not name is not forced onto one. It still
// appears in the report's own suggestions list; it simply scores nothing here.
const unmapped = buildRisk([], adviceOf(suggest("documentation", "high")), null);
ok(
  "a category outside the five scores nothing",
  unmapped.rows.every((r) => !r.assessed),
  unmapped.rows.filter((r) => r.assessed).map((r) => r.dimension),
);

// ---------------------------------------------------------------------------
console.log("\nSeverity is carried from the register, not recomputed");

const breached = buildRisk(
  [
    finding("Security §2.2", "absent", "must"),      // critical
    finding("Security §3.1", "partial", "should"),   // moderate -> high
    finding("Security §4.4", "covered", "must"),     // nothing to act on
  ],
  adviceOf(suggest("security", "low", ["Security §2.2", "Security §3.1", "Security §4.4"])),
  null,
);
const security = row(breached, "security");
ok("the worst grade reaching a dimension is the one shown", security.severity === "critical", security.severity);
ok("a covered clause contributes nothing", security.clauses.length === 2, security.clauses.map((c) => c.ref));
ok("and the clauses are listed worst first", security.clauses[0]!.ref === "Security §2.2");
ok(
  "each carrying whether its grade is settled",
  security.clauses.every((c) => typeof c.settled === "boolean"),
);

// An unsettled grade is the engine saying a person has to look. It must travel
// with the number, because "Low" alone reads as "small".
const unsettled = buildRisk(
  [finding("Data §9.1", "needs_review", "unstated")],
  adviceOf(suggest("data", "low", ["Data §9.1"])),
  null,
);
ok(
  "an unsettled finding says so",
  row(unsettled, "data_residency").clauses[0]!.settled === false,
);

// ---------------------------------------------------------------------------
console.log("\nWithout a breached clause, a suggestion still grades");

const adviceOnly = buildRisk([], adviceOf(suggest("resilience", "high")), null);
ok("a high-priority suggestion is High", row(adviceOnly, "availability").severity === "high");
// Never Critical. A suggestion is a reviewer's sense of what to do first, not a
// measurement against a standard, and the brief reserves Critical for what
// blocks a submission.
ok(
  "but never Critical, because nothing a suggestion says is a breach",
  buildRisk([], adviceOf(suggest("resilience", "high"), suggest("security", "high")), null)
    .rows.every((r) => r.severity !== "critical"),
);
ok(
  "a medium-priority suggestion is Medium",
  row(buildRisk([], adviceOf(suggest("data", "medium")), null), "data_residency").severity === "medium",
);
ok(
  "and a low one is Low",
  row(buildRisk([], adviceOf(suggest("data", "low")), null), "data_residency").severity === "low",
);

// ---------------------------------------------------------------------------
console.log("\nSupport dates go where they actually bear");

const eol = {
  technologies: [
    { name: "PostgreSQL", version: "11", status: "ended" },
    { name: "Angular", version: "12", status: "supported" },
  ],
} as unknown as LifecycleView;

const withEol = buildRisk([], null, eol);
ok("an unsupported component is a thing that can stop", row(withEol, "availability").notes.length === 1);
ok("and a thing that stops getting security fixes", row(withEol, "security").notes.length === 1);
ok("naming it", row(withEol, "availability").notes[0]!.includes("PostgreSQL 11"));
ok("and only the unsupported one", !row(withEol, "availability").notes[0]!.includes("Angular"));

// The mistake this whole category exists to avoid. A design entirely on one
// cloud's proprietary managed services has perfect lifecycle hygiene and total
// lock-in; reading one from the other would report the lowest risk on exactly
// the design carrying the most.
ok("support dates are NOT evidence about lock-in", !row(withEol, "lock_in").assessed);
ok("nor about data residency", !row(withEol, "data_residency").assessed);
ok("nor about scalability", !row(withEol, "scalability").assessed);

// But they do make the dimensions they bear on assessed, even with no advice.
ok("while availability is assessed on them alone", row(withEol, "availability").assessed);

// ---------------------------------------------------------------------------
console.log("\nA run from before lock-in existed");

// Exactly the 103 runs already in the database. They carried no lock_in
// category, so the dimension has nothing — and has to say so.
const old = buildRisk(
  [finding("Security §2.2", "contradicts", "must")],
  adviceOf(
    suggest("security", "high", ["Security §2.2"]),
    suggest("resilience", "medium"),
    suggest("maintainability", "low"),
  ),
  null,
);
ok("the dimensions it did cover are graded", row(old, "security").severity === "critical");
ok("lock-in is not assessed", !row(old, "lock_in").assessed);
ok("and carries no severity", row(old, "lock_in").severity === null);
ok("the report can name what it could not answer", old.unassessed.includes("lock_in"));
ok(
  "and it is not alone in that",
  old.unassessed.includes("scalability") && old.unassessed.includes("data_residency"),
  old.unassessed,
);

// ---------------------------------------------------------------------------
console.log("\nWhat fed a dimension, for a reader who asks");

ok("availability is fed by resilience", categoriesFor("availability").includes("Resilience"));
ok("lock-in by its own category", categoriesFor("lock_in").includes("Vendor lock-in"));
ok("and data residency by data", categoriesFor("data_residency").includes("Data"));

// ---------------------------------------------------------------------------
console.log("\nA clause cited twice is counted once");

const duplicated = buildRisk(
  [finding("Security §2.2", "contradicts", "must")],
  adviceOf(
    suggest("security", "high", ["Security §2.2"]),
    suggest("security", "low", ["Security §2.2"]),
  ),
  null,
);
ok("the clause appears once", row(duplicated, "security").clauses.length === 1);
ok("with both suggestions counted", row(duplicated, "security").suggestions === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
