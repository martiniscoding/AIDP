import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, FileSearch } from "lucide-react";
import { cn } from "@/lib/cn";
import { requireWorkspace } from "@/lib/access/gate";
import { canEditProject, getProject, projectDesigns } from "@/lib/ingest/projects";
import { UploadZone } from "../../documents/UploadZone";
import { ProjectSettings } from "./ProjectSettings";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const access = await requireWorkspace();
  const project = await getProject(access.organisation.id, (await params).id);
  return { title: project ? project.name : "Project" };
}

/**
 * One piece of work.
 *
 * The designs inside it, and what each assessment found. A project in another
 * organisation is indistinguishable from one that does not exist — saying
 * "forbidden" would confirm it is real.
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireWorkspace();
  const { id } = await params;

  const project = await getProject(access.organisation.id, id);
  if (!project) notFound();

  const designs = await projectDesigns(access.organisation.id, id);
  const archived = project.status !== "active";
  const mayEdit = canEditProject(access, project);

  return (
    <>
      <Link
        href="/dashboard/projects"
        className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-ink/58 transition-colors hover:text-ink"
      >
        <ArrowLeft size={13} />
        All projects
      </Link>

      <header className="mb-7">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-display text-[28px] font-semibold tracking-[-0.02em] text-ink">
            {project.name}
          </h1>
          {archived && (
            <span className="rounded-full border border-line bg-canvas-sunk px-2 py-0.5 text-[11px] text-ink/58">
              Archived
            </span>
          )}
        </div>
        {project.description && (
          <p className="mt-2 max-w-2xl text-[14.5px] text-ink/68">{project.description}</p>
        )}
        <p className="mt-1.5 text-[12px] text-ink/58">
          Opened by {project.createdByName || "someone since departed"} on{" "}
          {project.createdAt.toLocaleDateString(undefined, {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </p>
      </header>

      {mayEdit && <ProjectSettings project={project} />}

      <section className="mt-7">
        <h2 className="mb-3.5 font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
          Designs
          <span className="ml-2 text-[13px] font-normal text-ink/50">{designs.length}</span>
        </h2>

        {designs.length === 0 ? (
          <p className="mb-4 rounded-xl border border-line bg-card px-3.5 py-6 text-center text-[12.5px] text-ink/58">
            Nothing submitted yet. Add a design and assess it against your standards.
          </p>
        ) : (
          <ul className="mb-4 space-y-2">
            {designs.map((design) => (
              <li key={design.id}>
                <Design design={design} />
              </li>
            ))}
          </ul>
        )}

        {archived ? (
          <p className="rounded-lg border border-dashed border-line px-3.5 py-4 text-center text-[12px] text-ink/50">
            This project is archived. Reopen it to add designs.
          </p>
        ) : (
          <UploadZone role="assessed" label="Add a design to this project" projectId={project.id} />
        )}
      </section>
    </>
  );
}

function Design({
  design,
}: {
  design: Awaited<ReturnType<typeof projectDesigns>>[number];
}) {
  const latest = design.runs[0];
  const running = latest?.state === "running" || latest?.state === "queued";

  return (
    <Link
      href={`/dashboard/documents/${design.id}`}
      className="group block rounded-xl border border-line bg-card p-4 transition-colors hover:border-line-strong"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-canvas-sunk text-ink/58">
          <FileSearch size={14} strokeWidth={1.9} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-ink/92">{design.title}</p>
          <p className="mt-0.5 text-[12px] text-ink/58">
            {design.status === "ready"
              ? `${design.chunks} chunks indexed`
              : `Indexing — ${design.status}`}
            {design.uploadedByName ? ` · ${design.uploadedByName}` : ""}
          </p>
          {design.failureReason && (
            <p className="mt-1 text-[11.5px] text-warn">{design.failureReason}</p>
          )}
        </div>

        <div className="text-right text-[11.5px]">
          {latest ? (
            running ? (
              <span className="text-ink/64">
                Assessing {latest.completedClauses}/{latest.totalClauses}
              </span>
            ) : (
              <>
                <span className="text-ink/64">{latest.findings} findings</span>
                {latest.open > 0 && (
                  <span
                    className={cn(
                      "ml-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
                      "border-warn-line bg-warn-tint text-warn",
                    )}
                  >
                    <AlertTriangle size={10} />
                    {latest.open}
                  </span>
                )}
              </>
            )
          ) : (
            <span className="text-ink/50">Not assessed yet</span>
          )}
          <ArrowRight
            size={14}
            className="ml-auto mt-1.5 text-ink/40 transition-transform duration-300 group-hover:translate-x-0.5"
          />
        </div>
      </div>
    </Link>
  );
}
