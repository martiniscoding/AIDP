import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { canManageStandards } from "@/lib/access/roles";
import type { Access } from "@/lib/access/gate";
import { describeJob, describePipeline, JOB_SELECT, STAGES, type PipelineView } from "./pipeline";
import { resolveFramework } from "./assessment";
import { designResult, type CompletedRun, type DesignResult } from "./results";

/**
 * Projects — the unit of work.
 *
 * An employee opens one and puts the designs for that piece of work inside it.
 * Everyone in the organisation can see every project, because a workspace is
 * shared and an administrator asking "what is happening" should not have to be
 * invited to each one.
 *
 * Standards are deliberately not part of this. They belong to the organisation
 * and every project is measured against the same set; a standard attached to a
 * project would become a different yardstick per project, which is the opposite
 * of what a standard is.
 */

export class ProjectRefused extends Error {}

export const ACTIVE = "active";
export const ARCHIVED = "archived";

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  status: string;
  createdByName: string;
  createdById: string | null;
  createdAt: Date;
  designs: number;
  /** Designs that have finished indexing and can be assessed. */
  ready: number;
  runs: number;
  /** Findings that contradict a standard or leave it unaddressed. */
  open: number;
  /** Findings nobody has confirmed or overridden yet. */
  unreviewed: number;
  lastActivityAt: Date | null;
};

/**
 * May this person rename or archive it?
 *
 * The administrator, or whoever opened it. A project is somebody's piece of
 * work, and an employee who cannot tidy up their own would be asking their
 * administrator to rename things all day — but one employee should not be able
 * to archive another's work out from under them.
 */
export function canEditProject(
  access: Access,
  project: { createdById: string | null },
): boolean {
  return canManageStandards(access.organisation.role) || project.createdById === access.user.id;
}

function normalise(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Every project in the organisation, with enough of its state to see what is
 *  happening inside without opening it. */
export async function listProjects(organisationId: string): Promise<ProjectSummary[]> {
  const projects = await prisma.project.findMany({
    where: { organisationId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      createdById: true,
      createdByName: true,
      createdAt: true,
      documents: {
        select: {
          id: true,
          status: true,
          updatedAt: true,
          _count: { select: { runs: true } },
        },
      },
    },
  });

  // Every finding in the organisation in one query rather than one per
  // project: the list shows a health number on each row, and a workspace with
  // twenty projects would otherwise be twenty round trips. Only three small
  // fields come back, so the row count is the only thing that grows.
  const findings = await prisma.finding.findMany({
    where: { run: { organisationId } },
    select: {
      verdict: true,
      reviewerState: true,
      // A design run reaches its project through the document; a project run
      // names it outright.
      run: { select: { projectId: true, document: { select: { projectId: true } } } },
    },
  });

  const health = new Map<string, { open: number; unreviewed: number }>();
  for (const finding of findings) {
    const projectId = finding.run.projectId ?? finding.run.document?.projectId ?? null;
    if (!projectId) continue;
    const entry = health.get(projectId) ?? { open: 0, unreviewed: 0 };
    // Not "absent": a clause the design is silent on is no longer reported.
    if (finding.verdict === "contradicts") entry.open += 1;
    if (finding.reviewerState === "pending" && finding.verdict !== "absent") entry.unreviewed += 1;
    health.set(projectId, entry);
  }

  return projects.map((project) => {
    const entry = health.get(project.id) ?? { open: 0, unreviewed: 0 };
    const touched = project.documents
      .map((document) => document.updatedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      status: project.status,
      createdById: project.createdById,
      createdByName: project.createdByName,
      createdAt: project.createdAt,
      designs: project.documents.length,
      ready: project.documents.filter((document) => document.status === "ready").length,
      runs: project.documents.reduce((total, document) => total + document._count.runs, 0),
      open: entry.open,
      unreviewed: entry.unreviewed,
      lastActivityAt: touched ?? null,
    };
  });
}

/** One project, or null when it belongs to another organisation — which is
 *  indistinguishable from not existing, and should be. */
export async function getProject(organisationId: string, projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId, organisationId },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      createdById: true,
      createdByName: true,
      createdAt: true,
    },
  });
}

