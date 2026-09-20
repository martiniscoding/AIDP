/**
 * A finished assessment as the project page shows it beneath a design.
 *
 * The same content as the report, in the same order: worst first, a clause the
 * design is silent on left out (the "Absent" section is the parts of the design
 * no standard covers), counts that add up to what is listed, evidence and
 * coverage read defensively. Pure — no database, no server.
 *
 * Run with:  npx tsx scripts/verify-design-result.mts
 */
import { designResult, type CompletedRun } from "../src/lib/ingest/results";

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra: unknown = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`);
  }
};

const finding = (id: string, verdict: string, confidence: number, evidence: unknown = []) => ({
  id,
  clauseRef: `§${id}`,
  clauseTitle: `Clause ${id}`,
  clauseStatement: "The design must do it.",
  verdict,
  confidence,
  rationale: "Because.",
  evidence,
  reviewerState: "pending",
  reviewerVerdict: null,
});

const run: CompletedRun = {
  id: "run-1",
  mode: "document",
  model: "openai/gpt-4.1-mini",
  note: null,
  completedAt: new Date("2026-09-15T10:00:00Z"),
  coverage: {
    state: "complete",
    sections: 4,
    gaps: [{ section: 3, title: "Payments", quote: "Card numbers are cached.", page: 2 }],
    suggestions: [{ title: "Payment card data", covers: "", why: "", sections: [3] }],
  },
  framework: { name: "Data Standards", version: 2 },
  findings: [
    finding("a", "covered", 0.9),
    finding("b", "absent", 0.95),
    finding("c", "partial", 0.6),
    finding("d", "contradicts", 0.7, [
      { chunkId: "quote-1", headingPath: "", page: 4, excerpt: "Traffic uses plain MQTT.", sourceKind: "quote", figureId: null },
      { nonsense: true },
    ]),
    finding("e", "partial", 0.9),
    finding("f", "needs_review", 0.3),
    finding("g", "made_up", 0.99),
  ],
};

const result = designResult(run);

console.log("\nWhat is listed");
ok("a clause the design is silent on, and an unknown verdict, are left out", result.findings.every((f) => f.id !== "b" && f.id !== "g"), result.findings.map((f) => f.id));
ok("worst first, then most confident", JSON.stringify(result.findings.map((f) => f.id)) === '["d","e","c","f","a"]', result.findings.map((f) => f.id));
ok("counts add up to what is listed", JSON.stringify(result.counts) === '{"contradicts":1,"partial":2,"needs_review":1,"covered":1}', result.counts);

console.log("\nWhat comes with it");
ok("evidence is narrowed, keeping only well-formed passages", result.findings[0]?.evidence.length === 1 && result.findings[0].evidence[0]?.page === 4, result.findings[0]?.evidence);
ok("coverage is read, gaps and suggestions intact", result.coverage?.gaps.length === 1 && result.coverage.suggestions.length === 1, result.coverage);
ok("framework, mode and finish time are carried", result.frameworkName === "Data Standards" && result.frameworkVersion === 2 && result.mode === "document" && result.completedAt?.toISOString() === "2026-09-15T10:00:00.000Z");
ok("not superseded unless told so", result.superseding === false && designResult(run, true).superseding === true);

console.log("\nAn older run");
const older = designResult({ ...run, coverage: null, findings: [finding("x", "absent", 0.9)] });
ok("no coverage, and nothing listed once clause absents are left out", older.coverage === null && older.findings.length === 0, older);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
