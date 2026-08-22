import Link from "next/link";
import { Gavel } from "lucide-react";
import { listDecisions } from "@/lib/ingest/decisions";
import { requireWorkspace } from "@/lib/access/gate";
import { DecisionRegister } from "./DecisionRegister";
import { PageHeader } from "@/components/ui/PageHeader";

export const dynamic = "force-dynamic";

export const metadata = { title: "Decisions" };

export default async function DecisionsPage() {
  // `requireWorkspace` rather than a session lookup, and rather than the
  // throwing `requireAccess`: a page renders concurrently with its layout, so
  // two thrown refusals race each other. This one redirects instead, so the
  // outcome is the same every time.
  const { user, organisation } = await requireWorkspace();
  const decisions = await listDecisions(user.id, organisation.id);

  const active = decisions.filter((d) => d.status === "active");
  const unindexed = active.filter((d) => !d.hasVector).length;

  return (
    <>
      <PageHeader
        eyebrow={organisation.name}
        title="Decisions"
        lede="What this organisation has already settled. Every assessment from here on is judged with these in front of it, so a question answered once is not asked again."
      />

      {decisions.length === 0 ? (
        <div className="mb-8 rounded-2xl border border-line bg-card shadow-card px-6 py-10 text-center">
          <span className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border border-line bg-card text-ink/64">
            <Gavel size={19} strokeWidth={1.9} />
          </span>
          <p className="text-[14px] text-ink/78">No decisions recorded yet.</p>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-ink/64">
            The quickest way to start is to review a report and tick{" "}
            <span className="text-ink/72">Remember this for future assessments</span>{" "}
            when you override a finding. Or write one below.
          </p>
          <Link
            href="/dashboard/documents"
            className="mt-5 inline-flex rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-ink/72 transition-colors hover:border-line-strong hover:text-ink"
          >
            Go to the standards library
          </Link>
        </div>
      ) : null}

      <DecisionRegister decisions={decisions} unindexed={unindexed} />
    </>
  );
}
