/**
 * The assessment report opens on what needs attention.
 *
 * Covered findings are folded away, not discarded: they are the evidence a
 * clause was checked and passed, and the only way anybody catches a wrong one.
 * So the assertions here are about what a reviewer *sees first*, and about the
 * count and the rows still being there when asked for.
 *
 * Rendered through the real page as the real administrator, because this is a
 * client component and the fold is its default state — reading the source would
 * only prove the source says so.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-report-lens.mts
 */
import { prisma } from "../src/lib/prisma";
import { applyLens } from "../src/lib/ingest/verdicts";
import { requireEnv } from "./require-env.mts";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN = "orvinex@gmail.com";
const PASSWORD = requireEnv("SATYAM_ADMIN_PASSWORD", "Password for satyamindustry's administrator.");

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

const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ email: ADMIN, password: PASSWORD }),
});
if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
const cookie = (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");

// A design that has actually been assessed, and has both kinds of finding.
const run = await prisma.assessmentRun.findFirstOrThrow({
  where: { findings: { some: { verdict: "covered" } } },
  select: { documentId: true, findings: { select: { verdict: true, clauseTitle: true } } },
});

const covered = run.findings.filter((f) => f.verdict === "covered");
const attention = run.findings.filter((f) => f.verdict !== "covered");
console.log(`\nUsing a run with ${covered.length} covered and ${attention.length} needing attention`);

const body = await (
  await fetch(`${BASE}/dashboard/documents/${run.documentId}`, { headers: { cookie } })
).text();

console.log("\n1. The count stays on screen");
ok("the Covered chip is rendered", body.includes("Covered"));
ok("with its number", body.includes(`>${covered.length}<`), `expected >${covered.length}<`);

console.log("\n2. What is folded is said out loud");
ok(
  "the page says how many are folded",
  body.includes("covered") && /folded away/.test(body),
);
ok("and offers the way back", body.includes("show everything"));

console.log("\n3. What the opening view selects");
// Asserted against the rule itself, not against the HTML. Assessment is a
// Client Component, so every finding is serialised into the page whether or not
// it is drawn — "is the title in the body?" is unanswerable from the markup and
// an earlier version of this test failed on exactly that.
const opening = applyLens(run.findings, "attention");
ok("no covered finding is selected", opening.every((f) => f.verdict !== "covered"));
ok("every other finding is", opening.length === attention.length, `${opening.length}`);

console.log("\n4. And the ways back");
ok("'all' returns everything", applyLens(run.findings, "all").length === run.findings.length);
ok(
  "the covered chip narrows to just those",
  applyLens(run.findings, "covered").length === covered.length,
);
ok(
  "another chip narrows to that verdict alone",
  applyLens(run.findings, "contradicts").every((f) => f.verdict === "contradicts"),
);

console.log("\n5. Nothing was deleted");
const storedCovered = await prisma.finding.count({ where: { verdict: "covered" } });
ok("covered findings are still on record", storedCovered > 0, String(storedCovered));

await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
