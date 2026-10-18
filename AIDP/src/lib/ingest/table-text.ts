/**
 * A stored table as text — no database, no server-only imports.
 *
 * Split out of evidence-tables.ts for the same reason verdicts.ts was split
 * out of assessment.ts: that module reaches Prisma, which reaches
 * `node:module`, and a client component importing it fails the build with a
 * chunking error that names the component rather than the import that caused
 * it. The finding dialog quotes a cited row beside the clause, so it needs
 * this much and nothing else.
 *
 * Anything here must stay pure and dependency-free.
 */

import type { TableView } from "./documents";

/**
 * One row as the headers it belongs under, paired with its cells.
 *
 * A cited row reaches the reader as the parser's flattened line — "Source
 * access | BI dashboard directly queries Timekeeping DB | Against
 * no-direct-database-coupling policy" — and the pipes are all it is given. The
 * three fragments are a column heading's worth of meaning apart: the first is
 * an area of the design, the second is what the design chose, the third is the
 * design's own note on that choice. Without the headings a reader cannot tell
 * which is which, and a customer reading their own compliance report asked
 * exactly that: what do these lines mean.
 *
 * Mapped by column name, never by position. A stored row is an object keyed by
 * heading and its keys are in whatever order the parser wrote them — the
 * "Area, Rationale or issue, Decision / current choice" of one real table
 * against columns of "Area, Decision / current choice, Rationale or issue". So
 * `Object.values` would label the cells with the wrong headings, which is the
 * one thing worse than leaving them unlabelled. This follows `tableGrid`: the
 * columns decide the order, and a key the columns do not name goes on the end
 * where it is visible rather than lost.
 *
 * Empty cells are dropped, because this is a quotation of a row and not the
 * document's grid — the drawn table beneath it keeps every blank.
 */
export function rowCells(columns: string[], row: unknown): { column: string; value: string }[] {
  if (Array.isArray(row)) {
    return row
      .map((value, index) => ({ column: columns[index] ?? "", value: String(value ?? "").trim() }))
      .filter((cell) => cell.value.length > 0);
  }
  if (!row || typeof row !== "object") {
    const value = String(row ?? "").trim();
    return value ? [{ column: columns[0] ?? "", value }] : [];
  }
  const keyed = row as Record<string, unknown>;
  const extra = Object.keys(keyed).filter((key) => !columns.includes(key));
  return [...columns, ...extra]
    .map((column) => ({
      column,
      value:
        keyed[column] === null || keyed[column] === undefined ? "" : String(keyed[column]).trim(),
    }))
    .filter((cell) => cell.value.length > 0);
}

/**
 * A row's cells in no particular order, for asking whether a value is present.
 *
 * Stored rows are keyed by column and their key order is not the column order,
 * so these line up with nothing — see `rowCells` for cells a reader is shown.
 * Only ever used to ask "do these words appear", where order cannot matter.
 */
export function cellValues(row: unknown): string[] {
  if (Array.isArray(row)) return row.map(String);
  if (row && typeof row === "object") {
    return Object.values(row as Record<string, unknown>)
      .filter((value) => value !== null && value !== undefined)
      .map(String);
  }
  return [String(row)];
}

/**
 * The cited rows of a table as one line, for a side-by-side comparison.
 *
 * A contradiction is settled by a row — "Application pattern | Modular
 * monolith with catalogue, order, payment adapter" — and a reviewer holding
 * that against the clause should not have to find it in the drawing first.
 * Empty cells are dropped here, unlike the table itself, because this is a
 * quotation and not the document's own grid.
 */
export function citedRowText(table: TableView, rows: number[]): string | null {
  const all = Array.isArray(table.rows) ? table.rows : [];
  if (rows.length === 0) return null;
  const lines = rows
    .map((index) => all[index])
    .filter((row) => row !== undefined)
    .map((row) =>
      rowCells(table.columns, row)
        .map((cell) => cell.value)
        .join(" — "),
    )
    .filter(Boolean);
  return lines.length > 0 ? lines.join("; ") : null;
}
