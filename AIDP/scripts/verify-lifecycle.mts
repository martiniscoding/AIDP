/**
 * Reading "technology support" off a run, and what the report says about each.
 *
 * The worker writes it as JSON (Workers/aidp/lifecycle.py) and the report trusts
 * nothing it has not narrowed: an entry without a name or a known status is
 * dropped, dates must be dates, a technology with no product id is never shown
 * as checked, and the link to endoflife.date is built from a checked id rather
 * than taken from storage. Pure — no database, no server.
 *
 * Run with:  npx tsx scripts/verify-lifecycle.mts
 */
import { describe, formatDay, readLifecycle, type Technology } from "../src/lib/ingest/lifecycle";

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

const base = {
  name: "PostgreSQL",
  product: "postgresql",
  label: "PostgreSQL",
  version: "11",
  cycle: "11",
  status: "ended",
  eol: "2023-11-09",
  eolNoDate: false,
  support: null,
  securityOnly: false,
  extendedSupport: null,
  lts: false,
  latest: "11.22",
  current: "18",
  upgradeTo: "18",
  ambiguous: [],
  section: 2,
  sectionTitle: "Data",
  headingPath: "LCL Portal › Data",
  quote: "Orders are stored in a single PostgreSQL 11 instance.",
  page: 17,
};
const run = (technologies: unknown[], extra: Record<string, unknown> = {}) =>
  readLifecycle({ version: 1, state: "complete", note: null, checkedAt: "2026-09-19T08:00:00+00:00", source: "endoflife.date", soonDays: 365, technologies, dropped: {}, ...extra });

console.log("\nNothing to read");
ok("null, a string, an array", readLifecycle(null) === null && readLifecycle("x") === null && readLifecycle([]) === null);
ok("an unknown state", readLifecycle({ state: "maybe", technologies: [] }) === null);

console.log("\nA complete check");
const view = run([base]);
ok("reads", view?.state === "complete" && view.technologies.length === 1);
ok("keeps when it was checked", view?.checkedAt === "2026-09-19T08:00:00+00:00");
const pg = view!.technologies[0];
ok("carries the facts", pg.status === "ended" && pg.eol === "2023-11-09" && pg.latest === "11.22" && pg.upgradeTo === "18");
ok("links to the product's page, built from the id", pg.link === "https://endoflife.date/postgresql");

console.log("\nNothing is guessed");
const odd = run([
  { ...base, name: "", label: "No name" },
  { ...base, name: "Weird", status: "fine" },
  { ...base, name: "Injected", product: "../../evil?x=1", status: "ended" },
  { ...base, name: "Dates", product: "angular", eol: "next year", support: "2021-13-45", extendedSupport: "whenever" },
]);
const names = odd!.technologies.map((t) => t.name);
ok("an entry with no name is dropped", !names.includes(""));
ok("an unknown status is dropped", !names.includes("Weird"));
const injected = odd!.technologies.find((t) => t.name === "Injected")!;
ok("an id that is not a plain slug is never linked, and is not shown as checked", injected.product === null && injected.link === null && injected.status === "untracked");
const dates = odd!.technologies.find((t) => t.name === "Dates")!;
ok("dates that are not dates read as null", dates.eol === null && dates.support === null && dates.extendedSupport === null);

console.log("\nThe report's order is what needs acting on first");
const ordered = run([
  { ...base, name: "C", label: "C", status: "supported" },
  { ...base, name: "A", label: "A", status: "untracked", product: null },
  { ...base, name: "B", label: "B", status: "ending" },
  { ...base, name: "D", label: "D", status: "ended" },
]);
ok("ended, ending, supported, untracked", ordered!.technologies.map((t) => t.status).join(",") === "ended,ending,supported,untracked", ordered!.technologies.map((t) => t.status));

console.log("\nFailed and skipped say why");
const failed = readLifecycle({ state: "failed", note: "endoflife.date could not be reached." });
ok("failed carries its note", failed?.state === "failed" && failed.note === "endoflife.date could not be reached." && failed.technologies.length === 0);
ok("set-aside counts only refusals", run([], { dropped: { unverified: 2, unknownSection: 1, duplicate: 5, overLimit: 3 } })!.setAside === 3);

console.log("\nWhat the report says");
const t = (fields: Partial<Technology>): Technology => ({ ...(view!.technologies[0]), ...fields });
ok("dates format the same everywhere", formatDay("2023-11-09") === "9 Nov 2023", formatDay("2023-11-09"));
const said = [
  [t({}), "Support ended 9 Nov 2023. The last release in the 11 line is 11.22. Move to the 18 line."],
  [t({ status: "ended", eol: null, eolNoDate: true, latest: null, upgradeTo: null }), "Support has ended."],
  [t({ label: "Spring Boot", cycle: "2.7", latest: "2.7.18", eol: "2023-06-30", extendedSupport: "2029-06-30", upgradeTo: "3.5" }), "Support ended 30 Jun 2023. Paid extended support runs until 30 Jun 2029. The last release in the 2.7 line is 2.7.18. Move to the 3.5 line."],
  [t({ status: "ending", eol: "2027-03-01", upgradeTo: "18" }), "Support ends 1 Mar 2027. Move to the 18 line."],
  [t({ status: "supported", eol: "2030-12-31", latest: "8u504-b01", upgradeTo: null }), "Supported until 31 Dec 2030. Latest release in this line: 8u504-b01."],
  [t({ status: "supported", eol: "2029-01-01", securityOnly: true, support: "2025-01-01", latest: null, upgradeTo: null }), "Supported until 1 Jan 2029. Security fixes only since 1 Jan 2025."],
  [t({ status: "supported", eol: null, latest: null, upgradeTo: null }), "Supported, with no end date announced."],
  [t({ status: "unversioned", version: null, current: "4.1" }), "The design does not say which version. The current release line is 4.1; confirm the version in use."],
  [t({ status: "unknownVersion", version: "2", ambiguous: ["2.7", "2.6"] }), "The design says 2, which could be any of 2.7, 2.6. State the exact version."],
  [t({ status: "unknownVersion", version: "99", ambiguous: [] }), "Version 99 is not among the published release lines. Confirm it."],
  [t({ status: "unchecked" }), "Its support dates could not be fetched on this run."],
] as const;
for (const [technology, expected] of said) {
  ok(`${technology.status}: "${expected.slice(0, 48)}…"`, describe(technology) === expected, describe(technology));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
