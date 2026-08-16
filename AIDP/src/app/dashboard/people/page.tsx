import type { Metadata } from "next";
import { Coins, UserRound, UsersRound } from "lucide-react";
import { requireOwner } from "@/lib/access/gate";
import { list } from "@/lib/access/roster";
import { formatTokens, organisationSpend } from "@/lib/access/usage";
import { PeopleTable } from "./PeopleTable";
import { ImportPanel } from "./ImportPanel";

export const metadata: Metadata = {
  title: "People",
  description: "Who can use Dexter in your organisation, and what they are spending.",
};

/**
 * The customer administrator's console.
 *
 * Two jobs on one page, because they are the same job viewed twice: who is
 * allowed in, and what they have used. Splitting them would mean an
 * administrator checking a spend figure has to go somewhere else to act on it.
 *
 * `requireOwner` throws for a member, which the dashboard layout renders as a
 * refusal. The nav link is hidden from them as well, but that is cosmetic —
 * this is the check that matters.
 */
export default async function PeoplePage() {
  const access = await requireOwner();
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
      <header className="mb-8">
        <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-white">
          People
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] text-white/50">
          Everyone at {access.organisation.name} who can use Dexter. Load your staff
          list, then admit the people who need access — nobody gets in until you
          say so.
        </p>
      </header>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <Stat
          icon={<UsersRound size={16} strokeWidth={1.9} />}
          label="With access"
          value={String(admitted)}
          hint={admitted === 1 ? "1 person can sign in" : `${admitted} people can sign in`}
        />
        <Stat
          icon={<UserRound size={16} strokeWidth={1.9} />}
          label="On the list, not admitted"
          value={String(waiting)}
          hint={waiting === 0 ? "Nobody waiting" : "Imported, with no access"}
        />
        <Stat
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
          <h2 className="mb-1 font-display text-[17px] font-semibold tracking-[-0.01em] text-white">
            Where the tokens went
          </h2>
          <p className="mb-4 text-[12.5px] text-white/40">
            By pipeline stage. Analysis is the expensive one — it asks the model
            about every clause of every standard.
          </p>
          <ul className="space-y-2">
            {spend.byStage.map((stage) => {
              const share =
                spend.totalTokens > 0 ? (stage.totalTokens / spend.totalTokens) * 100 : 0;
              return (
                <li key={stage.stage} className="rounded-xl border border-white/[0.08] p-3.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] text-white/75 capitalize">{stage.stage}</span>
                    <span className="text-[12.5px] tabular-nums text-white/45">
                      {formatTokens(stage.totalTokens)} · {stage.calls.toLocaleString()} calls
                    </span>
                  </div>
                  <div
                    aria-hidden="true"
                    className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.07]"
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

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.09] bg-white/[0.02] p-5">
      <div className="flex items-center gap-2 text-white/40">
        <span className="text-royal-soft">{icon}</span>
        <span className="text-[11px] font-medium uppercase tracking-[0.13em]">{label}</span>
      </div>
      <p className="mt-3 font-display text-[26px] font-semibold tabular-nums tracking-tight text-white">
        {value}
      </p>
      <p className="mt-0.5 text-[12px] text-white/35">{hint}</p>
    </div>
  );
}
