import { prisma } from "@/lib/prisma";
import { requireMembership } from "./org";

/**
 * Reads over ingested documents, always scoped to an organisation the caller
 * has been checked against.
 *
 * Every function here takes `userId` alongside `organisationId` and verifies
 * membership before it touches a row. Passing an organisation id from a URL
 * straight into a query is the whole class of bug this is shaped to prevent.
 */

/** The pipeline, in order. Drives the progress rail in the UI. */
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

  // One grouped query rather than N per document — the library lists every
  // document an organisation has, and issue counts are shown on each row.
  const issues = await prisma.ingestIssue.groupBy({
    by: ["documentId", "severity"],
    where: { document: { organisationId }, kind: { notIn: UNANNOUNCED } },
    _count: { _all: true },
  });

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
    issues: bySeverity.get(doc.id) ?? { high: 0, medium: 0, low: 0 },
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
          clauses: { orderBy: { ordinal: "asc" } },
          tables: { orderBy: { ordinal: "asc" } },
          figures: { orderBy: { ordinal: "asc" } },
        },
      },
      _count: { select: { chunks: true } },
    },
  });
  if (!document) return null;

  // Membership is checked against the row's own organisation, so a guessed id
  // cannot be used to confirm that a document exists.
  await requireMembership(userId, document.organisationId);
  return document;
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
