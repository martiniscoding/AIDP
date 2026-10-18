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
import { gapKey, readCoverage } from "../src/lib/ingest/coverage";

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

console.log("\nA project's designs each number their own sections");
// Both designs have a section 6. Keyed on the ordinal alone, the second one's
// gap was dropped as a duplicate of the first's, its suggested standard was
// justified by the other design's gap, and its tables were filed under a key
// the first design already owned.
const project = readCoverage({
  state: "complete",
  gaps: [
    { section: 6, title: "HR System", quote: "Workforce metrics land in the warehouse nightly.", documentId: "doc-a", documentTitle: "Workforce Analytics Hub" },
    { section: 6, title: "Order DB", quote: "Orders are written to a dedicated Postgres instance.", documentId: "doc-b", documentTitle: "Customer Order Platform" },
    { section: 7, title: "Repeat of A's 6", quote: "Workforce metrics land in the warehouse nightly.", documentId: "doc-a", documentTitle: "Workforce Analytics Hub" },
    { section: 6, title: "A's 6 again", quote: "A second go at the same section.", documentId: "doc-a", documentTitle: "Workforce Analytics Hub" },
  ],
  suggestions: [
    { title: "Workforce analytics standards", covers: "Nightly ETL.", why: "The hub.", sections: [6], documentId: "doc-a", documentTitle: "Workforce Analytics Hub" },
    { title: "Borrowed from the other design", covers: "Orders.", why: "The platform.", sections: [7], documentId: "doc-b", documentTitle: "Customer Order Platform" },
  ],
});
ok("one gap per section per design, not per section", project?.gaps.length === 3, project?.gaps.map((g) => `${g.documentId}#${g.section}`));
ok("both designs keep their section 6", JSON.stringify(project?.gaps.map((g) => g.documentId)) === '["doc-a","doc-b","doc-a"]', project?.gaps.map((g) => g.documentId));
ok("a repeat within one design is still dropped", project?.gaps.filter((g) => g.documentId === "doc-a" && g.section === 6).length === 1, project?.gaps);
ok("the design's name is read, not discarded", project?.gaps[1]?.documentTitle === "Customer Order Platform", project?.gaps[1]);
ok("gapKey separates the two section 6s", gapKey(project!.gaps[0]!) !== gapKey(project!.gaps[1]!), [gapKey(project!.gaps[0]!), gapKey(project!.gaps[1]!)]);
ok("a suggestion is justified by its own design's gap", JSON.stringify(project?.suggestions.map((s) => s.title)) === '["Workforce analytics standards"]', project?.suggestions);

console.log("\nA single design carries no design id, and still dedupes");
const alone = readCoverage({
  state: "complete",
  gaps: [
    { section: 6, title: "Only design", quote: "One design, no project around it." },
    { section: 6, title: "Duplicate", quote: "The same section twice." },
  ],
});
ok("an untagged gap reads as having no design", alone?.gaps[0]?.documentId === null && alone.gaps[0]?.documentTitle === null, alone?.gaps[0]);
ok("and a duplicate section is still one gap", alone?.gaps.length === 1, alone?.gaps);

console.log("\nA check that could not run");
const skipped = readCoverage({ state: "skipped", note: "This design was processed before its pages were stored." });
ok("keeps the note, and has nothing to list", skipped?.state === "skipped" && skipped.note?.startsWith("This design") === true && skipped.gaps.length === 0 && skipped.suggestions.length === 0, skipped);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
