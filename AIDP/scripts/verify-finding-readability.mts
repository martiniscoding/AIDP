/**
 * Three read-time changes that make a breach legible, checked against stored runs.
 *
 * A customer rejected a report for being unreadable, and none of the three
 * causes was a wrong verdict:
 *
 *   1. The clause's requirements were never printed. Six of seven
 *      contradictions rested on one, and the panel showed only the principle.
 *   2. Evidence was in retrieval order, so a design the finding never mentions
 *      could come first — on one, a *passing* design's "Observability | Aligned
 *      by design" was the opening proof that another design had failed that
 *      clause.
 *   3. Findings from one shared fact were only kept together by the luck of the
 *      confidence ordering, and the panel saying how many things there really
 *      are to fix opened closed.
 *
 * All three are fixed at render, so every report already stored is fixed by
 * being opened. That is what this checks: the rules, on real findings, with no
 * re-run and no re-parse.
 *
 * The third one is a guarantee, not a repair, and the numbers this prints say
 * so — "cause blocks: 2 before, 2 after" is the correct result on a run whose
 * causes were already contiguous. What it proves is that grouping cannot break
 * severity order, lose a finding, or split a cause in two.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-finding-readability.mts
 */
import { prisma } from "../src/lib/prisma";
import {
  orderEvidence,
  withTables,
  tablesForEvidence,
  citedRow,
} from "../src/lib/ingest/evidence-tables";
import { orderByCause, readRootCauses, causeByFinding, workItems } from "../src/lib/ingest/root-causes";
import { requirementsForClauses } from "../src/lib/ingest/standards";
import {
  readEvidence,
  withoutExtractIds,
  readableExcerpt,
  rationaleSections,
  RATIONALE_PART_ALSO,
  clauseAddress,
  VERDICTS,
} from "../src/lib/ingest/verdicts";

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

/** The newest run that actually judged something, which is what a reader opens. */
const run = await prisma.assessmentRun.findFirst({
  where: { state: "complete", findings: { some: { verdict: "contradicts" } } },
  orderBy: { startedAt: "desc" },
});
if (!run) {
  console.log("no completed run with a contradiction — nothing to check against");
  await prisma.$disconnect();
  process.exit(0);
}
console.log(`\nagainst run ${run.id} (${run.startedAt.toISOString().slice(0, 16)})\n`);

const findings = await prisma.finding.findMany({ where: { runId: run.id } });
const rank = new Map(VERDICTS.map((v, i) => [v as string, i]));
const ordered = findings.sort(
  (a, b) => (rank.get(a.verdict) ?? 99) - (rank.get(b.verdict) ?? 99) || b.confidence - a.confidence,
);

// ---------------------------------------------------------------------------
// 1. The clause's requirements reach the report.
// ---------------------------------------------------------------------------
const requirements = await requirementsForClauses(ordered.map((f) => f.clauseId));
const breaches = ordered.filter((f) => f.verdict === "contradicts");
const withReqs = breaches.filter((f) => (requirements.get(f.clauseId) ?? []).length > 0);

ok(
  `requirements are read back for the clauses that have them (${withReqs.length}/${breaches.length} contradictions)`,
  withReqs.length > 0,
);
ok(
  "a clause a re-parse removed yields no entry rather than throwing",
  (await requirementsForClauses(["definitely-not-a-clause-id"])).size === 0,
);
ok("an empty list of ids costs no query", (await requirementsForClauses([])).size === 0);

// The failure this exists to stop: an accusation whose matching requirement was
// on the clause all along and never printed.
const hidden = withReqs.filter((f) => {
  const words = withoutExtractIds(f.rationale).toLowerCase();
  return (requirements.get(f.clauseId) ?? []).some((req) => {
    // A requirement the rationale is clearly answering: four or more of its
    // significant words, in the finding's own first sentence.
    const terms = req.toLowerCase().match(/[a-z]{5,}/g) ?? [];
    return terms.filter((t) => words.includes(t)).length >= 4;
  });
});
console.log(
  `       (${hidden.length} of those findings argue a requirement the report used to hide)`,
);

// ---------------------------------------------------------------------------
// 2. Evidence is in the order that answers the finding.
// ---------------------------------------------------------------------------
const tables = await tablesForEvidence(
  ordered.flatMap((f) => readEvidence(f.evidence).map((e) => e.chunkId)),
);

let breachFirst = 0;
let strangerFirstBefore = 0;
let strangerFirstAfter = 0;
let dropped = 0;
let reordered = 0;

