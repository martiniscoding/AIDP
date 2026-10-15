import { prisma } from "@/lib/prisma";
import type { TableView } from "./documents";
import type { EvidenceItem } from "./verdicts";

/**
 * The table a quoted passage came out of.
 *
 * A fifth of all the evidence text in this workspace is table cells printed as
 * a run-on line — 1,054 of 3,882 cited passages, 457,000 characters of
 * "Category: Programming Languages | Comments: V 11". That string is the
 * parser's reading transcript of a five-column row, with its three empty
 * columns dropped, and a reviewer checking a verdict against it is being asked
 * to reconstruct a table from its shadow.
 *
 * The table itself is stored and the link to it is exact: a chunk of kind
 * `table` or `table_row` carries the `TableBlock` id in `sourceId`. Nothing is
 * inferred here, and nothing needs re-running — this reads the link that every
 * finding already has, so reports written months ago get their tables back.
 */

export type EvidenceTable = {
  table: TableView;
  /**
   * Which row the passage was cited for, when it was cited for one. A
   * `table_row` chunk is a single row; showing the whole table without saying
   * which row would answer a question nobody asked. Null when the chunk is the
   * whole table, or when the row could not be identified beyond doubt.
   */
  row: number | null;
};

/** A cited passage, with the table it came out of when it came out of one. */
export type EvidenceView = EvidenceItem & { table: EvidenceTable | null };

/** Attach each passage's table, for the views that render findings. */
export function withTables(
  evidence: EvidenceItem[],
  tables: Map<string, EvidenceTable>,
): EvidenceView[] {
  return evidence.map((item) => ({ ...item, table: tables.get(item.chunkId) ?? null }));
}

const TABLE_KINDS = ["table", "table_row"];

/**
 * Tables for the passages these findings cite, keyed by chunk id.
 *
 * One query for the chunks and one for the tables, however many findings are on
 * the page. A report of eighty findings cites a few hundred passages and a
 * handful of distinct tables, so this is two round trips, not three hundred.
 */
export async function tablesForEvidence(
  chunkIds: string[],
): Promise<Map<string, EvidenceTable>> {
  const out = new Map<string, EvidenceTable>();
  const wanted = [...new Set(chunkIds.filter(Boolean))];
  if (wanted.length === 0) return out;

  const chunks = await prisma.chunk.findMany({
    where: { id: { in: wanted }, sourceKind: { in: TABLE_KINDS }, sourceId: { not: null } },
    select: { id: true, sourceId: true, sourceKind: true, text: true },
  });
  if (chunks.length === 0) return out;

  const tables = await prisma.tableBlock.findMany({
    where: { id: { in: [...new Set(chunks.map((c) => c.sourceId!))] } },
    select: {
      id: true,
      ordinal: true,
      caption: true,
      columns: true,
      rows: true,
      pageStart: true,
      confidence: true,
    },
  });
  const byId = new Map(tables.map((t) => [t.id, t]));

  for (const chunk of chunks) {
    const table = byId.get(chunk.sourceId!);
    // A chunk whose table has since been removed by a re-parse keeps its
    // flattened text rather than losing its evidence.
    if (!table) continue;
    out.set(chunk.id, {
      table,
      row: chunk.sourceKind === "table_row" ? citedRow(chunk.text, table.rows) : null,
    });
  }
  return out;
}

/**
 * Which row of a table a chunk's text was made from, or null.
 *
 * The chunk carries its heading path and section title before the row's own
 * words, so this asks which row's cells are present rather than comparing whole
 * strings. A row wins only outright: where two rows match equally well — which
 * happens in a table whose rows repeat a value, "N/A" down a column — the
 * answer is null and the table is shown without a highlight. A highlight on the
 * wrong row is worse than none, because it is a claim about where the evidence
 * came from.
 */
