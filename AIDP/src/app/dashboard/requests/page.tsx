import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { requireWorkspace } from "@/lib/access/gate";
import { listRequests } from "@/lib/ingest/requests";
import { listProjects } from "@/lib/ingest/projects";
import { PageHeader } from "@/components/ui/PageHeader";
import { NewRequest } from "./new/NewRequest";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  draft: "border-line text-ink/60",
  submitted: "border-royal-mid/40 bg-royal/8 text-royal",
  checking: "border-royal-mid/40 bg-royal/8 text-royal",
  reported: "border-ok-line bg-ok-tint text-ok",
  decided: "border-ok-line bg-ok-tint text-ok",
  failed: "border-warn-line bg-warn-tint text-warn",
};

const LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  checking: "Under review",
  reported: "Reported",
  decided: "Decided",
  failed: "Stopped",
};

/**
 * Architecture requests, newest first.
 *
 * Everyone in the workspace sees every one, for the same reason everyone sees
 * every project: an architect asked to review a submission should not have to
 * be invited to it first.
 *
 * Drafts sit in the same list rather than behind a filter. A half-filled
 * request is the most likely thing somebody is coming back to finish, and
 * hiding it would mean the list is busiest exactly when it is least useful.
 */
export default async function RequestsPage() {
  const { organisation } = await requireWorkspace();

  const [requests, projects] = await Promise.all([
    listRequests(organisation.id),
    listProjects(organisation.id),
  ]);
  const open = projects.filter((project) => project.status === "active");

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Architecture requests"
        lede="Answer the intake questions and the platform checks the design against your standards, without waiting for anyone to upload anything."
        action={<NewRequest projects={open.map((p) => ({ id: p.id, name: p.name }))} />}
      />

      {open.length === 0 && (
        <p className="mb-5 rounded-xl border border-warn-line bg-warn-tint px-4 py-3 text-[12.5px] text-ink/80">
          A request belongs to a project, and there are no open ones yet. Start a project
          from the workspace home first.
        </p>
      )}

      {requests.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
          <ClipboardList size={22} className="mx-auto mb-3 text-ink/30" aria-hidden="true" />
          <p className="text-[14px] text-ink/70">No requests yet.</p>
          <p className="mt-1 text-[12.5px] text-ink/50">
            The first one takes a few minutes to fill in and is reviewed automatically.
          </p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {requests.map((request) => (
            <li key={request.id}>
              <Link
                href={`/dashboard/requests/${request.id}`}
                className="flex items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 transition-colors hover:border-royal-mid/40"
              >
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink/50">
                  {request.reference}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-ink">
                    {request.title || "Untitled request"}
                  </span>
                  <span className="block truncate text-[12px] text-ink/55">
                    {request.projectName}
                    {request.requestedByName && ` · ${request.requestedByName}`}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11.5px] ${
                    TONE[request.state] ?? "border-line text-ink/60"
                  }`}
                >
                  {LABEL[request.state] ?? request.state}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
