/**
 * The table behind a quoted passage.
 *
 * A fifth of the evidence text in this workspace is table cells printed as a
 * run-on line: 1,054 of 3,882 cited passages, 457,000 characters of "Category:
 * Programming Languages | Comments: V 11". That string is the parser's reading
 * transcript of a five-column row with its three empty columns dropped, and a
 * reviewer checking a verdict against it is reconstructing a table from its
 * shadow.
 *
 * Two routes back to the real table, and they are not equally certain:
 *
 *   · A finding's evidence names a chunk, and a chunk of kind `table` or
 *     `table_row` carries its TableBlock id. Exact, and retroactive — reports
 *     written months ago get their tables back without re-running anything.
 *   · A coverage gap names no chunk, so its table has to be *recognised* from
 *     the quote. That is a guess, so it is held to a threshold and the tests
 *     below are mostly about when it must refuse.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-evidence-tables.mts
 */
import { citedRow, quoteIsTable } from "../src/lib/ingest/evidence-tables";
import type { TableView } from "../src/lib/ingest/documents";

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

// Copied out of table_block: "Payor Management Audit SBD v1.1[2]"
// § 3.4.2 Technology Stack, page 18 — the table from the screenshot.
const COLUMNS = [
  "Category",
  "Mainstream Technologies",
  "Non- Standard Technologies",
  "Reason for using non-mainstream technology",
  "Comments",
];
const ROWS = [
  {
    Category: "Container Management Platform",
    "Mainstream Technologies": null,
    "Non- Standard Technologies": null,
    "Reason for using non-mainstream technology": null,
    Comments: null,
  },
  {
    Category: "Relational DB (if any)",
    "Mainstream Technologies": "MySQL instance on PCF\nCloudSQL/MySQL service",
    "Non- Standard Technologies": null,
    "Reason for using non-mainstream technology": null,
    Comments: "v5.7.28\n8.0",
  },
  {
    Category: "Messaging",
    "Mainstream Technologies": "RabbitMQ",
    "Non- Standard Technologies": null,
    "Reason for using non-mainstream technology": null,
    Comments: null,
  },
];
const TABLE: TableView = {
  id: "t1",
  ordinal: 1,
  caption: null,
  columns: COLUMNS,
  rows: ROWS,
  pageStart: 18,
  confidence: 1,
};

console.log("\nWhich row a passage was cited for");
ok(
  "the row whose cells are in the chunk wins",
  citedRow(
    "Payor Management Audit SBD › 3.4.2 Technology Stack\n\nTechnology Stack\n" +
      "Category: Relational DB (if any) | Mainstream Technologies: MySQL instance on PCF " +
      "CloudSQL/MySQL service | Comments: v5.7.28 8.0",
    ROWS,
  ) === 1,
  citedRow("Category: Relational DB (if any) | MySQL instance on PCF", ROWS),
);
ok(
  "a line break in a cell is not a mismatch",
  citedRow("mysql instance on pcf cloudsql/mysql service", ROWS) === 1,
);
ok("a row with one distinctive cell is still found", citedRow("Messaging RabbitMQ", ROWS) === 2);
ok(
  "nothing matching means no highlight rather than a guess",
  citedRow("This passage is about disaster recovery.", ROWS) === null,
);
ok("an empty table gives no row", citedRow("anything", []) === null);
ok("rows that are not an array give no row", citedRow("anything", null) === null);

console.log("\nA highlight on the wrong row would be a false claim, so ties refuse");
const repeated = [
  { Category: "Analytics", Tech: "N/A" },
  { Category: "Cache Management", Tech: "N/A" },
];
ok(
  "two rows matching equally well give no highlight",
  citedRow("Mainstream Technologies: N/A", repeated) === null,
  citedRow("Mainstream Technologies: N/A", repeated),
);
ok(
  "but the one that also matches its own category still wins",
  citedRow("Category: Cache Management | Mainstream Technologies: N/A", repeated) === 1,
);
ok(
  "short cells cannot decide it on their own",
  citedRow("the value is 8", [{ A: "8" }, { A: "9" }]) === null,
);

