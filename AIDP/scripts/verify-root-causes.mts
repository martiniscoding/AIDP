/**
 * Reading the grouping, and counting the work it implies.
 *
 * One real 61-clause run produced twelve contradictions from five facts — five
 * of them from a single application reading another's database directly — and
 * three of the findings carried the same remediation sentence word for word.
 * The report counted twelve problems and the reviewer planned twelve pieces of
 * work.
 *
 * Workers/aidp/rootcause.py decides the grouping and checks it. This is the
 * reading half, and it trusts that shape no further than `readEvidence` trusts
 * its own: a run from before the column existed, or one whose grouping failed,
 * has to render as the report always did.
 *
 * Run with:  npx tsx scripts/verify-root-causes.mts
 */
import { causeByFinding, readRootCauses, workItems } from "../src/lib/ingest/root-causes";

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

const STORED = {
  version: 1,
  state: "complete",
  note: null,
  groups: [
    {
      label: "Cross-application database coupling",
      summary: "WAH reads the Timekeeping DB directly and RCLP writes shared tables.",
      fix: "Replace direct DB access with a governed API or ETL feed.",
      findings: ["f1", "f2", "f3"],
    },
    {
      label: "Credentials in configuration files",
      summary: "RCLP keeps credentials in a config file.",
      fix: "Move them into approved secret storage and rotate.",
      findings: ["f4", "f5"],
    },
  ],
  dropped: { unknown_finding: 0, already_grouped: 0, too_small: 0 },
};

console.log("\nA stored grouping reads back whole");
const view = readRootCauses(STORED);
ok("both causes survive", view?.causes.length === 2, view?.causes.length);
ok("the label comes through", view?.causes[0].label.startsWith("Cross-application") === true);
ok("so does the one fix they share", view?.causes[0].fix.includes("governed API") === true);
ok("and the members", view?.causes[1].findingIds.join(",") === "f4,f5");
ok("state is complete", view?.state === "complete");

console.log("\nEvery finding has at most one cause");
const byFinding = causeByFinding(view);
ok(
  "each member maps to its cause",
  byFinding.get("f2")?.label.startsWith("Cross-application") === true,
);
ok("a finding in no group maps to nothing", byFinding.get("f9") === undefined);
const twice = readRootCauses({
  groups: [
    { label: "First", summary: "", fix: "", findings: ["a", "b"] },
    { label: "Second", summary: "", fix: "", findings: ["b", "c"] },
  ],
});
ok(
  "a finding claimed twice keeps the first claim, as the worker does",
  causeByFinding(twice).get("b")?.label === "First",
);

console.log("\nThe count a reviewer is actually asking for");
// Twelve findings, five causes, is not "five things to fix" — a report is some
// grouped findings plus some that stand alone, and each of those is its own work.
const all = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
const counts = workItems(all, view);
ok("findings are counted as they are", counts.findings === 7);
ok("causes are the groups actually present", counts.causes === 2, counts);
ok(
  "work is one per cause plus one per finding standing alone",
  counts.work === 4,
  counts,
);
ok(
  "a report with no grouping is all work and no causes",
  JSON.stringify(workItems(all, null)) ===
    JSON.stringify({ findings: 7, causes: 0, work: 7 }),
  workItems(all, null),
);
ok(
  "a filtered list only counts the causes still on screen",
  workItems(["f4", "f5"], view).causes === 1 && workItems(["f4", "f5"], view).work === 1,
);

console.log("\nA report without grouping renders as it always did");
ok("null reads as null", readRootCauses(null) === null);
ok("so does a non-object", readRootCauses("nope") === null);
for (const raw of [{}, { groups: null }, { groups: "x" }, { groups: [null, 3] }]) {
  ok(`${JSON.stringify(raw).slice(0, 22).padEnd(24)} → no causes`, readRootCauses(raw)?.causes.length === 0);
}
ok(
  "a failed grouping says so and shows nothing",
  readRootCauses({ state: "failed", note: "The findings could not be grouped.", groups: [] })
    ?.state === "failed",
);
ok(
  "and an unknown state is treated as complete rather than hidden",
  readRootCauses({ state: "banana", groups: [] })?.state === "complete",
);

console.log("\nA group of one is not drawn, whatever is stored");
ok(
  "a single-member group is dropped at read as well as at write",
  readRootCauses({ groups: [{ label: "Lonely", summary: "", fix: "", findings: ["a"] }] })
    ?.causes.length === 0,
);
ok(
  "so is a group with no label",
  readRootCauses({ groups: [{ label: "  ", summary: "", fix: "", findings: ["a", "b"] }] })
    ?.causes.length === 0,
);
ok(
  "and a member that is not a string is not a member",
  readRootCauses({ groups: [{ label: "L", summary: "", fix: "", findings: ["a", 7, null] }] })
    ?.causes.length === 0,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
