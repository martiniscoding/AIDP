import { prisma } from "@/lib/prisma";
import { gapKey } from "./coverage";
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
  return foldDuplicates(evidence.map((item) => ({ ...item, table: breachRow(item, tables) })));
}

/**
 * The passage's table, with the row the breach was quoted from marked on it.
 *
 * A `table` chunk is the whole table, so nothing in the chunk says which row
 * matters and the card is drawn with no highlight — "Quoted from this table",
 * above twelve rows, under a finding about one of them. Twelve of this
 * workspace's fifteen drawn tables read that way, and after the evidence was
 * reordered the first card a reviewer meets is one of them.
 *
 * But on a contradiction the judge now names the passage it convicted on and
 * the worker has already checked that quote against the design word for word
 * (see `_mark_breach` in Workers/aidp/stages/analyse.py). That quote is a row's
 * worth of text, so it can say what the chunk could not. Four of the twelve
 * resolve from it on this run.
 *
 * `citedRow` decides, which means the strict rule comes along too: a row wins
 * only outright, and a tie leaves the table unmarked. A highlight on the wrong
 * row of a customer's design is a claim about where a breach was found, and it
 * is worse than no highlight at all.
 *
 * The marked table is a new object. `tables` is keyed by chunk and shared by
 * every finding that cites that chunk, so marking a row in place would mark it
 * on another finding's evidence — which is the bug this shape avoids.
 */
