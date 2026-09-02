import type { Metadata } from "next";
import { Archive } from "lucide-react";
import { requireWorkspace } from "@/lib/access/gate";
import { listProjects } from "@/lib/ingest/projects";
import { NewProject } from "./NewProject";
import { ProjectRow } from "./ProjectRow";
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
        // The home page lists only what is active, so this one says plainly
        // that it is the whole record — otherwise the two read as the same
        // screen and nobody knows which one is missing something.
        lede={
          isOwner
            ? "Every piece of work in this workspace, active and archived, and what is happening inside it."
            : "Every project in this workspace, active and archived."
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
              <ProjectRow project={project} />
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
                <ProjectRow project={project} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
