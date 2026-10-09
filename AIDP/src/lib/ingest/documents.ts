import { prisma } from "@/lib/prisma";
import { requireMembership } from "./org";
import { describePipeline, JOB_SELECT, STAGES, type JobRow } from "./pipeline";

/**
 * Reads over ingested documents, always scoped to an organisation the caller
 * has been checked against.
 *
 * Every function here takes `userId` alongside `organisationId` and verifies
 * membership before it touches a row. Passing an organisation id from a URL
 * straight into a query is the whole class of bug this is shaped to prevent.
 */

/**
 * A document's statuses, in order. What each stage is doing inside that status
 * comes from its job — see `describePipeline` in ./pipeline.ts.
 */
export const PIPELINE = ["pending", "parsing", "chunking", "embedding", "ready"] as const;
export type Status = (typeof PIPELINE)[number] | "failed";

export const STATUS_LABEL: Record<string, string> = {
  pending: "Queued",
  parsing: "Reading the document",
  chunking: "Splitting into clauses",
  embedding: "Building the index",
  ready: "Ready",
  failed: "Failed",
};

export function isTerminal(status: string): boolean {
  return status === "ready" || status === "failed";
}

/**
 * Notices kept out of what a reader sees.
 *
 * Both say "a model read this document's structure", which is now true of every
 * standard, deck and workbook — a notice on every upload is noise, and it
 * teaches people to skip the ones that matter. The worker no longer writes
 * them; this also hides the ones already stored, and any written by a worker
 * that has not been redeployed yet.
 */
const UNANNOUNCED = ["structure_inferred", "rules_by_model"];

export async function listDocuments(userId: string, organisationId: string) {
  await requireMembership(userId, organisationId);

  const documents = await prisma.document.findMany({
    where: { organisationId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      docCode: true,
      version: true,
      role: true,
      status: true,
      failureReason: true,
      sensitivity: true,
      pageCount: true,
      profile: true,
      byteSize: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { sections: true, chunks: true } },
    },
  });

  // Jobs only for documents still on their way in; a finished one shows a tick.
  const unfinished = documents.filter((doc) => doc.status !== "ready").map((doc) => doc.id);

  // One grouped query rather than N per document — the library lists every
  // document an organisation has, and issue counts are shown on each row.
  // How many clauses each standard contributes. The number is what removing one
  // actually costs — a standard is its clauses, and "delete this document" says
  // nothing about the twelve rules every future assessment would stop checking.
  // Clause hangs off DocumentSection, so there is no direct count to ask for.
  const standards = documents.filter((doc) => doc.role !== "assessed").map((doc) => doc.id);

  const [issues, jobs, sections] = await Promise.all([
    prisma.ingestIssue.groupBy({
      by: ["documentId", "severity"],
      where: { document: { organisationId }, kind: { notIn: UNANNOUNCED } },
      _count: { _all: true },
    }),
    unfinished.length
      ? prisma.job.findMany({
          where: { documentId: { in: unfinished }, stage: { in: [...STAGES] } },
          select: { documentId: true, ...JOB_SELECT },
        })
      : Promise.resolve([]),
    standards.length
      ? prisma.documentSection.findMany({
          where: { documentId: { in: standards } },
          select: { documentId: true, _count: { select: { clauses: true } } },
        })
      : Promise.resolve([]),
  ]);

  const clausesByDocument = new Map<string, number>();
  for (const section of sections) {
    clausesByDocument.set(
      section.documentId,
      (clausesByDocument.get(section.documentId) ?? 0) + section._count.clauses,
    );
  }

  const jobsByDocument = new Map<string, JobRow[]>();
  for (const { documentId, ...job } of jobs) {
    // The query asked for these documents, so every row has one. A project
    // run's analyse job, which has none, cannot appear here.
    if (!documentId) continue;
    const list = jobsByDocument.get(documentId) ?? [];
    list.push(job);
    jobsByDocument.set(documentId, list);
  }
  const now = new Date();

  const bySeverity = new Map<string, { high: number; medium: number; low: number }>();
  for (const row of issues) {
    const entry = bySeverity.get(row.documentId) ?? { high: 0, medium: 0, low: 0 };
    if (row.severity === "high") entry.high += row._count._all;
    else if (row.severity === "medium") entry.medium += row._count._all;
    else entry.low += row._count._all;
    bySeverity.set(row.documentId, entry);
  }

  return documents.map((doc) => ({
    ...doc,
    /** Clauses this document contributes to the framework. Zero for a design. */
    clauses: clausesByDocument.get(doc.id) ?? 0,
    issues: bySeverity.get(doc.id) ?? { high: 0, medium: 0, low: 0 },
    pipeline:
      doc.status === "ready" ? null : describePipeline(doc, jobsByDocument.get(doc.id) ?? [], now),
  }));
}

export async function getDocument(userId: string, documentId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      issues: {
        where: { kind: { notIn: UNANNOUNCED } },
        orderBy: [{ severity: "asc" }, { page: "asc" }],
      },
      sections: {
        orderBy: { ordinal: "asc" },
        include: {
          // The live library, not its history. A clause sharpened from an
          // assessment leaves its earlier version on the record (see
          // Clause.supersededById), and counting both would tell the page this
          // standard has more clauses than the worker will ever judge.
          clauses: { where: { supersededById: null }, orderBy: { ordinal: "asc" } },
          tables: { orderBy: { ordinal: "asc" } },
          figures: { orderBy: { ordinal: "asc" } },
        },
      },
      _count: { select: { chunks: true } },
      jobs: { where: { stage: { in: [...STAGES] } }, select: JOB_SELECT },
      // Named, not just referenced: the report offers to limit a ruling to the
      // design's project, and an offer that cannot say which project is one
      // nobody should accept. Null for a standard, and for a design that
      // predates projects.
      project: { select: { id: true, name: true } },
    },
  });
  if (!document) return null;

  // Membership is checked against the row's own organisation, so a guessed id
  // cannot be used to confirm that a document exists.
  await requireMembership(userId, document.organisationId);
  const { jobs, ...rest } = document;
  return { ...rest, pipeline: describePipeline(rest, jobs) };
}

