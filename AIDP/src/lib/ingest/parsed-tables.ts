import type { SourceLineView, TableView } from "./documents";

/**
 * Tables, put back where the document had them and shaped as the document
 * shaped them.
 *
 * Two things were wrong with the parsed view, and they compounded.
 *
 * The source-line stream is a reading-order transcript of what the parser read
 * off the page, and a table arrives in it one flattened row at a time —
 * "Category: Programming Languages | Comments: V 11". That is deliberate: it is
 * the audit record of the parse, and it is what the clause-reading model is
 * given. It is also lossy, on purpose. `_row_text` in
 * Workers/aidp/parsing/rules.py drops empty cells, so the row above is missing
 * the three blank columns between its two values, and a row that renders empty
 * is dropped from the stream entirely. A reader cannot reconstruct the grid
 * from it, and should not have to try.
 *
 * The faithful copy is already stored. `TableBlock` keeps the column headers,
 * every row, and every empty cell as an explicit null — never omitted, because
 * dropping one shifts every later value a column left and turns "not specified"
 * into the previous row's answer. The parsed page rendered it into a real
 * `<table>`... and printed "[object Object]" in every cell, because the rows are
 * objects keyed by column header and the renderer only handled arrays. So the
 * good rendering was broken and the flat one was all anybody ever saw.
 *
 * Both halves are fixed here rather than in the component, for the reason
 * `applyLens` lives beside the verdicts: the component is a Client Component,
 * every line reaches the browser in its props whether or not it is drawn, and
 * "did the table render correctly?" is unanswerable from the HTML. A rule that
 * can be tested as a rule is tested as a rule.
 */

/** The parser's handle for a table line: "T7-h" is a header, "T7-r3" a row. */
const TABLE_REF = /^T(\d+)-/;

export type LineBlock =
  | { kind: "line"; line: SourceLineView }
  /**
   * A run of table lines, with the table they belong to when one was matched.
   * `table: null` means no match was found, and the lines are shown as they
   * were — a wrong table in the right place is worse than a flat one.
   */
  | { kind: "table"; ref: string; lines: SourceLineView[]; table: TableView | null };

/**
 * Lay the section's lines out, with each table's run replaced by the table.
 *
 * The matching is by order, which is the only thing the two sides agree on. The
 * line refs number tables as the parser met them in the document — T7, T8 — and
 * `TableBlock.ordinal` numbers them within the section, so the numbers differ
 * and only the sequence lines up. The nth distinct table in this section's lines
 * is the nth table stored for it.
 *
 * Where that runs out — more runs of table lines than tables stored, or a run of
 * a table number already placed — the run keeps its flat lines instead of
 * borrowing another table's grid. Nothing is ever hidden: every line either
 * appears in a block of its own or inside a table that was matched to it.
 */
export function placeTables(
  lines: SourceLineView[],
  tables: TableView[],
): { blocks: LineBlock[]; placed: Set<string> } {
  const blocks: LineBlock[] = [];
  const placed = new Set<string>();
  // First appearance decides a table's position, so a stream that returns to an
  // earlier table — which the parser does not do, but which would silently
  // misalign everything after it if it did — cannot shift the ones behind it.
  const order: number[] = [];
  const used = new Set<number>();

  let run: { number: number; lines: SourceLineView[] } | null = null;

  const flush = () => {
    if (!run) return;
    const index = order.indexOf(run.number);
    const first = !used.has(run.number);
    const table = first && index >= 0 ? (tables[index] ?? null) : null;
    if (table) {
      used.add(run.number);
      placed.add(table.id);
    }
    blocks.push({ kind: "table", ref: `T${run.number}`, lines: run.lines, table });
    run = null;
  };

  for (const line of lines) {
    const match = TABLE_REF.exec(line.ref);
    if (!match) {
      flush();
      blocks.push({ kind: "line", line });
      continue;
    }
    const number = Number(match[1]);
    if (!order.includes(number)) order.push(number);
    if (run && run.number !== number) flush();
    if (!run) run = { number, lines: [] };
    run.lines.push(line);
  }
  flush();

  return { blocks, placed };
}

/**
 * A table's rows as a grid, one cell per column, in the columns' own order.
 *
 * `TableBlock.rows` is an array of objects keyed by column header. Reading them
 * positionally is what produced "[object Object]" in every cell of every table
 * on this page; reading them by key is also what keeps a blank cell blank
 * instead of letting the next value slide into it.
 *
 * Arrays are still accepted, because a table stored before the keyed shape
 * existed is still a table somebody may be looking at.
 */
export function tableGrid(columns: string[], rows: unknown): string[][] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (Array.isArray(row)) {
      return row.map(cellText);
    }
    if (row && typeof row === "object") {
      const keyed = row as Record<string, unknown>;
      // Keyed by column, so the columns decide the order and the width. A key
      // the columns do not name is not dropped silently — it goes on the end,
      // where it is visible rather than lost.
      const extra = Object.keys(keyed).filter((key) => !columns.includes(key));
      return [...columns, ...extra].map((column) => cellText(keyed[column]));
    }
    return [cellText(row)];
  });
}

/** Columns to draw, once a row has turned out to carry more than the headers. */
export function gridColumns(columns: string[], rows: unknown): string[] {
  if (!Array.isArray(rows)) return columns;
  const extra: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (!columns.includes(key) && !extra.includes(key)) extra.push(key);
    }
  }
  return [...columns, ...extra];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // An object in a cell is a parse that went wrong. Saying so beats printing
  // "[object Object]" and leaving the reader to work out what happened.
  return JSON.stringify(value);
}
