/**
 * Tables on the parsed page: shaped right, and put back where they came from.
 *
 * Two bugs, found together. The source-line stream shows a table one flattened
 * row at a time — "Category: Programming Languages | Comments: V 11", a
 * five-column row with its three empty columns dropped by `_row_text` in
 * Workers/aidp/parsing/rules.py — and that stream leads the page for a design.
 * The faithful copy was already stored and already rendered into a real
 * `<table>`... which printed "[object Object]" in every cell, because
 * `TableBlock.rows` is an array of objects keyed by column header and the
 * renderer only handled arrays.
 *
 * So the good rendering was broken and the flat one was all anybody saw.
 *
 * The fixtures below are the real thing: columns and rows copied out of
 * table_block for "Payor Management Audit SBD v1.1[2]" § Technology Stack p18,
 * nulls and embedded newlines included.
 *
 * Run with:  npx tsx scripts/verify-parsed-tables.mts
 */
import { gridColumns, placeTables, tableGrid } from "../src/lib/ingest/parsed-tables";
import type { SourceLineView, TableView } from "../src/lib/ingest/documents";

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

const COLUMNS = [
  "Category",
  "Mainstream Technologies",
  "Non- Standard Technologies",
  "Reason for using non-mainstream technology",
  "Comments",
];

const table = (id: string, ordinal: number, rows: unknown): TableView => ({
  id,
  ordinal,
  caption: null,
  columns: COLUMNS,
  rows,
  pageStart: 18,
  confidence: 1,
});

const T7 = table("t7", 1, [
  {
    Category: "Programming Languages",
    Comments: "V 11",
    "Mainstream Technologies": null,
    "Non- Standard Technologies": null,
    "Reason for using non-mainstream technology": null,
  },
  {
    Category: "Microservices Frameworks",
    Comments: "V2.2.0",
    "Mainstream Technologies": null,
    "Non- Standard Technologies": null,
    "Reason for using non-mainstream technology": null,
  },
]);
const T8 = table("t8", 2, [
  {
    Category: "Relational DB (if any)",
    Comments: "v5.7.28\n8.0",
    "Mainstream Technologies": "MySQL instance on PCF\nCloudSQL/MySQL service",
    "Non- Standard Technologies": null,
    "Reason for using non-mainstream technology": null,
  },
]);

const line = (ordinal: number, ref: string, kind: string, text: string): SourceLineView => ({
  ordinal,
  ref,
  kind,
  page: 18,
  text,
});

console.log("\nA row keyed by column becomes a row of cells");
const grid = tableGrid(COLUMNS, T7.rows);
ok("every column gets a cell, not just the ones with values", grid[0].length === 5, grid[0]);
ok(
  "the values land under their own headers",
  grid[0][0] === "Programming Languages" && grid[0][4] === "V 11",
  grid[0],
);
ok(
  "and the empty ones stay empty rather than sliding left",
  grid[0][1] === "" && grid[0][2] === "" && grid[0][3] === "",
  grid[0],
);
ok(
  "nothing renders as [object Object]",
  !JSON.stringify(grid).includes("object Object"),
  grid,
);
ok(
  "a line break inside a cell survives, because it is two values",
  tableGrid(COLUMNS, T8.rows)[0][4] === "v5.7.28\n8.0",
  tableGrid(COLUMNS, T8.rows)[0][4],
);

console.log("\nOlder and odder shapes still render");
ok(
  "a positional row is still read positionally",
  tableGrid(["A", "B"], [["x", null]]).every((r) => r.length === 2) &&
    tableGrid(["A", "B"], [["x", null]])[0][1] === "",
);
ok("rows that are not an array give nothing", tableGrid(COLUMNS, null).length === 0);
ok(
  "a key the headers do not name is shown on the end, not dropped",
  gridColumns(["A"], [{ A: "1", Surprise: "2" }]).join(",") === "A,Surprise" &&
    tableGrid(gridColumns(["A"], [{ A: "1", Surprise: "2" }]), [{ A: "1", Surprise: "2" }])[0]
      .join(",") === "1,2",
);
ok(
  "and a nested object says what it is instead of [object Object]",
  tableGrid(["A"], [{ A: { oops: 1 } }])[0][0] === '{"oops":1}',
  tableGrid(["A"], [{ A: { oops: 1 } }])[0][0],
);