function breachRow(
  item: EvidenceItem,
  tables: Map<string, EvidenceTable>,
): EvidenceTable | null {
  const found = tables.get(item.chunkId) ?? null;
  if (!found || found.rows.length > 0 || !item.breachQuote) return found;
  const row = citedRow(item.breachQuote, found.table.rows);
  return row === null ? found : { table: found.table, rows: [row] };
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

/** Kinds whose chunk is a table and carries its id in `sourceId`. */
const TABLE_KINDS = ["table", "table_row"];

/**
 * Kinds whose chunk may be a table flattened into a line, with no id to follow.
 *
 * The same cells reach the index a second way. A `clause` or `section` chunk is
 * built from its source's own text, and where that source is a table the cells
 * arrive as one unbroken run: "Rationale: or issue Application structure One
 * undifferentiated code unit Modular design exception not documented or
 * approved Database Two applications manipulate shared tables…" — 607
 * characters on one line, in which the column headers and the values cannot be
 * told apart. Retrieval has no reason to prefer the real table chunk over it,
 * so findings cite it: this one is the evidence behind three of this
 * workspace's seven contradictions, and the first card on one of them.
 *
 * These chunks point at a clause or a section rather than a table, so the table
 * has to be recognised instead of followed — see `tablesForEvidence`.
 */
const FLATTENED_KINDS = ["clause", "section"];

const TABLE_SELECT = {
  id: true,
  ordinal: true,
  caption: true,
  columns: true,
  rows: true,
  pageStart: true,
  confidence: true,
} as const;

/**
 * Tables for the passages these findings cite, keyed by chunk id.
 *
 * Two ways in. A `table` or `table_row` chunk carries the `TableBlock` id, so
 * that is a lookup and nothing is inferred. A `clause` or `section` chunk whose
 * source was a table carries no id at all, so its section's tables are fetched
 * and the chunk's own text is tested against them one at a time.
 *
 * That test has to be able to say "no". `quoteIsTable` asks what share of the
 * passage's words are in a table's cells and headers, with the passage's
 * address discounted, and a section holding three tables will match at most one
 * of them; anything else — two matches, none, a section of prose that merely
 * mentions the same terms — leaves the chunk as the text it was. Drawing the
 * wrong table under a verdict would be a claim about where the evidence came
 * from, and a reviewer has no way to catch it.
 *
 * A few queries for the whole page however many findings are on it: one for
 * the chunks, one for the clauses behind the flattened ones, and one for each
 * family of tables.
 */
export async function tablesForEvidence(
  chunkIds: string[],
): Promise<Map<string, EvidenceTable>> {
  const out = new Map<string, EvidenceTable>();
  const wanted = [...new Set(chunkIds.filter(Boolean))];
  if (wanted.length === 0) return out;

  const chunks = await prisma.chunk.findMany({
    where: {
      id: { in: wanted },
      sourceKind: { in: [...TABLE_KINDS, ...FLATTENED_KINDS] },
      sourceId: { not: null },
    },
    select: { id: true, sourceId: true, sourceKind: true, text: true, headingPath: true },
  });
  if (chunks.length === 0) return out;

  const direct = chunks.filter((c) => TABLE_KINDS.includes(c.sourceKind));
  const flattened = chunks.filter((c) => FLATTENED_KINDS.includes(c.sourceKind));

  if (direct.length > 0) {
    const tables = await prisma.tableBlock.findMany({
      where: { id: { in: [...new Set(direct.map((c) => c.sourceId!))] } },
      select: TABLE_SELECT,
    });
    const byId = new Map(tables.map((t) => [t.id, t]));

    for (const chunk of direct) {
      const table = byId.get(chunk.sourceId!);
      // A chunk whose table has since been removed by a re-parse keeps its
      // flattened text rather than losing its evidence.
      if (!table) continue;
      out.set(chunk.id, {
        table,
        rows: rowsCited(chunk.sourceKind, chunk.text, table.rows),
      });
    }
  }

  if (flattened.length > 0) {
    // A section chunk names its section outright; a clause chunk names the
    // clause, which names the section.
    const clauseIds = flattened
      .filter((c) => c.sourceKind === "clause")
      .map((c) => c.sourceId!);
    const sectionOfClause = new Map<string, string>();
    if (clauseIds.length > 0) {
      const clauses = await prisma.clause.findMany({
        where: { id: { in: [...new Set(clauseIds)] } },
        select: { id: true, sectionId: true },
      });
      for (const clause of clauses) sectionOfClause.set(clause.id, clause.sectionId);
    }

    const sectionIdOf = (chunk: { sourceKind: string; sourceId: string | null }) =>
      chunk.sourceKind === "section"
        ? chunk.sourceId
        : (sectionOfClause.get(chunk.sourceId!) ?? null);

    const sectionIds = [
      ...new Set(flattened.map(sectionIdOf).filter((id): id is string => Boolean(id))),
    ];
    if (sectionIds.length > 0) {
      const blocks = await prisma.tableBlock.findMany({
        where: { sectionId: { in: sectionIds } },
        select: { ...TABLE_SELECT, sectionId: true },
        orderBy: { ordinal: "asc" },
      });
      const bySection = new Map<string, TableView[]>();
      for (const { sectionId, ...table } of blocks) {
        bySection.set(sectionId, [...(bySection.get(sectionId) ?? []), table]);
      }

      for (const chunk of flattened) {
        const sectionId = sectionIdOf(chunk);
        const candidates = sectionId ? (bySection.get(sectionId) ?? []) : [];
        // Exactly one, or the passage stays as it is.
        const made = candidates.filter((table) =>
          quoteIsTable(chunk.text, [table], chunk.headingPath),
        );
        if (made.length !== 1) continue;
        const table = made[0]!;
        // A flattened whole table holds every row, so every row matches and
        // `citedRow` ties to null — which is the right answer. A flattened
        // single row resolves to that row.
        const row = citedRow(chunk.text, table.rows);
        out.set(chunk.id, { table, rows: row === null ? [] : [row] });
      }
    }
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
  gaps: {
    section: number;
    headingPath: string;
    quote: string;
    documentId: string | null;
  }[],
): Promise<Record<string, TableView[]>> {
  // A plain object, not a Map: this crosses into a Client Component as a prop.
  // Keyed by `gapKey`, not by section ordinal: two designs in one project both
  // have a section 6, and whichever was read second overwrote the other's
  // tables.
  const out: Record<string, TableView[]> = {};
  const paths = [...new Set(gaps.map((gap) => gap.headingPath).filter(Boolean))];
  if (documentIds.length === 0 || paths.length === 0) return out;

  const sections = await prisma.documentSection.findMany({
    where: { documentId: { in: documentIds }, headingPath: { in: paths } },
    select: {
      documentId: true,
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

  // Two maps, because a gap only knows which design it came from on a project
  // run. A heading path carries the design's title as its first element, so the
  // path alone rarely crosses designs — but "rarely" is not a guarantee worth
  // keying a reader's evidence on, so the design is used wherever it is known.
  const byDesignAndPath = new Map<string, TableView[]>();
  const byPath = new Map<string, TableView[]>();
  for (const section of sections) {
    const exact = `${section.documentId}\u0000${section.headingPath}`;
    byDesignAndPath.set(exact, [...(byDesignAndPath.get(exact) ?? []), ...section.tables]);
    byPath.set(section.headingPath, [
      ...(byPath.get(section.headingPath) ?? []),
      ...section.tables,
    ]);
  }

  for (const gap of gaps) {
    const tables = gap.documentId
      ? (byDesignAndPath.get(`${gap.documentId}\u0000${gap.headingPath}`) ?? [])
      : (byPath.get(gap.headingPath) ?? []);
    if (quoteIsTable(gap.quote, tables, gap.headingPath)) out[gapKey(gap)] = tables;
  }
  return out;
}

/** A design's name as a finding's prose would write it. */
function designAliases(title: string): string[] {
  const trimmed = title.trim();
  if (!trimmed) return [];
  const out = [trimmed.toLowerCase(), trimmed.replace(/\s*\([^)]*\)/g, "").trim().toLowerCase()];
  // "Workforce Analytics Hub (WAH)" is written "WAH" as often as in full.
  for (const match of trimmed.matchAll(/\(([A-Za-z]{2,8})\)/g)) out.push(match[1]!.toLowerCase());
  // Two letters match inside ordinary words; three is the shortest acronym
  // these documents actually use.
  return [...new Set(out)].filter((alias) => alias.length >= 3);
}

/** Whether a finding's own prose names this design. */
function rationaleNames(rationale: string, title: string): boolean {
  const text = rationale.toLowerCase();
  return designAliases(title).some((alias) =>
    new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text),
  );
}

/**
 * The cited passages in the order that answers the finding.
 *
 * Retrieval ranks a passage by how well it matches the clause, which is the
 * right question to put to a search engine and the wrong order to read a
 * verdict in. On a project run every design is searched for every clause, so a
 * finding about one design routinely cites passages from the others — and
 * because those passages are about the same subject, they can rank first.
 *
 * What that does to a reader is the whole reason this exists. Over this
 * workspace's seven contradictions, four cite a design their own rationale
 * never mentions, and on two of them that design is the *first* card. The worst
 * reads: the finding says the Rapid Campaign Launch Portal has no central
 * monitoring, and the first piece of evidence offered is the Customer Order
 * Platform's "Observability | Aligned by design" — a different design, passing
 * the very clause, presented as the proof that this one failed it. A reviewer
 * who opens that evidence has been told the report cannot keep its designs
 * straight, and they are right to stop trusting it.
 *
 * So three bands, stable within each:
 *
 *   1. the passage the judge convicted on, where it named one (`breachQuote`)
 *   2. passages from a design the rationale actually names
 *   3. everything else, which is context and reads as context
 *
 * Nothing is dropped — band three is still on the card, still citable, still
 * part of the audit trail. Only the reading order changes, and it changes at
 * read, so every report already written is in the right order the next time it
 * is opened.
 */
export function orderEvidence(evidence: EvidenceView[], rationale: string): EvidenceView[] {
  if (evidence.length < 2) return evidence;
  // Resolved once per design rather than once per card: a finding citing eight
  // passages from three designs would otherwise run the same regex eight times.
  const named = new Map<string, boolean>();
  const band = (item: EvidenceView): number => {
    if (item.breachQuote) return 0;
    const title = item.documentTitle ?? "";
    if (!title.trim()) return 2;
    let hit = named.get(title);
    if (hit === undefined) {
      hit = rationaleNames(rationale, title);
      named.set(title, hit);
    }
    return hit ? 1 : 2;
  };
  return evidence
    .map((item, index) => ({ item, index, band: band(item) }))
    .sort((a, b) => a.band - b.band || a.index - b.index)
    .map((entry) => entry.item);
}

/**
 * The table a clause's own statement was flattened out of, by clause id.
 *
 * The same fault as the evidence, on the other half of the comparison. Four of
 * this workspace's clauses are a two-column table in the standard — "DMLC
 * PHASE | Usage and Sharing", with a row each for FOCUS AREA, RATIONALE,
 * GUIDELINES and DATA PRINCIPLES — and the statement stored on a finding is
 * that whole grid run into one string. It reaches "The standard requires" as
 * 1,971 characters opening "DMLC PHASE: FOCUS AREA | Usage and Sharing:
 * Governed Data Access and Integration DMLC PHASE: GUIDELINES | …", and 87
 * findings are judged against one of them.
 *
 * It was tempting to call that a parsing problem and send it back for a
 * re-parse. It is not: the table is stored, the clause names its section, and
 * the four rows are exactly the structure the reader is being asked to
 * reconstruct in their head. So it is drawn, like the evidence is.
 *
 * `quoteIsTable` decides, and must match exactly one of the section's tables —
 * a clause whose statement is prose that merely shares vocabulary with a table
 * nearby keeps its paragraph. The clause reference is passed as the address so
 * the heading words are not counted as a match against the cells.
 */
export async function tablesForStatements(
  clauses: { id: string; statement: string; ref: string }[],
): Promise<Map<string, TableView>> {
  const out = new Map<string, TableView>();
  // Only a statement that still carries the flattening is worth a lookup.
  const wanted = clauses.filter((c) => c.statement.includes(" | "));
  if (wanted.length === 0) return out;

  const rows = await prisma.clause.findMany({
    where: { id: { in: [...new Set(wanted.map((c) => c.id))] } },
    select: { id: true, sectionId: true },
  });
  const sectionOf = new Map(rows.map((r) => [r.id, r.sectionId]));
  const sectionIds = [...new Set(rows.map((r) => r.sectionId))];
  if (sectionIds.length === 0) return out;

  const blocks = await prisma.tableBlock.findMany({
    where: { sectionId: { in: sectionIds } },
    select: { ...TABLE_SELECT, sectionId: true },
    orderBy: { ordinal: "asc" },
  });
  const bySection = new Map<string, TableView[]>();
  for (const { sectionId, ...table } of blocks) {
    bySection.set(sectionId, [...(bySection.get(sectionId) ?? []), table]);
  }

  for (const clause of wanted) {
    const sectionId = sectionOf.get(clause.id);
    const candidates = sectionId ? (bySection.get(sectionId) ?? []) : [];
    const made = candidates.filter((table) =>
      quoteIsTable(clause.statement, [table], clause.ref),
    );
    if (made.length === 1) out.set(clause.id, made[0]!);
  }
  return out;
}
