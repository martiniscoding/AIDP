import Link from "next/link";
import { AlertTriangle, ArrowRight, FolderOpen } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ProjectSummary } from "@/lib/ingest/projects";

/**
 * One project, as a row.
 *
 * Lives here rather than beside either page because both the workspace home
 * and the projects page list the same things, and a project that renders two
 * different ways depending on which route you reached it from is the kind of
 * drift nobody notices until the two disagree about something that matters.
 */
export function ProjectRow({ project }: { project: ProjectSummary }) {
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
