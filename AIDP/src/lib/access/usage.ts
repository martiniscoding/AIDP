import { prisma } from "@/lib/prisma";

// Re-exported so server-side callers still get it from here; it lives in its
// own module because Client Components need it and cannot import Prisma.
export { formatTokens } from "./format";

/**
 * Model spend, recorded and rolled up.
 *
 * Two writers put rows in `token_usage`: the Python workers, which do the
 * expensive work (Workers/aidp/usage.py), and this module, for the handful of
 * calls the app makes itself. They share a table because an administrator
 * asking what a person has cost does not care which process made the request.
 *
 * Everything here is honest about precision. Chat completions report their own
 * token counts and are recorded exactly; embedding endpoints report nothing, so
 * those rows are estimated from input size and carry `estimated = true`. A
 * total that mixes the two says how much of itself is a guess rather than
 * quietly rounding the distinction away.
 */

/**
 * Tokens in a string, roughly.
 *
 * Four characters per token is the long-standing rule of thumb for English
 * prose in a byte-pair vocabulary, and these documents are English prose. It
 * runs maybe fifteen percent low on dense technical text full of identifiers.
 * That is acceptable for a spend indicator and is why the rows are flagged;
 * it would not be acceptable for billing, and nothing here bills anyone.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export type UsageRecord = {
  organisationId: string;
  userId?: string | null;
  documentId?: string | null;
  runId?: string | null;
  stage: string;
  kind: "llm" | "embedding";
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;
};

/**
 * Write one usage row.
 *
 * Never throws. A failure to record what something cost must not fail the thing
 * itself — losing a row costs an administrator a slightly low number, whereas
 * propagating the error would cost the user their assessment.
 */
export async function record(usage: UsageRecord): Promise<void> {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  try {
    await prisma.tokenUsage.create({
      data: {
        organisationId: usage.organisationId,
        userId: usage.userId ?? null,
        documentId: usage.documentId ?? null,
        runId: usage.runId ?? null,
        stage: usage.stage,
        kind: usage.kind,
        provider: usage.provider,
        model: usage.model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimated: usage.estimated ?? false,
      },
    });
  } catch {
    // Deliberately swallowed. See the note above.
  }
}

export type SpendByPerson = {
  userId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

export type SpendByStage = { stage: string; totalTokens: number; calls: number };

export type OrganisationSpend = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** Share of `totalTokens` that came from an estimate rather than a provider. */
  estimatedTokens: number;
  byPerson: SpendByPerson[];
  byStage: SpendByStage[];
  since: Date | null;
};

/**
 * What an organisation has spent, optionally over a window.
 *
 * Grouped in the database rather than by loading rows: a busy customer's table
 * runs to hundreds of thousands of rows, and none of them are interesting
 * individually.
 */
export async function organisationSpend(
  organisationId: string,
  options: { since?: Date } = {},
): Promise<OrganisationSpend> {
  const where = {
    organisationId,
    ...(options.since ? { createdAt: { gte: options.since } } : {}),
  };

  const [totals, estimated, byPerson, byStage] = await Promise.all([
    prisma.tokenUsage.aggregate({
      where,
      _sum: { totalTokens: true, inputTokens: true, outputTokens: true },
      _count: true,
    }),
    prisma.tokenUsage.aggregate({
      where: { ...where, estimated: true },
      _sum: { totalTokens: true },
    }),
    prisma.tokenUsage.groupBy({
      by: ["userId"],
      where,
      _sum: { totalTokens: true, inputTokens: true, outputTokens: true },
      _count: true,
    }),
    prisma.tokenUsage.groupBy({
      by: ["stage"],
      where,
      _sum: { totalTokens: true },
      _count: true,
    }),
  ]);

  return {
    totalTokens: totals._sum.totalTokens ?? 0,
    inputTokens: totals._sum.inputTokens ?? 0,
    outputTokens: totals._sum.outputTokens ?? 0,
    calls: totals._count,
    estimatedTokens: estimated._sum.totalTokens ?? 0,
    byPerson: byPerson
      .map((row) => ({
        userId: row.userId,
        totalTokens: row._sum.totalTokens ?? 0,
        inputTokens: row._sum.inputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
        calls: row._count,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    byStage: byStage
      .map((row) => ({
        stage: row.stage,
        totalTokens: row._sum.totalTokens ?? 0,
        calls: row._count,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    since: options.since ?? null,
  };
}

/** Platform-wide totals, for the operator's console. */
export async function platformSpend(): Promise<{
  totalTokens: number;
  calls: number;
  organisations: number;
}> {
  const [totals, organisations] = await Promise.all([
    prisma.tokenUsage.aggregate({ _sum: { totalTokens: true }, _count: true }),
    prisma.organisation.count(),
  ]);
  return {
    totalTokens: totals._sum.totalTokens ?? 0,
    calls: totals._count,
    organisations,
  };
}
