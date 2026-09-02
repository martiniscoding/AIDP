import { Archive } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireWorkspace } from "@/lib/access/gate";
import { listProjects } from "@/lib/ingest/projects";
import { NewProject } from "./projects/NewProject";
import { ProjectRow } from "./projects/ProjectRow";
import { PageHeader } from "@/components/ui/PageHeader";

/**
 * Where somebody lands: open a piece of work, or pick one back up.
 *
 * This page used to be a directory — a band of counts and a tile per section —
 * which told people what the product contains rather than letting them do
 * anything. Everything here now is a project, because a project is the only
 * thing anyone starts from: standards are set up once by an administrator, and
 * decisions are recorded from inside a report rather than sought out.
 *
 * Every project lives here, active first and the archive folded in below.
 * There is no second projects page: one existed, listed the same things, and
 * having two routes answer the same question only raises the question of which
 * one is missing something.
 *
 * The row is shared with the project detail route rather than reimplemented,
 * so a project reads the same wherever it appears.
 */
export default async function DashboardPage() {
  // `requireWorkspace` rather than a session lookup, and rather than the
  // throwing `requireAccess`: a page renders concurrently with its layout, so
  // two thrown refusals race each other. This one redirects instead, so the
  // outcome is the same every time.
  const { user, organisation, isOwner } = await requireWorkspace();

  const [projects, standards] = await Promise.all([
    listProjects(organisation.id),
    prisma.document.count({
      where: { organisationId: organisation.id, role: "reference" },
    }),
  ]);

  const active = projects.filter((project) => project.status === "active");
  const archived = projects.filter((project) => project.status !== "active");
  const firstName = (user.name || "").split(" ")[0];

  // The one piece of state a project cannot route around. With no standards
  // there is nothing to measure a design against, and a member cannot fix it
  // themselves — so they are told who can, rather than finding out when an
  // assessment comes back empty.
  const lede =
    standards === 0
      ? isOwner
        ? "Before a design can be assessed, add the standards it should be measured against in the Reference Library."
        : "No standards have been added yet. An administrator needs to add them before anything can be assessed."
      : "Open a project for a piece of work, then submit its designs for assessment.";

  return (
    <>
      <PageHeader
        eyebrow={organisation.name}
        title={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        lede={lede}
      />

      <NewProject />

      {active.length === 0 ? (
        <p className="rounded-2xl border border-line bg-card px-4 py-10 text-center text-[13.5px] text-ink/58">
          {archived.length > 0
            ? "Nothing active right now. Open a project, or reopen an archived one below."
            : "No projects yet. Open one, then submit the designs that belong to it."}
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
