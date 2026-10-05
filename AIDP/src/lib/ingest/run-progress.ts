import { prisma } from "@/lib/prisma";
import { runJobWhere } from "./assessment";
import { requireMembership } from "./org";
import { describeJob, JOB_SELECT, type JobView } from "./pipeline";

/**
 * How far a live run has got, and nothing else.
 *
 * The progress banner used to move only because the whole page re-rendered from
 * the server every few seconds. That meant twelve queries — every finding, every
 * count, the decision history — to carry one number that changes once every
 * fifteen seconds, and a render slow enough that refreshes overlapped and the
 * count sat still for minutes at a time. This is what the banner actually reads,
 * so it can be polled on its own and the page refreshed once, when the report is
 * ready to show.
 */
export type RunProgressView = {
  state: string;
  totalClauses: number;
  completedClauses: number;
  /** Queued or running with no job a worker could take, so it will never move. */
  orphaned: boolean;
  job: JobView | null;
};

/**
 * A run's progress, for someone entitled to see it.
 *
 * Guarded like every other read in this module: membership of the run's
 * organisation, checked here rather than trusted from the caller, because this
 * one is reached by URL.
 */
export async function readRunProgress(
  userId: string,
  runId: string,
): Promise<RunProgressView | null> {
  const run = await prisma.assessmentRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      organisationId: true,
      documentId: true,
      state: true,
      totalClauses: true,
      completedClauses: true,
    },
  });
  if (!run) return null;
  await requireMembership(userId, run.organisationId);

  const live = run.state === "queued" || run.state === "running";
  // Same reading as `latestRun` and `latestProjectRun`: the run row cannot tell
  // a run nobody has picked up from one a worker is preparing, retrying, or has
  // died holding. Only asked for while the run is live — a finished run's job
  // tells the banner nothing it still shows.
  const row = live
    ? await prisma.job.findFirst({
        where: runJobWhere(run),
        orderBy: { createdAt: "desc" },
        select: JOB_SELECT,
      })
    : null;
  const orphaned = live && !(row && (row.state === "queued" || row.state === "leased"));

  return {
    state: run.state,
    totalClauses: run.totalClauses,
    completedClauses: run.completedClauses,
    orphaned,
    job: row && !orphaned ? describeJob(row) : null,
  };
}