console.log("\nRecognising a coverage quote that is really a table");
// The real one: 1,072 characters, 18 pipes, 16 "Category:".
const realQuote =
  "Category | Mainstream Technologies | Non- Standard Technologies | Reason for using " +
  "non-mainstream technology | Comments Category: Container Management Platform " +
  "Category: Relational DB (if any) | Mainstream Technologies: MySQL instance on PCF " +
  "CloudSQL/MySQL service | Comments: v5.7.28 8.0 Category: Messaging | Mainstream " +
  "Technologies: RabbitMQ";
ok("the screenshot's quote is recognised as its table", quoteIsTable(realQuote, [TABLE]));
ok(
  "prose about the same subject is not",
  !quoteIsTable(
    "The platform runs on Google Kubernetes Engine with a managed relational database, " +
      "and the team expects to revisit the messaging choice once throughput is understood " +
      "because the current broker was chosen for familiarity rather than for its delivery " +
      "guarantees under sustained load across regions.",
    [TABLE],
  ),
);
ok(
  "a short quote is never matched, however table-ish it looks",
  !quoteIsTable("Category: Messaging | RabbitMQ", [TABLE]),
);
ok("no tables, no match", !quoteIsTable(realQuote, []));
ok(
  "and a table with nothing in it cannot claim a quote",
  !quoteIsTable(realQuote, [{ ...TABLE, columns: [], rows: [] }]),
);
ok(
  "a quote made of two tables is matched by the pair",
  quoteIsTable(realQuote, [
    { ...TABLE, id: "a", rows: ROWS.slice(0, 1) },
    { ...TABLE, id: "b", rows: ROWS.slice(1) },
  ]),
);

console.log("\nThe passage's own address must not count against the match");
// The bug the reviewer saw: a table drawn, and the same table printed again
// underneath as a run-on line. A chunk carries its address at the front of its
// text, those words are never in the table's cells, and counting them held the
// real duplicates at 0.72-0.79 — just under the threshold.
// A real one, from the document this was reported on. Heading paths run four
// levels deep, so the address is a substantial share of a short passage.
const ADDRESS =
  "Payor Management Audit SBD v1.1 › 3 SOLUTION ARCHITECTURE › " +
  "3.4 Technology Architecture › 3.4.2 Technology Stack";
// Built the way the chunk really is: the address, then the table's own header
// row, then its cells — which is what makes it indistinguishable from the table
// once the address is set aside.
const flattened =
  ADDRESS +
  " " +
  COLUMNS.join(" ") +
  " Container Management Platform" +
  " Relational DB (if any) MySQL instance on PCF CloudSQL/MySQL service v5.7.28 8.0" +
  " Messaging RabbitMQ";
ok(
  "counting the address, the duplicate survives — which is the bug",
  !quoteIsTable(flattened, [TABLE]),
);
ok(
  "ignoring it, the duplicate is recognised",
  quoteIsTable(flattened, [TABLE], ADDRESS),
);
ok(
  "and prose about the subject is still not a duplicate, address or no address",
  !quoteIsTable(
    ADDRESS +
      " The platform runs on Google Kubernetes Engine with a managed relational " +
      "database, and the team expects to revisit the messaging choice once throughput " +
      "is understood because the current broker was chosen for familiarity rather than " +
      "for its delivery guarantees under sustained load across several regions.",
    [TABLE],
    ADDRESS,
  ),
);
ok(
  "an address that eats the passage falls back to judging the whole of it",
  quoteIsTable(flattened, [TABLE], flattened) === quoteIsTable(flattened, [TABLE]),
);
ok("an empty address changes nothing", quoteIsTable(realQuote, [TABLE], "") === quoteIsTable(realQuote, [TABLE]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
