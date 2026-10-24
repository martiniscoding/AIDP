import type { Metadata } from "next";
import { Coins, UserRound, UsersRound } from "lucide-react";
import { requireOwnerWorkspace } from "@/lib/access/gate";
import { list } from "@/lib/access/roster";
import { formatTokens, organisationSpend } from "@/lib/access/usage";
import { PeopleTable } from "./PeopleTable";
import { ImportPanel } from "./ImportPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";

export const metadata: Metadata = {
  title: "People",
  description: "Who can use AIDP in your organisation, and what they are spending.",
};

/**
 * The customer administrator's console.
 *
 * Two jobs on one page, because they are the same job viewed twice: who is
 * allowed in, and what they have used. Splitting them would mean an
 * administrator checking a spend figure has to go somewhere else to act on it.
 *
 * `requireOwnerWorkspace` redirects a member to their own dashboard. The nav
 * link is hidden from them as well, but that is cosmetic — this is the check
 * that matters, and the Server Actions behind the table repeat it because they
 * accept direct POSTs.
 */
export default async function PeoplePage() {
  const access = await requireOwnerWorkspace();
  const [people, spend] = await Promise.all([
    list(access.organisation.id),
    organisationSpend(access.organisation.id),
  ]);

  const admitted = people.filter(
    (person) => person.status === "active" || person.status === "allowed",
  ).length;
  const waiting = people.filter((person) => person.status === "imported").length;

  // How much of the spend figure is a guess. Embedding endpoints report no
  // token counts, so those rows are derived from input size; saying so is the
  // difference between a number and a number someone can rely on.
  const estimatedShare =
    spend.totalTokens > 0 ? Math.round((spend.estimatedTokens / spend.totalTokens) * 100) : 0;

  return (
    <>
      <PageHeader
        title="People"
        lede={
          <>
            Everyone at {access.organisation.name} who can use AIDP. Load your staff
            list, then admit the people who need access — nobody gets in until you
            say so.
          </>
        }
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={<UsersRound size={16} strokeWidth={1.9} />}
          label="With access"
          value={String(admitted)}
          hint={admitted === 1 ? "1 person can sign in" : `${admitted} people can sign in`}
        />
        <StatCard
          icon={<UserRound size={16} strokeWidth={1.9} />}
          label="On the list, not admitted"
          value={String(waiting)}
          hint={waiting === 0 ? "Nobody waiting" : "Imported, with no access"}
        />
        <StatCard
          icon={<Coins size={16} strokeWidth={1.9} />}
          label="Tokens used"
          value={formatTokens(spend.totalTokens)}
          hint={
            spend.calls === 0
              ? "No model calls yet"
              : `${spend.calls.toLocaleString()} model calls` +
                (estimatedShare > 0 ? ` · ${estimatedShare}% estimated` : "")
          }
        />
      </div>

      <ImportPanel />

      <PeopleTable people={people} currentUserId={access.user.id} />

      {spend.byStage.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-1 font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
            Where the tokens went
          </h2>
          <p className="mb-4 text-[12.5px] text-ink/64">
            By pipeline stage. Analysis is the expensive one — it asks the model
            about every clause of every standard.
          </p>
          <ul className="space-y-2">
            {spend.byStage.map((stage) => {
              const share =
                spend.totalTokens > 0 ? (stage.totalTokens / spend.totalTokens) * 100 : 0;
              return (
                <li key={stage.stage} className="rounded-xl border border-line p-3.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] text-ink/80 capitalize">{stage.stage}</span>
                    <span className="text-[12.5px] tabular-nums text-ink/66">
                      {formatTokens(stage.totalTokens)} · {stage.calls.toLocaleString()} calls
                    </span>
                  </div>
                  <div
                    aria-hidden="true"
                    className="mt-2 h-1 overflow-hidden rounded-full bg-canvas-sunk"
                  >
                    <div
                      className="h-full rounded-full bg-royal-mid/70"
                      style={{ width: `${Math.max(share, 1)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