export function citedRow(chunkText: string, rows: unknown): number | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const haystack = normalise(chunkText);
  if (!haystack) return null;

  let best = -1;
  let bestScore = 0;
  let tied = false;

  rows.forEach((row, index) => {
    const values = cellValues(row)
      .map(normalise)
      // One- and two-character cells match everything. A cell has to be worth
      // matching on before it is allowed to decide where the evidence came from.
      .filter((value) => value.length >= 3);
    if (values.length === 0) return;
    const score = values.filter((value) => haystack.includes(value)).length;
    if (score === 0) return;
    if (score > bestScore) {
      bestScore = score;
      best = index;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  });

  return !tied && bestScore > 0 ? best : null;
}

function cellValues(row: unknown): string[] {
  if (Array.isArray(row)) return row.map(String);
  if (row && typeof row === "object") {
    return Object.values(row as Record<string, unknown>)
      .filter((value) => value !== null && value !== undefined)
      .map(String);
  }
  return [String(row)];
}

/** Whitespace and case flattened, so a line break in a cell is not a mismatch. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- coverage

/**
 * A coverage gap has no chunk to follow, so its table has to be recognised.
 *
 * A gap quotes the design to prove it is real — a quote that is not in the
 * document word for word gets the gap thrown away. Where the quoted passage is
 * a table, that proof is assembled from the section's own lines, and two clean
 * tables arrive as one run-on paragraph saying "Category:" sixteen times.
 *
 * The gap carries its heading path and page but not the table's id, so the test
 * is whether the quote is actually made of the section's tables: what share of
 * the quote's own words are in their cells and headers. Nothing below the
 * threshold is touched, because showing a table that is not what was quoted
 * would break the one promise the quote exists to keep.
 */

/** A quote has to be worth testing before a near-total match means anything. */
const MIN_QUOTE_WORDS = 20;

/** Below this the quote is its own prose and the tables are a coincidence. */
const COVERED_AT = 0.8;

export function quoteIsTable(quote: string, tables: TableView[]): boolean {
  const words = contentWords(quote);
  if (words.length < MIN_QUOTE_WORDS || tables.length === 0) return false;
  const inTables = new Set(tables.flatMap((table) => contentWords(tableText(table))));
  if (inTables.size === 0) return false;
  const hits = words.filter((word) => inTables.has(word)).length;
  return hits / words.length >= COVERED_AT;
}

/** Every word a table puts on the page: its headers and its cells. */
function tableText(table: TableView): string {
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const cells = rows.flatMap((row) => cellValues(row));
  return [...table.columns, ...cells].join(" ");
}

function contentWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((word) => word.length >= 3);
}

/**
 * The tables behind each coverage gap, keyed by the gap's section ordinal.
 *
 * Scoped to the run's own documents: a heading path is unique inside a design
 * and not across a workspace, and a gap borrowing another document's table
 * would be a quote about the wrong file.
 */
export async function tablesForGaps(
  documentIds: string[],
  gaps: { section: number; headingPath: string; quote: string }[],
): Promise<Record<number, TableView[]>> {
  // A plain object, not a Map: this crosses into a Client Component as a prop.
  const out: Record<number, TableView[]> = {};
  const paths = [...new Set(gaps.map((gap) => gap.headingPath).filter(Boolean))];
  if (documentIds.length === 0 || paths.length === 0) return out;

  const sections = await prisma.documentSection.findMany({
    where: { documentId: { in: documentIds }, headingPath: { in: paths } },
    select: {
      headingPath: true,
      tables: {
        select: {
          id: true,
          ordinal: true,
          caption: true,
          columns: true,
          rows: true,
          pageStart: true,
          confidence: true,
        },
        orderBy: { ordinal: "asc" },
      },
    },
  });

  const byPath = new Map<string, TableView[]>();
  for (const section of sections) {
    byPath.set(section.headingPath, [
      ...(byPath.get(section.headingPath) ?? []),
      ...section.tables,
    ]);
  }

  for (const gap of gaps) {
    const tables = byPath.get(gap.headingPath) ?? [];
    if (quoteIsTable(gap.quote, tables)) out[gap.section] = tables;
  }
  return out;
}
