import type { Metadata } from "next";
import { FileStack, Gavel, ScanSearch, UsersRound } from "lucide-react";
import { requireOwnerWorkspace } from "@/lib/access/gate";
import { organisationActivity } from "@/lib/access/activity";
import { ActivityBoard } from "./ActivityBoard";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";

export const metadata: Metadata = {
  title: "Activity",
  description: "Which colleague put which document through, and how far it got.",
};

/**
 * The administrator's view of their colleagues' work.
 *
 * The People page is about admission and cost. This one is about output: who
 * filed which standard, whose submission is mid-assessment, who has been
 * recording decisions. An administrator chasing a late review needs the second
 * question, and answering it from a spend figure is guesswork.
 *
 * `requireOwner` redirects a member away. The nav link is hidden from them too,
 * but that is cosmetic — this is the check that matters, and a Server Action or
 * a direct request does not run the layout in front of it.
 */
export default async function ActivityPage() {
  const access = await requireOwnerWorkspace();
  const activity = await organisationActivity(access.organisation.id);

  const { totals } = activity;

  return (
    <>
      <PageHeader
        title="Activity"
        lede={
          <>
            What everyone at {access.organisation.name} has put through Dexter — which
            standards they contributed, which designs they submitted, and where each
            one got to.
          </>
        }
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<FileStack size={16} strokeWidth={1.9} />}
          label="Documents filed"
          value={String(totals.references + totals.submissions)}
          hint={`${totals.references} standards · ${totals.submissions} submissions`}
        />
        <StatCard
          icon={<ScanSearch size={16} strokeWidth={1.9} />}
          label="Assessments run"
          value={String(totals.runs)}
          hint={totals.runs === 0 ? "None yet" : "Across all submissions"}
        />
        <StatCard
          icon={<Gavel size={16} strokeWidth={1.9} />}
          label="Decisions recorded"
          value={String(totals.decisions)}
          hint={
            totals.decisions === 0
              ? "None yet"
              : "Rulings the next assessment will weigh"
          }
        />
        <StatCard
          icon={<UsersRound size={16} strokeWidth={1.9} />}
          label="People contributing"
          value={String(totals.contributors)}
          hint={
            totals.contributors === 1
              ? "1 colleague with activity"
              : `${totals.contributors} colleagues with activity`
          }
        />
      </div>

      <ActivityBoard activity={activity} />
    </>
  );
}
