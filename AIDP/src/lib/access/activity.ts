import { prisma } from "@/lib/prisma";

/**
 * What each person has actually been doing.
 *
 * The People page answers "who is allowed in, and what are they spending".
 * That is the wrong question when a submission is late or a bill jumps: an
 * administrator then needs to know *which colleague put which document
 * through*, and how far it got. Spend is a consequence; this is the work.
 *
 * Attribution runs through `Document.uploadedById` throughout, including for
 * assessment runs, which carry no person of their own — a run belongs to the
 * submission it assesses, and the submission belongs to whoever filed it.
 * Decisions are the exception and name their own author.
 *
 * Everything is scoped to one organisation on every query. A person id arriving
 * from a filter is a display concern and never a capability, so it is applied
 * after the tenant predicate rather than instead of it.
 *
 * Null attribution is shown, not dropped. Documents uploaded before the column
 * existed, and those whose author has since been deleted, are real work that
 * really cost money; hiding them would make the totals disagree with the
 * People page for reasons nobody could reconstruct.
 */

/** How far a document got. Ordered so the terminal states read as terminal. */
const DOCUMENT_STATE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Queued", tone: "waiting" },
  parsing: { label: "Reading structure", tone: "working" },
  chunking: { label: "Splitting into passages", tone: "working" },
  embedding: { label: "Indexing", tone: "working" },
  ready: { label: "Ready", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
};

const RUN_STATE: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "waiting" },
  running: { label: "Running", tone: "working" },
  complete: { label: "Complete", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
};

export type Tone = "good" | "bad" | "working" | "waiting" | "neutral";

export type PersonWork = {
  /** Null for work that cannot be traced to an account. */
  userId: string | null;
  name: string;
  email: string;
  /** Standards documents contributed to the library. */
  references: number;
  /** Designs submitted for assessment. */
  submissions: number;
  /** Assessment runs over their submissions. */
  runs: number;
  decisions: number;
  totalTokens: number;
  lastActiveAt: Date | null;
};

export type WorkEvent = {
  id: string;
  kind: "upload" | "run" | "decision";
  at: Date;
  userId: string | null;
  personName: string;
  /** What the thing is called — a document title, a decision title. */
  title: string;
  /** The one-line description of what happened to it. */
  detail: string;
  state: string;
  tone: Tone;
};

export type OrganisationActivity = {
  people: PersonWork[];
  events: WorkEvent[];
  totals: {
    references: number;
    submissions: number;
    runs: number;
    decisions: number;
    /** People with at least one attributed action. */
    contributors: number;
  };
  /** True when some work could not be traced to an account. */
  hasUnattributed: boolean;
};

/** How many of each kind of event to pull before merging into one feed. */
const FEED_PER_KIND = 40;
/** How many survive the merge. Enough to scroll, short enough to read. */
const FEED_LENGTH = 60;

const UNATTRIBUTED = "Unattributed";

function state(
  table: Record<string, { label: string; tone: Tone }>,
  key: string,
): { label: string; tone: Tone } {
  return table[key] ?? { label: key, tone: "neutral" };
}

/**
 * Everything an administrator needs to see who did what.
 *
 * Counts are grouped in the database; only the feed loads rows, and it loads a
 * bounded number of them. A customer with a hundred thousand usage rows still
 * runs four aggregates and three short selects.
 */