export async function createProject(
  access: Access,
  input: { name: string; description?: string },
): Promise<{ id: string; name: string }> {
  const name = normalise(input.name);
  if (!name) throw new ProjectRefused("Give the project a name.");
  if (name.length > 120) throw new ProjectRefused("That name is too long.");

  const clash = await prisma.project.findFirst({
    where: { organisationId: access.organisation.id, name },
    select: { id: true },
  });
  if (clash) throw new ProjectRefused(`There is already a project called “${name}”.`);

  return prisma.project.create({
    data: {
      organisationId: access.organisation.id,
      name,
      description: (input.description ?? "").trim().slice(0, 2000),
      createdById: access.user.id,
      createdByName: access.user.name || access.user.email,
    },
    select: { id: true, name: true },
  });
}

export async function updateProject(
  access: Access,
  projectId: string,
  input: { name: string; description?: string },
): Promise<void> {
  const project = await getProject(access.organisation.id, projectId);
  if (!project) throw new ProjectRefused("That project no longer exists.");
  if (!canEditProject(access, project)) {
    throw new ProjectRefused("Only an administrator, or whoever opened it, can change this project.");
  }

  const name = normalise(input.name);
  if (!name) throw new ProjectRefused("Give the project a name.");

  const clash = await prisma.project.findFirst({
    where: { organisationId: access.organisation.id, name, id: { not: projectId } },
    select: { id: true },
  });
  if (clash) throw new ProjectRefused(`There is already a project called “${name}”.`);

  await prisma.project.update({
    where: { id: projectId },
    data: { name, description: (input.description ?? "").trim().slice(0, 2000) },
  });
}

/**
 * Archive or reopen.
 *
 * Never a delete. A project holds submissions, findings and the record of who
 * accepted what — throwing that away to tidy a list is not a trade worth
 * offering, and "we assessed this in March" is exactly what an audit asks.
 */
export async function setProjectStatus(
  access: Access,
  projectId: string,
  status: string,
): Promise<void> {
  const project = await getProject(access.organisation.id, projectId);
  if (!project) throw new ProjectRefused("That project no longer exists.");
  if (!canEditProject(access, project)) {
    throw new ProjectRefused("Only an administrator, or whoever opened it, can change this project.");
  }
  await prisma.project.update({
    where: { id: projectId },
    data: { status: status === ARCHIVED ? ARCHIVED : ACTIVE },
  });
}

/** Active projects, for the picker on an upload form. */
export async function pickableProjects(organisationId: string) {
  return prisma.project.findMany({
    where: { organisationId, status: ACTIVE },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true },
  });
}

export type ProjectDesign = {
  id: string;
  title: string;
  status: string;
  /** Where processing has got to, or null once the design is indexed. */
  pipeline: PipelineView | null;
  failureReason: string | null;
  pageCount: number | null;
  chunks: number;
  uploadedByName: string;
  createdAt: Date;
  /** The latest finished assessment, read-only, or null when none has finished. */
  result: DesignResult | null;
  runs: {
    id: string;
    state: string;
    totalClauses: number;
    completedClauses: number;
    startedAt: Date;
    findings: number;
    open: number;
    /** Queued or running with no analyse job behind it, so it will never move. */
    orphaned: boolean;
  }[];
};

/**
 * A design's last finished result, noting when a newer run is under way — one
 * that is actually moving, so a run left without a job does not hide nothing.
 */
function resultFor(
  run: CompletedRun | undefined,
  latest: { id: string; state: string } | undefined,
  liveJob: boolean,
): DesignResult | null {
  if (!run) return null;
  const newer =
    latest !== undefined &&
    latest.id !== run.id &&
    (latest.state === "queued" || latest.state === "running") &&
    liveJob;
  return designResult(run, newer);
}