console.log("\nEach table goes back where the document had it");
const lines = [
  line(0, "L75", "heading", "5.4.2 Technology Stack"),
  line(1, "T7-h", "table_header", COLUMNS.join(" | ")),
  line(2, "T7-r1", "table_row", "Category: Programming Languages | Comments: V 11"),
  line(3, "T7-r2", "table_row", "Category: Microservices Frameworks | Comments: V2.2.0"),
  line(4, "L76", "text", "GCP"),
  line(5, "T8-h", "table_header", COLUMNS.join(" | ")),
  line(6, "T8-r1", "table_row", "Category: Relational DB (if any)"),
];
const { blocks, placed } = placeTables(lines, [T7, T8]);
ok(
  "the stream keeps its order: heading, table, text, table",
  blocks.map((b) => (b.kind === "line" ? b.line.ref : b.ref)).join(",") === "L75,T7,L76,T8",
  blocks.map((b) => (b.kind === "line" ? b.line.ref : b.ref)),
);
ok(
  "the nth table in the lines is the nth table stored",
  blocks[1].kind === "table" &&
    blocks[1].table?.id === "t7" &&
    blocks[3].kind === "table" &&
    blocks[3].table?.id === "t8",
);
ok("both were placed, so neither is listed again below", placed.size === 2);
ok(
  "a table's header and rows are all inside its block",
  blocks[1].kind === "table" && blocks[1].lines.length === 3,
  blocks[1].kind === "table" ? blocks[1].lines.length : null,
);
ok(
  "the text between two tables is not swallowed",
  blocks[2].kind === "line" && blocks[2].line.text === "GCP",
);

console.log("\nWhen the two sides disagree, nothing is invented and nothing is lost");
const short = placeTables(lines, [T7]);
ok(
  "a table with no stored counterpart keeps its flat lines",
  short.blocks[3].kind === "table" && short.blocks[3].table === null,
);
ok("and is not listed as placed", short.placed.size === 1 && short.placed.has("t7"));
ok(
  "every line still appears exactly once, whatever the matching did",
  (() => {
    const seen = short.blocks.flatMap((b) => (b.kind === "line" ? [b.line.ref] : b.lines.map((l) => l.ref)));
    return seen.join(",") === lines.map((l) => l.ref).join(",");
  })(),
);
ok(
  "a table stored with no lines at all is left for the section below",
  placeTables([line(0, "L1", "text", "no tables here")], [T7]).placed.size === 0,
);
ok(
  "rows with no header line still group into their table",
  (() => {
    const noHeader = [line(0, "T3-r1", "table_row", "a"), line(1, "T3-r2", "table_row", "b")];
    const out = placeTables(noHeader, [T7]);
    return out.blocks.length === 1 && out.blocks[0].kind === "table" && out.blocks[0].table?.id === "t7";
  })(),
);
ok(
  "and a table number that comes back later does not borrow another's grid",
  (() => {
    const split = [
      line(0, "T1-r1", "table_row", "a"),
      line(1, "L2", "text", "between"),
      line(2, "T1-r2", "table_row", "b"),
    ];
    const out = placeTables(split, [T7, T8]);
    return (
      out.blocks[0].kind === "table" &&
      out.blocks[0].table?.id === "t7" &&
      out.blocks[2].kind === "table" &&
      out.blocks[2].table === null
    );
  })(),
);
ok("no lines, no blocks", placeTables([], [T7]).blocks.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
