import { prisma } from "@/lib/prisma";
import { canManageStandards } from "@/lib/access/roles";
import type { Access } from "@/lib/access/gate";
import { describePipeline, JOB_SELECT, STAGES, type PipelineView } from "./pipeline";

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
      run: { select: { document: { select: { projectId: true } } } },
    },
  });

  const health = new Map<string, { open: number; unreviewed: number }>();
  for (const finding of findings) {
    const projectId = finding.run.document.projectId;
    if (!projectId) continue;
    const entry = health.get(projectId) ?? { open: 0, unreviewed: 0 };
    if (finding.verdict === "contradicts" || finding.verdict === "absent") entry.open += 1;
    if (finding.reviewerState === "pending") entry.unreviewed += 1;
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

  const now = new Date();
  return documents.map((document) => ({
    id: document.id,
    title: document.title,
    status: document.status,
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
      findings: run.findings.length,
      open: run.findings.filter(
        (finding) => finding.verdict === "contradicts" || finding.verdict === "absent",
      ).length,
      orphaned:
        (run.state === "queued" || run.state === "running") && document._count.jobs === 0,
    })),
  }));
}
