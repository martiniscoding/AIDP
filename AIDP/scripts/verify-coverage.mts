/**
 * Reading "parts of a design no standard covers" off a run.
 *
 * The worker writes it as JSON, and the report trusts nothing it has not
 * narrowed: a gap without the design's own words is not shown, and a suggested
 * standard that points at no reported gap has nothing to justify it. Pure — no
 * database, no server.
 *
 * Run with:  npx tsx scripts/verify-coverage.mts
 */
import { readCoverage } from "../src/lib/ingest/coverage";

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

console.log("\nNothing to read");
ok("null, a string, an array", readCoverage(null) === null && readCoverage("x") === null && readCoverage([]) === null);
ok("an unknown state", readCoverage({ state: "maybe", gaps: [] }) === null);

console.log("\nA complete reading");
const view = readCoverage({
  version: 1,
  state: "complete",
  note: null,
  model: "openai/gpt-4.1-mini",
  sections: 42,
  truncated: true,
  gaps: [
    { section: 12, title: "4 Payments", headingPath: "Blueprint › 4 Payments", pageStart: 30, pageEnd: 34, what: "Takes card payments.", quote: "Card payments are settled through Moneris.", page: 31 },
    { section: 12, title: "duplicate", quote: "Card payments again." },
    { section: 14, title: "No quote", quote: "" },
    { section: "15", title: "Not a number", quote: "Orders ship with Canada Post." },
    { section: 16, title: "6 Shipping", quote: "Orders ship with Canada Post.", page: 40.5 },
    "garbage",
  ],
  suggestions: [
    { title: "Payment card data handling", covers: "Card data.", why: "Moneris.", sections: [12, 12, 14, 99] },
    { title: "Nothing left", covers: "", why: "", sections: [14] },
    { title: "", sections: [16] },
    { title: "Carrier integrations", covers: "Carriers.", why: "Canada Post.", sections: [16] },
  ],
  dropped: { unverified: 2, outsideSection: 1, alreadyJudged: 0, bogus: "3" },
});
ok("reads the state, model and size", view?.state === "complete" && view.model === "openai/gpt-4.1-mini" && view.sectionsRead === 42 && view.truncated, view);
ok("keeps only gaps with a whole-number section and a quote, once each", JSON.stringify(view?.gaps.map((g) => g.section)) === "[12,16]", view?.gaps);
ok("a fractional page is not a page", view?.gaps[1]?.page === null, view?.gaps[1]);
ok("a suggestion keeps only reported gaps, once each", JSON.stringify(view?.suggestions[0]?.sections) === "[12]", view?.suggestions[0]);
ok("suggestions with no reported gap, or no title, are dropped", JSON.stringify(view?.suggestions.map((s) => s.title)) === '["Payment card data handling","Carrier integrations"]', view?.suggestions);
ok("counts what the checks set aside, ignoring anything that is not a count", view?.setAside === 3, view?.setAside);

console.log("\nA check that could not run");
const skipped = readCoverage({ state: "skipped", note: "This design was processed before its pages were stored." });
ok("keeps the note, and has nothing to list", skipped?.state === "skipped" && skipped.note?.startsWith("This design") === true && skipped.gaps.length === 0 && skipped.suggestions.length === 0, skipped);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
