import { prisma } from "@/lib/prisma";
import type { TableView } from "./documents";
import { cellValues } from "./table-text";
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
   * Which rows the passage was cited for. A `table_row` chunk is a single row;
   * showing the whole table without saying which row would answer a question
   * nobody asked. Empty when the chunk is the whole table, when the row could
   * not be identified beyond doubt, or when several citations of one table
   * were folded together and disagreed about the row.
   */
  rows: number[];
};

/** A cited passage, with the table it came out of when it came out of one. */
export type EvidenceView = EvidenceItem & { table: EvidenceTable | null };

/**
 * Attach each passage's table, for the views that render findings, and show
 * each distinct passage once.
 *
 * A table arrives in the index up to four ways — as a `table` chunk, as one
 * `table_row` chunk per row, and again inside the `clause` and `section`
 * chunks that carry the same cells flattened into a line. Retrieval has no
 * reason to prefer one, so a finding routinely cites several of them and the
 * reviewer is handed the same table three times: once drawn, once drawn with a
 * row marked, and once as the run-on transcript the drawing exists to replace.
 *
 * Nothing is thrown away here that the reviewer did not already have. A
 * passage is dropped only when another passage on screen contains it.
 */
export function withTables(
  evidence: EvidenceItem[],
  tables: Map<string, EvidenceTable>,
): EvidenceView[] {
  return foldDuplicates(
    evidence.map((item) => ({ ...item, table: tables.get(item.chunkId) ?? null })),
  );
}

/** Two passages are the same prose when each is nearly all of the other. */
const SAME_PROSE_AT = 0.9;

function foldDuplicates(items: EvidenceView[]): EvidenceView[] {
  // One card per table. The rows every citation of it marked are merged, so
  // two cited rows light up one table rather than drawing it twice.
  //
  // The merged entry is rebuilt rather than edited: `tables` is keyed by chunk
  // and shared by every finding that cites that chunk, and marking a row on it
  // in place would mark that row on another finding's evidence.
  const folded: EvidenceView[] = [];
  const byTable = new Map<string, EvidenceView>();
  for (const item of items) {
    if (!item.table) {
      folded.push(item);
      continue;
    }
    const key = `${item.documentId}\u0000${item.table.table.id}`;
    const kept = byTable.get(key);
    if (!kept || !kept.table) {
      const copy = { ...item, table: { ...item.table, rows: [...item.table.rows] } };
      byTable.set(key, copy);
      folded.push(copy);
      continue;
    }
    kept.table.rows = [...new Set([...kept.table.rows, ...item.table.rows])].sort(
      (a, b) => a - b,
    );
  }

  // The flattened twins. A passage with no table of its own goes only when the
  // tables already on screen for its own document account for it — the same
  // test the coverage gaps use, so a reviewer sees one rule applied in both
  // places. Scoped per document: another design's table is not this passage.
  const shown = new Map<string, TableView[]>();
  for (const item of folded) {
    if (!item.table) continue;
    const list = shown.get(item.documentId) ?? [];
    list.push(item.table.table);
    shown.set(item.documentId, list);
  }

  const kept: EvidenceView[] = [];
  for (const item of folded) {
    // A figure carries an image that no table restates, and a passage that
    // resolved to a table is a card in its own right.
    if (item.table || item.figureId) {
      kept.push(item);
      continue;
    }
    const address = `${item.documentTitle} ${item.headingPath}`;
    if (quoteIsTable(item.excerpt, shown.get(item.documentId) ?? [], address)) continue;
    // The run-on twins also duplicate each other: the `clause` chunk and the
    // `section` chunk over one table differ only in where the flattening
    // started. Where two are the same text, the longer one is the whole of it.
    const twin = kept.find(
      (other) =>
        !other.table &&
        !other.figureId &&
        other.documentId === item.documentId &&
        sameProse(other.excerpt, item.excerpt),
    );
    if (twin) {
      if (contentWords(item.excerpt).length > contentWords(twin.excerpt).length) {
        kept[kept.indexOf(twin)] = item;
      }
      continue;
    }
    kept.push(item);
  }
  return kept;
}

/** Each passage nearly all of the other's words, in both directions. */
function sameProse(a: string, b: string): boolean {
  const left = contentWords(a);
  const right = contentWords(b);
  if (left.length < MIN_QUOTE_WORDS || right.length < MIN_QUOTE_WORDS) return false;
  return covered(left, right) >= SAME_PROSE_AT && covered(right, left) >= SAME_PROSE_AT;
}

/** What share of `words` appears in `within`. */
function covered(words: string[], within: string[]): number {
  const have = new Set(within);
  if (have.size === 0 || words.length === 0) return 0;
  return words.filter((word) => have.has(word)).length / words.length;
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
      rows: rowsCited(chunk.sourceKind, chunk.text, table.rows),
    });
  }
  return out;
}

/** The rows a chunk marks on its table: one for a row chunk, none for a whole. */
function rowsCited(sourceKind: string, text: string, rows: unknown): number[] {
  if (sourceKind !== "table_row") return [];
  const row = citedRow(text, rows);
  return row === null ? [] : [row];
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

/** Too little left after the address to judge the passage by what remains. */
const MIN_CONTENT_WORDS = 8;

export function quoteIsTable(
  quote: string,
  tables: TableView[],
  /**
   * The passage's own address — the design it is from and its heading path.
   *
   * A chunk carries its address at the front of its text: "Customer Order
   * Platform (COP) › 4 Application and infrastructure decisions Area Decision
   * / current choice …". Those words are where the passage is, not what it
   * says, and they are never in the table's cells. Counting them against the
   * match held the real duplicates at 0.72–0.79 — just under the threshold —
   * so a table the reviewer was already looking at was printed again
   * underneath it as a run-on line. Thirty-seven of them, on this workspace's
   * findings alone, several of which are the table and nothing else.
   */
  address = "",
): boolean {
  const words = contentWords(quote);
  if (words.length < MIN_QUOTE_WORDS || tables.length === 0) return false;

  const inTables = new Set(tables.flatMap((table) => contentWords(tableText(table))));
  if (inTables.size === 0) return false;

  const content = subtract(words, address);
  // Below this the address has eaten the passage and a ratio over what is left
  // means nothing, so the question is asked of the whole passage instead.
  const tested = content.length >= MIN_CONTENT_WORDS ? content : words;

  const hits = tested.filter((word) => inTables.has(word)).length;
  return hits / tested.length >= COVERED_AT;
}

/** The passage's words with its address removed, keeping duplicates in place. */
function subtract(words: string[], address: string): string[] {
  if (!address.trim()) return words;
  const drop = new Set(contentWords(address));
  return drop.size === 0 ? words : words.filter((word) => !drop.has(word));
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
    if (quoteIsTable(gap.quote, tables, gap.headingPath)) out[gap.section] = tables;
  }
  return out;
}