export async function organisationActivity(
  organisationId: string,
): Promise<OrganisationActivity> {
  const [documentCounts, decisionCounts, runCounts, spend, lastSeen, uploads, runs, decisions] =
    await Promise.all([
      prisma.document.groupBy({
        by: ["uploadedById", "role"],
        where: { organisationId },
        _count: { _all: true },
      }),
      prisma.decision.groupBy({
        by: ["decidedById"],
        where: { organisationId },
        _count: { _all: true },
      }),
      // A run has no author of its own, so the count has to reach through the
      // document it assesses. Prisma cannot group across a relation, and
      // loading every run to count them in JavaScript would defeat the point.
      prisma.$queryRaw<{ userId: string | null; runs: bigint }[]>`
        SELECT d."uploadedById" AS "userId", count(*) AS "runs"
          FROM "assessment_run" r
          JOIN "document" d ON d."id" = r."documentId"
         WHERE r."organisationId" = ${organisationId}
         GROUP BY d."uploadedById"
      `,
      prisma.tokenUsage.groupBy({
        by: ["userId"],
        where: { organisationId },
        _sum: { totalTokens: true },
      }),
      prisma.tokenUsage.groupBy({
        by: ["userId"],
        where: { organisationId },
        _max: { createdAt: true },
      }),
      prisma.document.findMany({
        where: { organisationId },
        orderBy: { createdAt: "desc" },
        take: FEED_PER_KIND,
        select: {
          id: true,
          title: true,
          role: true,
          status: true,
          createdAt: true,
          uploadedById: true,
          uploadedBy: { select: { name: true, email: true } },
        },
      }),
      prisma.assessmentRun.findMany({
        where: { organisationId },
        orderBy: { startedAt: "desc" },
        take: FEED_PER_KIND,
        select: {
          id: true,
          state: true,
          startedAt: true,
          totalClauses: true,
          completedClauses: true,
          document: {
            select: {
              title: true,
              uploadedById: true,
              uploadedBy: { select: { name: true, email: true } },
            },
          },
        },
      }),
      prisma.decision.findMany({
        where: { organisationId },
        orderBy: { createdAt: "desc" },
        take: FEED_PER_KIND,
        select: {
          id: true,
          title: true,
          effect: true,
          status: true,
          clauseRef: true,
          createdAt: true,
          decidedById: true,
          decidedBy: { select: { name: true, email: true } },
        },
      }),
    ]);

  // Names for everyone who appears anywhere above. Looked up in one query
  // rather than joined into each aggregate, because the aggregates return ids
  // and only the page needs names.
  const ids = new Set<string>();
  for (const row of documentCounts) if (row.uploadedById) ids.add(row.uploadedById);
  for (const row of decisionCounts) if (row.decidedById) ids.add(row.decidedById);
  for (const row of runCounts) if (row.userId) ids.add(row.userId);
  for (const row of spend) if (row.userId) ids.add(row.userId);

  const users = ids.size
    ? await prisma.user.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const byId = new Map(users.map((user) => [user.id, user]));

  const people = new Map<string | null, PersonWork>();
  const person = (userId: string | null): PersonWork => {
    const existing = people.get(userId);
    if (existing) return existing;
    const user = userId ? byId.get(userId) : undefined;
    const fresh: PersonWork = {
      userId,
      name: user?.name || user?.email || UNATTRIBUTED,
      email: user?.email ?? "",
      references: 0,
      submissions: 0,
      runs: 0,
      decisions: 0,
      totalTokens: 0,
      lastActiveAt: null,
    };
    people.set(userId, fresh);
    return fresh;
  };

  for (const row of documentCounts) {
    const entry = person(row.uploadedById);
    if (row.role === "assessed") entry.submissions += row._count._all;
    else entry.references += row._count._all;
  }
  for (const row of runCounts) person(row.userId).runs += Number(row.runs);
  for (const row of decisionCounts) person(row.decidedById).decisions += row._count._all;
  for (const row of spend) person(row.userId).totalTokens += row._sum.totalTokens ?? 0;
  for (const row of lastSeen) person(row.userId).lastActiveAt = row._max.createdAt;

  const events: WorkEvent[] = [
    ...uploads.map((doc) => {
      const meta = state(DOCUMENT_STATE, doc.status);
      const kindLabel = doc.role === "assessed" ? "Submitted a design" : "Added a standard";
      return {
        id: `doc:${doc.id}`,
        kind: "upload" as const,
        at: doc.createdAt,
        userId: doc.uploadedById,
        personName: doc.uploadedBy?.name || doc.uploadedBy?.email || UNATTRIBUTED,
        title: doc.title,
        detail: kindLabel,
        state: meta.label,
        tone: meta.tone,
      };
    }),
    ...runs.map((run) => {
      const meta = state(RUN_STATE, run.state);
      // Progress is worth stating on a run that is still going: "running" on
      // its own is what a stuck run looks like too.
      const progress =
        run.state === "running" && run.totalClauses > 0
          ? `${run.completedClauses} of ${run.totalClauses} clauses`
          : "";
      return {
        id: `run:${run.id}`,
        kind: "run" as const,
        at: run.startedAt,
        userId: run.document.uploadedById,
        personName: run.document.uploadedBy?.name || run.document.uploadedBy?.email || UNATTRIBUTED,
        title: run.document.title,
        detail: progress ? `Assessment · ${progress}` : "Assessment",
        state: meta.label,
        tone: meta.tone,
      };
    }),
    ...decisions.map((decision) => ({
      id: `dec:${decision.id}`,
      kind: "decision" as const,
      at: decision.createdAt,
      userId: decision.decidedById,
      personName: decision.decidedBy?.name || decision.decidedBy?.email || UNATTRIBUTED,
      title: decision.title,
      detail: decision.clauseRef ? `Decision on ${decision.clauseRef}` : "Decision",
      state: decision.status === "active" ? "Active" : decision.status,
      tone: (decision.status === "active" ? "good" : "neutral") as Tone,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, FEED_LENGTH);

  const ordered = [...people.values()].sort((a, b) => {
    const work = b.references + b.submissions + b.runs + b.decisions
      - (a.references + a.submissions + a.runs + a.decisions);
    return work !== 0 ? work : b.totalTokens - a.totalTokens;
  });

  return {
    people: ordered,
    events,
    totals: {
      references: ordered.reduce((sum, p) => sum + p.references, 0),
      submissions: ordered.reduce((sum, p) => sum + p.submissions, 0),
      runs: ordered.reduce((sum, p) => sum + p.runs, 0),
      decisions: ordered.reduce((sum, p) => sum + p.decisions, 0),
      contributors: ordered.filter(
        (p) => p.userId && p.references + p.submissions + p.runs + p.decisions > 0,
      ).length,
    },
    hasUnattributed: ordered.some(
      (p) => !p.userId && p.references + p.submissions + p.runs + p.decisions > 0,
    ),
  };
}
