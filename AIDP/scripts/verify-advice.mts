/**
 * Reading "suggested improvements" off a run.
 *
 * The worker writes them as JSON, and the report trusts nothing it has not
 * narrowed: a suggestion with no section or no recommendation is not shown, a
 * suggestion to change what the design says is not shown without the design's own
 * words beside it, and the list is ordered highest priority first whatever order
 * it was stored in. Pure — no database, no server.
 *
 * Run with:  npx tsx scripts/verify-advice.mts
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

console.log("\nNothing to read");
ok("null, a string, an array", readAdvice(null) === null && readAdvice("x") === null && readAdvice([]) === null);
ok("an unknown state", readAdvice({ state: "maybe", suggestions: [] }) === null);

console.log("\nA complete reading");
const base = { section: 3, headingPath: "Blueprint › 5 Data", sectionTitle: "5 Data", pageStart: 3, pageEnd: 4 };
const view = readAdvice({
  version: 1,
  state: "complete",
  note: null,
  model: "openai/gpt-4.1-mini",
  sections: 12,
  truncated: true,
  suggestions: [
    { ...base, title: "Tidy the naming", kind: "improve", category: "maintainability", priority: "low", quote: "Tables use mixed case names.", page: 4, recommendation: "Use snake_case.", why: "Consistency.", clauses: [] },
    { ...base, title: "Add a read replica", component: "PostgreSQL", kind: "add", category: "resilience", priority: "high", quote: null, page: null, recommendation: "Replicate the database to the DR site.", why: "One copy is a single point of failure.", clauses: ["Data §9.3", "Data §9.3", 7, ""] },
    { ...base, title: "Separate the backups", kind: "improve", category: "data", priority: "medium", quote: "Nightly backups are written to the same storage array as the database.", page: 3, recommendation: "Write backups to separate storage.", why: "", clauses: [] },
    { ...base, title: "No quote for a change", kind: "improve", priority: "high", quote: "", recommendation: "Change something." },
    { ...base, title: "No section", section: "3", kind: "add", priority: "high", recommendation: "Add something." },
    { ...base, title: "", kind: "add", recommendation: "Untitled." },
    { ...base, title: "No recommendation", kind: "add", recommendation: "   " },
    { ...base, title: "ADD A READ REPLICA", kind: "add", priority: "low", recommendation: "Duplicate." },
    { ...base, title: "Odd labels", kind: "sideways", category: "vibes", priority: "urgent", quote: "Releases are deployed manually on Fridays.", recommendation: "Automate releases." },
    "garbage",
    ["also garbage"],
  ],
  dropped: { empty: 1, unknownSection: 1, unanchored: 2, missingQuote: 2, unverified: 3, outsideSection: 1, duplicate: 4, overLimit: 5, nonsense: 9 },
});
ok("read", view !== null && view.state === "complete");
const titles = view?.suggestions.map((s) => s.title) ?? [];
ok("only well-formed suggestions kept", titles.length === 4, titles);
ok("a change without the design's words is not shown", !titles.includes("No quote for a change"));
ok("a suggestion without a numeric section is not shown", !titles.includes("No section"));
ok("empty title or recommendation is not shown", !titles.includes("") && !titles.includes("No recommendation"));
ok("a repeated title (any case) is shown once", titles.filter((t) => t.toLowerCase() === "add a read replica").length === 1);
ok("highest priority first, stable within a priority", JSON.stringify(view?.suggestions.map((s) => s.priority)) === JSON.stringify(["high", "medium", "medium", "low"]), view?.suggestions.map((s) => s.priority));
const odd = view?.suggestions.find((s) => s.title === "Odd labels");
ok("unknown kind reads as a change", odd?.kind === "improve", odd);
ok("unknown category reads as other", odd?.category === "other", odd);
ok("unknown priority reads as medium", odd?.priority === "medium", odd);
const replica = view?.suggestions.find((s) => s.title === "Add a read replica");
ok("an addition may stand without a quote", replica?.kind === "add" && replica.quote === null);
ok("clause references are strings, once each", JSON.stringify(replica?.clauses) === JSON.stringify(["Data §9.3"]), replica?.clauses);
ok("section and pages carried", replica?.section === 3 && replica.pageStart === 3 && replica.pageEnd === 4);
ok("refusals counted, duplicates and unknown reasons not", view?.setAside === 10, view?.setAside);
ok("the named component is carried", replica?.component === "PostgreSQL", replica);
ok("a run stored before components reads as none", view?.suggestions.find((s) => s.title === "Separate the backups")?.component === null);
ok("left out for length counted separately", view?.overLimit === 5, view?.overLimit);
ok("model, sections read and truncation read", view?.model === "openai/gpt-4.1-mini" && view.sectionsRead === 12 && view.truncated === true);

console.log("\nNothing to show, and why");
const skipped = readAdvice({ state: "skipped", note: "No model API key is configured.", suggestions: [{ ...base, title: "Stray", kind: "add", recommendation: "Ignored?" }] });
ok("skipped carries its note", skipped?.state === "skipped" && skipped.note === "No model API key is configured.");
const failed = readAdvice({ state: "failed", note: "", dropped: [] });
ok("failed with no note reads as null note and zero counts", failed?.state === "failed" && failed.note === null && failed.setAside === 0 && failed.overLimit === 0 && failed.suggestions.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