for (const f of breaches) {
  const rationale = withoutExtractIds(f.rationale);
  const before = withTables(readEvidence(f.evidence), tables);
  const after = orderEvidence(before, rationale);

  if (before.length !== after.length) dropped += 1;
  const sameSet =
    new Set(before.map((e) => e.chunkId)).size === new Set(after.map((e) => e.chunkId)).size;
  if (!sameSet) dropped += 1;
  if (before.map((e) => e.chunkId).join() !== after.map((e) => e.chunkId).join()) reordered += 1;

  const names = (title: string | null) => {
    const t = (title ?? "").trim().toLowerCase();
    if (!t) return false;
    const bare = t.replace(/\s*\([^)]*\)/g, "").trim();
    const acronyms = [...(title ?? "").matchAll(/\(([A-Za-z]{2,8})\)/g)].map((m) =>
      m[1]!.toLowerCase(),
    );
    return [t, bare, ...acronyms]
      .filter((a) => a.length >= 3)
      .some((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(rationale.toLowerCase()));
  };

  if (after[0]?.breachQuote) breachFirst += 1;
  if (before[0] && !before[0].breachQuote && !names(before[0].documentTitle)) {
    strangerFirstBefore += 1;
  }
  if (after[0] && !after[0].breachQuote && !names(after[0].documentTitle)) {
    strangerFirstAfter += 1;
  }

  // No passage from a design the finding never names may sit above one from a
  // design it does. This is the rule, not the instance.
  let seenStranger = false;
  let inverted = false;
  for (const item of after) {
    const known = Boolean(item.breachQuote) || names(item.documentTitle);
    if (!known) seenStranger = true;
    else if (seenStranger) inverted = true;
  }
  ok(`${f.clauseRef.slice(0, 44)}: no unmentioned design above a mentioned one`, !inverted);
}

ok("nothing is added or lost by reordering", dropped === 0);
ok(
  `the convicting passage leads where the judge named one (${breachFirst}/${breaches.length})`,
  breachFirst === breaches.filter((f) => readEvidence(f.evidence).some((e) => e.breachQuote)).length,
);
ok(
  `findings opening on an unmentioned design: ${strangerFirstBefore} before, ${strangerFirstAfter} after`,
  strangerFirstAfter < strangerFirstBefore || strangerFirstBefore === 0,
);
ok(
  "evidence with nothing to rank is returned untouched",
  orderEvidence([], "x").length === 0 &&
    JSON.stringify(orderEvidence(withTables(readEvidence(breaches[0]!.evidence), tables).slice(0, 1), "")) ===
      JSON.stringify(withTables(readEvidence(breaches[0]!.evidence), tables).slice(0, 1)),
);
console.log(`       (${reordered} of ${breaches.length} contradictions had their evidence reordered)`);

// ---------------------------------------------------------------------------
// 3. Findings from one fact are read together.
// ---------------------------------------------------------------------------
const causes = readRootCauses(run.rootCauses);
const grouped = orderByCause(ordered, causes);
const byFinding = causeByFinding(causes);

ok("nothing is added or lost by grouping", grouped.length === ordered.length);
ok(
  "every finding survives grouping",
  new Set(grouped.map((f) => f.id)).size === new Set(ordered.map((f) => f.id)).size,
);

// Worst first is not negotiable: the verdict ranks must never go backwards.
let monotonic = true;
for (let i = 1; i < grouped.length; i += 1) {
  if ((rank.get(grouped[i]!.verdict) ?? 99) < (rank.get(grouped[i - 1]!.verdict) ?? 99)) {
    monotonic = false;
  }
}
ok("severity order survives grouping", monotonic);

// Each cause occupies one run of rows, not several.
const runsPerCause = new Map<string, number>();
let previous: string | null = null;
for (const f of grouped) {
  const label = byFinding.get(f.id)?.label ?? null;
  if (label && label !== previous) runsPerCause.set(label, (runsPerCause.get(label) ?? 0) + 1);
  previous = label;
}
const split = [...runsPerCause.entries()].filter(([, n]) => n > 1);
ok(
  `each cause reads as one block (${runsPerCause.size} causes)`,
  split.length === 0,
  split.map(([l, n]) => `${l} in ${n} pieces`).join("; "),
);

// What the reader was being asked to do before, and is not now.
const scattered = (() => {
  let runs = 0;
  let prev: string | null = null;
  for (const f of ordered) {
    const label = byFinding.get(f.id)?.label ?? null;
    if (label && label !== prev) runs += 1;
    prev = label;
  }
  return runs;
})();
const counts = workItems(
  ordered.filter((f) => f.verdict === "contradicts").map((f) => f.id),
  causes,
);
console.log(
  `       (${counts.findings} contradictions, ${counts.work} things to fix; ` +
    `cause blocks: ${scattered} before, ${runsPerCause.size} after)`,
);

ok(
  "a run with no grouping is returned exactly as it came",
  JSON.stringify(orderByCause(ordered, null).map((f) => f.id)) ===
    JSON.stringify(ordered.map((f) => f.id)),
);

