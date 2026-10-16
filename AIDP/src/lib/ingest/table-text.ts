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

/** A row's cells, however the parser stored the row. */
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
      cellValues(row)
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" — "),
    )
    .filter(Boolean);
  return lines.length > 0 ? lines.join("; ") : null;
}
