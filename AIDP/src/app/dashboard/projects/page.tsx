import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Archive, FolderOpen } from "lucide-react";
import { cn } from "@/lib/cn";
import { requireWorkspace } from "@/lib/access/gate";
import { listProjects, type ProjectSummary } from "@/lib/ingest/projects";
import { NewProject } from "./NewProject";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Projects",
  description: "Pieces of work, and the designs being assessed inside them.",
};

/**
 * Every project in the workspace.
 *
 * Not filtered by who opened it. An administrator asking "what is happening"
 * should not have to be invited to each one, and a colleague picking up
 * somebody's work should not have to ask where it lives.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  // "Create Project" in the header is a link, not a button — it has to work
  // from any page — so it arrives here with the form already asked for.
  const { new: openNew } = await searchParams;
  const { organisation, isOwner } = await requireWorkspace();
  const projects = await listProjects(organisation.id);

  const active = projects.filter((project) => project.status === "active");
  const archived = projects.filter((project) => project.status !== "active");

  return (
    <>
      <PageHeader
        eyebrow={organisation.name}
        title="My Projects"
        lede={
          isOwner
            ? "Every piece of work in this workspace, and what is happening inside it."
            : "Open a project for a piece of work, then submit its designs for assessment."
        }
      />

      <NewProject defaultOpen={openNew === "1"} />

      {active.length === 0 && archived.length === 0 ? (
        <p className="rounded-2xl border border-line bg-card px-4 py-10 text-center text-[13.5px] text-ink/58">
          No projects yet. Open one, then submit the designs that belong to it.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {active.map((project) => (
            <li key={project.id}>
              <Row project={project} />
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <section className="mt-9">
          <h2 className="mb-3 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.13em] text-ink/58">
            <Archive size={12} />
            Archived
          </h2>
          <ul className="space-y-2.5">
            {archived.map((project) => (
              <li key={project.id}>
                <Row project={project} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Row({ project }: { project: ProjectSummary }) {
  const archived = project.status !== "active";

  return (
    <Link
      href={`/dashboard/projects/${project.id}`}
      className={cn(
        "group card-sheen block rounded-2xl border bg-card p-5 shadow-card transition-[border-color,transform,box-shadow] duration-300 hover:shadow-card-hover",
        archived
          ? "border-line opacity-70 hover:opacity-100"
          : "border-line hover:-translate-y-0.5 hover:border-line-strong",
      )}
    >
      <div className="flex flex-wrap items-start gap-4">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-royal-mid/30 bg-royal/10 text-royal">
          <FolderOpen size={16} strokeWidth={1.9} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="font-display text-[16.5px] font-semibold tracking-tight text-ink">
              {project.name}
            </h2>
            {archived && (
              <span className="rounded-full border border-line bg-canvas-sunk px-2 py-0.5 text-[10.5px] text-ink/58">
                Archived
              </span>
            )}
            {project.open > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-warn-line bg-warn-tint px-2 py-0.5 text-[10.5px] text-warn">
                <AlertTriangle size={10} />
                {project.open} to resolve
              </span>
            )}
          </div>

          {project.description && (
            <p className="mt-1 line-clamp-1 text-[13px] text-ink/64">{project.description}</p>
          )}

          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px]">
            <Pair label="Designs" value={String(project.designs)} />
            <Pair label="Assessments" value={String(project.runs)} />
            {project.unreviewed > 0 && (
              <Pair label="Unreviewed" value={String(project.unreviewed)} />
            )}
          </dl>
        </div>

        <div className="text-right">
          <p className="text-[11.5px] text-ink/58">
            Opened by {project.createdByName || "someone since departed"}
          </p>
          <p className="mt-0.5 text-[11.5px] text-ink/50">
            {project.lastActivityAt
              ? `Active ${project.lastActivityAt.toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                })}`
              : "Nothing submitted yet"}
          </p>
          <ArrowRight
            size={15}
            className="ml-auto mt-2 text-ink/40 transition-transform duration-300 group-hover:translate-x-0.5"
          />
        </div>
      </div>
    </Link>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink/58">{label}</dt>
      <dd className="tabular-nums text-ink/80">{value}</dd>
    </div>
  );
}