// ---------------------------------------------------------------------------
// 4. A cited table is drawn, and says which row was quoted.
// ---------------------------------------------------------------------------
let drawn = 0;
let highlighted = 0;
let runOn = 0;
let breachUnmarked = 0;

for (const f of breaches) {
  const rationale = withoutExtractIds(f.rationale);
  for (const e of orderEvidence(withTables(readEvidence(f.evidence), tables), rationale)) {
    const text = readableExcerpt(e.excerpt, e.headingPath);
    if (e.table) {
      drawn += 1;
      if (e.table.rows.length > 0) highlighted += 1;
      // The card a reviewer reads first must not be a table with no row named
      // when the judge handed us the row.
      if (e.breachQuote && e.table.rows.length === 0) breachUnmarked += 1;
      continue;
    }
    // A table flattened into one unbroken line. Prose with its own line breaks
    // is prose, however long.
    if (!e.figureId && text.length > 180 && text.split("\n").length <= 2) runOn += 1;
  }
}

ok(`no cited table arrives as a run-on line (${runOn})`, runOn === 0);
ok(
  `a drawn table names its row wherever it can (${highlighted}/${drawn})`,
  highlighted > 0 && drawn > 0,
);
ok(
  `the convicting card never shows an unmarked table (${breachUnmarked})`,
  breachUnmarked === 0,
);

// A row is marked only when it was identified outright. The guarantee that
// matters is the negative one: never the wrong row.
const ambiguous = citedRow("nothing in here matches any row at all", [
  ["Area", "Decision"],
  ["Area", "Decision"],
]);
ok("two rows that match equally leave the table unmarked", ambiguous === null);

// ---------------------------------------------------------------------------
// 5. A rationale is labelled wherever its parts can be named.
// ---------------------------------------------------------------------------
const labelled = breaches.filter((f) => rationaleSections(withoutExtractIds(f.rationale), f.verdict));
ok(
  `breach rationales shown with labels rather than as a wall (${labelled.length}/${breaches.length})`,
  labelled.length === breaches.length,
  `${breaches.length - labelled.length} still unlabelled`,
);
ok(
  "a fix named rather than opened with a verb is still a fix",
  (rationaleSections(
    "The design couples two applications through a shared table. This risks data loss. " +
      "The fix is to replace the shared table with a governed API. Similarly, the portal " +
      "writes to another application's database.",
    "contradicts",
  )?.length ?? 0) === 4,
);
ok(
  "a trailing remark is labelled, not folded into the impact",
  rationaleSections(
    "A breaches the clause. This risks outage. Replace it with an API. Similarly, B does too.",
    "contradicts",
  )?.at(-1)?.label === RATIONALE_PART_ALSO,
);
ok(
  "a second sentence that only restates the gap is still not a fix",
  rationaleSections(
    "The design never mentions encryption. The design also never mentions key rotation.",
    "contradicts",
  ) === null,
);

// ---------------------------------------------------------------------------
// 6. The clause is located once, not twice.
// ---------------------------------------------------------------------------
const duplicating = ordered.filter(
  (f) =>
    f.clauseTitle.trim().length >= 3 &&
    f.clauseRef.trim().toLowerCase().endsWith(f.clauseTitle.trim().toLowerCase()),
);
ok(
  `the clause name is not printed twice (${duplicating.length} findings would have)`,
  duplicating.every(
    (f) =>
      !clauseAddress(f.clauseRef, f.clauseTitle)
        .toLowerCase()
        .endsWith(f.clauseTitle.trim().toLowerCase()),
  ),
);
ok(
  "a numeric reference is left alone",
  clauseAddress("3.5", "Naming conventions") === "3.5" && clauseAddress("13", "") === "13",
);
ok(
  "a reference that is only the title keeps the title",
  clauseAddress("Overview", "Overview") === "Overview",
);
ok(
  "the clause number survives the trim",
  clauseAddress("Integration v0.2 › Core Integration Principles › 3. Abstract System of Record",
    "Abstract System of Record") === "Integration v0.2 › Core Integration Principles › 3.",
);
ok(
  "a title that merely appears in the middle is not trimmed",
  clauseAddress("Security › Encryption › 4.1 Keys", "Encryption") ===
    "Security › Encryption › 4.1 Keys",
);
const shortened = duplicating.map(
  (f) => f.clauseRef.trim().length - clauseAddress(f.clauseRef, f.clauseTitle).length,
);
if (shortened.length > 0) {
  console.log(
    `       (${shortened.reduce((a, b) => a + b, 0).toLocaleString()} characters of repetition ` +
      `removed from ${shortened.length} findings on this run)`,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