/** The designs inside one project, with the state of each assessment on them. */
export async function projectDesigns(
  organisationId: string,
  projectId: string,
): Promise<ProjectDesign[]> {
  const documents = await prisma.document.findMany({
    where: { organisationId, projectId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      failureReason: true,
      pageCount: true,
      createdAt: true,
      uploadedBy: { select: { name: true, email: true } },
      _count: {
        select: {
          chunks: true,
          jobs: { where: { stage: "analyse", state: { in: ["queued", "leased"] } } },
        },
      },
      jobs: { where: { stage: { in: [...STAGES] } }, select: JOB_SELECT },
      runs: {
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          state: true,
          totalClauses: true,
          completedClauses: true,
          startedAt: true,
          findings: { select: { verdict: true } },
        },
      },
    },
  });

  // Each design's latest *finished* assessment, whatever is running now: the page
  // shows a result beneath its design, and a run still in progress has none yet.
  // One query for the project, not one per design.
  const completed = documents.length
    ? await prisma.assessmentRun.findMany({
        where: { documentId: { in: documents.map((document) => document.id) }, state: "complete" },
        orderBy: { startedAt: "desc" },
        distinct: ["documentId"],
        select: {
          id: true,
          documentId: true,
          mode: true,
          model: true,
          note: true,
          completedAt: true,
          coverage: true,
          framework: { select: { name: true, version: true } },
          findings: {
            select: {
              id: true,
              clauseRef: true,
              clauseTitle: true,
              clauseStatement: true,
              verdict: true,
              confidence: true,
              rationale: true,
              evidence: true,
              reviewerState: true,
              reviewerVerdict: true,
            },
          },
        },
      })
    : [];
  const finished = new Map(completed.map((run) => [run.documentId, run]));

  const now = new Date();
  return documents.map((document) => ({
    id: document.id,
    title: document.title,
    status: document.status,
    result: resultFor(
      finished.get(document.id),
      document.runs[0],
      document._count.jobs > 0,
    ),
    pipeline:
      document.status === "ready" ? null : describePipeline(document, document.jobs, now),
    failureReason: document.failureReason,
    pageCount: document.pageCount,
    chunks: document._count.chunks,
    uploadedByName: document.uploadedBy?.name || document.uploadedBy?.email || "",
    createdAt: document.createdAt,
    runs: document.runs.map((run) => ({
      id: run.id,
      state: run.state,
      totalClauses: run.totalClauses,
      completedClauses: run.completedClauses,
      startedAt: run.startedAt,
      // As the report counts them: a clause the design is silent on is not shown.
      findings: run.findings.filter((finding) => finding.verdict !== "absent").length,
      open: run.findings.filter((finding) => finding.verdict === "contradicts").length,
      orphaned:
        (run.state === "queued" || run.state === "running") && document._count.jobs === 0,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Assessing a project as a whole
// ---------------------------------------------------------------------------

/**
 * A project's designs rarely stand alone.
 *
 * One file carries the architecture, another the data model, a third the
 * delivery plan — and a clause answered in the second was reported as a gap in
 * the first, because each design was assessed by itself. A project run judges
 * every clause once against all of them, which is what a reviewer was doing by
 * hand with four tabs open.
 *
 * The run row carries `projectId` and no `documentId`; the worker reads the
 * scope from it (Workers/aidp/designs.py). The job it is queued on still names
 * a document, because a job belongs to one — the project's first design stands
 * in, and nothing reads it for a project run except the queue's own bookkeeping.
 */

/** Designs that can actually be read: finished processing, with chunks to search. */
export async function assessableDesigns(organisationId: string, projectId: string) {
  return prisma.document.findMany({
    where: { projectId, organisationId, role: "assessed" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      title: true,
      status: true,
      _count: { select: { chunks: true, sourceLines: true } },
    },
  });
}

/**
 * The project's latest run of its own, with what a worker is doing on it.
 *
 * The job is found by the run id on its payload rather than by document, which
 * is how a project run's job is identified at all: its `documentId` is the
 * stand-in design, shared with that design's own runs.
 */
export async function latestProjectRun(organisationId: string, projectId: string) {
  const run = await prisma.assessmentRun.findFirst({
    where: { projectId, organisationId },
    orderBy: { startedAt: "desc" },
    include: {
      framework: { select: { name: true, version: true } },
      _count: { select: { findings: true } },
    },
  });
  if (!run) return null;

  const live = run.state === "queued" || run.state === "running";
  const row = live
    ? await prisma.job.findFirst({
        where: { stage: "analyse", payload: { path: ["runId"], equals: run.id } },
        orderBy: { createdAt: "desc" },
        select: JOB_SELECT,
      })
    : null;

  // A live run with no job for a worker to take will never move; the page has
  // to offer another rather than disabling the only way to start one.
  const orphaned = live && !(row && (row.state === "queued" || row.state === "leased"));
  return { ...run, orphaned, job: row && !orphaned ? describeJob(row) : null };
}

/**
 * Open an assessment of the whole project.
 *
 * Always by search. Reading several designs as one text would make every page
 * number ambiguous, and the engine would fall back to search anyway — so the
 * row says what it is rather than asking for a mode it cannot have. Each design
 * is still read in full for anything the search reports absent; see
 * `_confirm` in Workers/aidp/stages/analyse.py.
 */
export async function startProjectRun(
  access: Access,
  projectId: string,
): Promise<{ runId: string; scope: string }> {
  const project = await getProject(access.organisation.id, projectId);
  if (!project) throw new ProjectRefused("That project no longer exists.");
  if (project.status !== ACTIVE) {
    throw new ProjectRefused("Reopen this project before assessing it.");
  }

  const all = await assessableDesigns(access.organisation.id, projectId);
  const ready = all.filter((design) => design.status === "ready" && design._count.chunks > 0);
  if (ready.length === 0) {
    throw new ProjectRefused(
      all.length === 0
        ? "Add a design to this project first — there is nothing to assess yet."
        : "Wait for this project's designs to finish indexing, then assess it.",
    );
  }

  const framework = await resolveFramework(access.organisation.id);
  if (framework.clauseCount === 0) {
    throw new ProjectRefused(
      "There are no reference standards indexed yet, so there is nothing to measure against.",
    );
  }

  const runId = await prisma.$transaction(async (tx) => {
    // A live run with no live job will never move: its job was removed before a
    // worker took it, and it holds the one live-run slot. Cleared here rather
    // than refusing this attempt too, exactly as a design's run is. Only runs
    // older than a minute, so a double-click cannot clear the run the first
    // click has just committed.
    // At most one, by "assessment_run_live_project_idx".
    const live = await tx.assessmentRun.findFirst({
      where: { projectId, state: { in: ["queued", "running"] } },
      select: { id: true },
    });
    if (live) {
      const jobs = await tx.job.count({
        where: {
          stage: "analyse",
          state: { in: ["queued", "leased"] },
          payload: { path: ["runId"], equals: live.id },
        },
      });
      if (jobs === 0) {
        await tx.assessmentRun.updateMany({
          where: {
            projectId,
            state: { in: ["queued", "running"] },
            startedAt: { lt: new Date(Date.now() - 60_000) },
          },
          data: {
            state: "failed",
            failureReason:
              "This assessment never started: its job was lost before a worker picked it up. " +
              "It was replaced by a new one.",
            completedAt: new Date(),
          },
        });
      }
    }

    const run = await tx.assessmentRun.create({
      data: {
        organisationId: access.organisation.id,
        projectId,
        frameworkId: framework.id,
        totalClauses: framework.clauseCount,
        mode: "retrieval",
      },
      select: { id: true },
    });
    // No document: this job is about every design in the project. The run id on
    // the payload is what identifies it — see `latestProjectRun`.
    await tx.job.create({
      data: {
        organisationId: access.organisation.id,
        documentId: null,
        stage: "analyse",
        correlationId: randomUUID(),
        payload: { runId: run.id },
      },
    });
    return run.id;
  });

  const designs = ready.length === 1 ? "1 design" : `${ready.length} designs`;
  return {
    runId,
    scope: `${designs} against ${framework.clauseCount} clauses from ${framework.name} v${framework.version}`,
  };
}