/** Live pipeline state for the status poller. Cheap enough to hit on a timer. */
export async function documentStatuses(userId: string, organisationId: string) {
  await requireMembership(userId, organisationId);
  const rows = await prisma.document.findMany({
    where: { organisationId },
    select: { id: true, status: true, updatedAt: true },
  });
  return rows;
}

export async function embeddingCoverage(userId: string, documentId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { organisationId: true },
  });
  if (!document) return { chunks: 0, embedded: 0 };
  await requireMembership(userId, document.organisationId);

  const chunks = await prisma.chunk.count({ where: { documentId } });
  const embedded = await prisma.embedding.count({ where: { chunk: { documentId } } });
  return { chunks, embedded };
}

// ---------------------------------------------------------------------------
// What one section actually yielded
// ---------------------------------------------------------------------------

/** A line of the source, as the parse stage read it off the page. */
export type SourceLineView = {
  ordinal: number;
  /** The parser's own handle for it. Clauses cite these in `sourceRefs`. */
  ref: string;
  /** "heading" | "text" | "bullet" | "table_row" | … */
  kind: string;
  page: number | null;
  text: string;
};

/** A clause, with the parts it was sliced into kept apart. */
export type ClauseView = {
  id: string;
  /** Its place in the section's reading order. A clause carries no number of
   *  its own — the reference comes from the section, which is why a decision
   *  anchored to §9.3 still finds a clause that was sharpened later. */
  ordinal: number;
  title: string | null;
  statement: string;
  rationale: string;
  requirements: string[];
  guidance: string[];
  /** "parser" | "model" | "restored" | "authored" — how it was found. */
  origin: string;
  pageStart: number | null;
  /**
   * Which source lines each part came from, for a clause a model read.
   * `{ statement: ["L12"], requirements: [{ refs: ["L14"], strength: "must" }] }`
   * and so on — see Clause.sourceRefs.
   */
  sourceRefs: unknown;
};

export type TableView = {
  id: string;
  ordinal: number;
  caption: string | null;
  columns: string[];
  rows: unknown;
  pageStart: number | null;
  /** Below 1 the parser was unsure of the shape. Worth seeing. */
  confidence: number;
};

export type SectionContent = {
  section: {
    id: string;
    ordinal: number;
    numberText: string | null;
    title: string;
    headingPath: string;
    pageStart: number | null;
    pageEnd: number | null;
    isEmpty: boolean;
  };
  /** "reference" or "assessed" — which half of this is the payload. */
  role: string;
  lines: SourceLineView[];
  clauses: ClauseView[];
  tables: TableView[];
};

/**
 * Everything one section yielded, fetched when somebody asks for it.
 *
 * The parsed page's outline says how many clauses, tables and figures each
 * section produced. How many is not what, and a count cannot tell a good parse
 * from a bad one: "2 clauses" reads the same whether the parser found two rules
 * or sliced one in half. This is the other half of that page — the text behind
 * the number.
 *
 * One section at a time, rather than the whole document with the outline. A
 * design in this corpus runs to 6,328 source lines across 85 sections, and
 * sending all of it to draw an outline nobody has expanded yet would make the
 * page slow for the one case it is most needed in.
 *
 * Lines are matched by `sectionOrdinal` rather than by a foreign key, because
 * that is how the parse stage records them: a line belongs to the section whose
 * ordinal it fell under. A document processed before page text was stored has
 * none, and says so by returning an empty list rather than by failing.
 */
export async function sectionContent(
  userId: string,
  documentId: string,
  sectionId: string,
): Promise<SectionContent | null> {
  const section = await prisma.documentSection.findFirst({
    where: { id: sectionId, documentId },
    select: {
      id: true,
      ordinal: true,
      numberText: true,
      title: true,
      headingPath: true,
      pageStart: true,
      pageEnd: true,
      isEmpty: true,
      document: { select: { organisationId: true, role: true } },
      clauses: {
        where: { supersededById: null },
        orderBy: { ordinal: "asc" },
        select: {
          id: true,
          ordinal: true,
          title: true,
          statement: true,
          rationale: true,
          requirements: true,
          guidance: true,
          origin: true,
          pageStart: true,
          sourceRefs: true,
        },
      },
      tables: {
        orderBy: { ordinal: "asc" },
        select: {
          id: true,
          ordinal: true,
          caption: true,
          columns: true,
          rows: true,
          pageStart: true,
          confidence: true,
        },
      },
    },
  });
  if (!section) return null;

  // Against the section's own organisation, so a guessed id cannot be used to
  // confirm that a document exists.
  await requireMembership(userId, section.document.organisationId);

  const lines = await prisma.sourceLine.findMany({
    where: { documentId, sectionOrdinal: section.ordinal },
    orderBy: { ordinal: "asc" },
    select: { ordinal: true, ref: true, kind: true, page: true, text: true },
  });

  const { document, clauses, tables, ...rest } = section;
  return { section: rest, role: document.role, lines, clauses, tables };
}
