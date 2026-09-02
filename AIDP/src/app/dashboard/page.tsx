import Link from "next/link";
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
 * Only *active* projects are listed. This page answers "what is live", and an
 * archive read every time you land somewhere is a filing cabinet in the way of
 * the desk. The projects page carries the full view, archive included — so the
 * split is between what is in front of you and what is on the record, and the
 * count below links across whenever there is anything on the other side of it.
 *
 * The list and its rows are the projects page's, imported rather than
 * reimplemented, so the two cannot drift.
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
            ? "Nothing active right now. Open a project, or look back through the archived ones."
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

      {/* Archived work is not shown here, so it has to be *said* here. A count
          that silently omits things is how someone concludes their project was
          deleted. */}
      {archived.length > 0 && (
        <Link
          href="/dashboard/projects"
          className="mt-5 inline-flex items-center gap-1.5 text-[12.5px] text-ink/62 transition-colors hover:text-ink"
        >
          <Archive size={12} />
          {archived.length} archived {archived.length === 1 ? "project" : "projects"} — see all
        </Link>
      )}
    </>
  );
}
