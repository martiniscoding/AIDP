import Link from "next/link";
import { Gavel } from "lucide-react";
import { listDecisions } from "@/lib/ingest/decisions";
import { requireAccess } from "@/lib/access/gate";
import { DecisionRegister } from "./DecisionRegister";

export const dynamic = "force-dynamic";

export const metadata = { title: "Decisions" };

export default async function DecisionsPage() {
  // `requireAccess` rather than a session lookup. A page renders concurrently
  // with its layout, so the layout's refusal cannot be relied on to have run
  // first — and `resolveActive` *creates* an organisation for anyone without
  // one, which would hand a workspace to somebody an administrator had
  // deliberately not admitted.
  const { user, organisation } = await requireAccess();
  const decisions = await listDecisions(user.id, organisation.id);

  const active = decisions.filter((d) => d.status === "active");
  const unindexed = active.filter((d) => !d.hasVector).length;

  return (
    <>
      <header className="mb-9">
        <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.14em] text-royal-soft">
          {organisation.name}
        </p>
        <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-white">
          Decisions
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/50">
          What this organisation has already settled. Every assessment from here
          on is judged with these in front of it, so a question answered once is
          not asked again.
        </p>
      </header>

      {decisions.length === 0 ? (
        <div className="mb-8 rounded-2xl border border-white/[0.09] bg-white/[0.015] px-6 py-10 text-center">
          <span className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border border-white/12 bg-white/[0.04] text-white/40">
            <Gavel size={19} strokeWidth={1.9} />
          </span>
          <p className="text-[14px] text-white/70">No decisions recorded yet.</p>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-white/40">
            The quickest way to start is to review a report and tick{" "}
            <span className="text-white/60">Remember this for future assessments</span>{" "}
            when you override a finding. Or write one below.
          </p>
          <Link
            href="/dashboard/documents"
            className="mt-5 inline-flex rounded-full border border-white/12 px-3.5 py-1.5 text-[12.5px] text-white/60 transition-colors hover:border-white/28 hover:text-white"
          >
            Go to the standards library
          </Link>
        </div>
      ) : null}

      <DecisionRegister decisions={decisions} unindexed={unindexed} />
    </>
  );
}
