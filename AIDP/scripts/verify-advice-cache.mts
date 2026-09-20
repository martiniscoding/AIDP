/**
 * Reading where a run's suggested improvements came from.
 *
 * Suggestions are reused while a design and its standards stay the same, and a
 * reviewer can ask for a fresh set (Workers/aidp/advice.py). The report has to
 * say which it is showing and when it was worked out, and must not break on a
 * run stored before any of that was recorded. Pure — no database, no server.
 *
 * Run with:  npx tsx scripts/verify-advice-cache.mts
 */
import { readAdvice } from "../src/lib/ingest/advice";

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

const suggestion = {
  title: "Replicate PostgreSQL to a second region",
  kind: "add",
  category: "resilience",
  priority: "high",
  section: 2,
  component: "PostgreSQL",
  sectionTitle: "3 Data",
  headingPath: "Order Platform › 3 Data",
  pageStart: 2,
  pageEnd: 2,
  quote: null,
  page: null,
  recommendation: "Run a streaming replica in a second region.",
  why: "One instance is a single point of failure.",
  clauses: [],
};
const complete = { version: 1, state: "complete", note: null, model: "openai/gpt-4.1-mini", sections: 3, suggestions: [suggestion], dropped: {} };

console.log("\nReused suggestions");
const reused = readAdvice({ ...complete, source: "cache", generatedAt: "2026-09-16T11:47:43.648Z", refreshing: false });
ok("source reads as cache", reused?.source === "cache", reused?.source);
ok("keeps when they were worked out", reused?.generatedAt === "2026-09-16T11:47:43.648Z", reused?.generatedAt);
ok("not refreshing, no error", reused?.refreshing === false && reused.refreshError === null);
ok("the suggestions themselves still read", reused?.suggestions.length === 1);

console.log("\nFreshly worked out");
const fresh = readAdvice({ ...complete, source: "model", generatedAt: "2026-09-19T08:00:00+00:00" });
ok("source reads as model", fresh?.source === "model");
ok("an offset timestamp is accepted", fresh?.generatedAt === "2026-09-19T08:00:00+00:00");

console.log("\nA run stored before any of this was recorded");
const old = readAdvice(complete);
ok("defaults to model", old?.source === "model");
ok("no date rather than a made-up one", old?.generatedAt === null);
ok("not refreshing, no error", old?.refreshing === false && old.refreshError === null);

console.log("\nNothing is guessed");
const odd = readAdvice({ ...complete, source: "somewhere", generatedAt: "last Tuesday", refreshing: "yes", refreshError: 42 });
ok("an unknown source reads as model", odd?.source === "model");
ok("an unreadable date reads as null", odd?.generatedAt === null);
ok("only a real true means refreshing", odd?.refreshing === false);
ok("a non-string error is ignored", odd?.refreshError === null);

console.log("\nA new set being worked out, and one that failed");
const working = readAdvice({ ...complete, source: "cache", generatedAt: "2026-09-16T11:47:43Z", refreshing: true, refreshError: null });
ok("refreshing, with the earlier suggestions still there", working?.refreshing === true && working.suggestions.length === 1);
const failedRefresh = readAdvice({ ...complete, refreshing: false, refreshError: "A new set could not be worked out: the model provider's credits or quota are used up." });
ok("the failure is carried, the suggestions kept", failedRefresh?.refreshError?.startsWith("A new set could not be worked out") === true && failedRefresh.suggestions.length === 1);

console.log("\nWhat the action writes when a run had no suggestions yet");
const placeholder = readAdvice({ version: 1, state: "failed", note: null, suggestions: [], refreshing: true, refreshError: null });
ok("reads as failed and refreshing, with nothing to show", placeholder?.state === "failed" && placeholder.refreshing === true && placeholder.suggestions.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
