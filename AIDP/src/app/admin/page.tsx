import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Building2, Coins, Users } from "lucide-react";
import { listOrganisations } from "@/lib/access/platform";
import { formatTokens, platformSpend } from "@/lib/access/usage";

export const metadata: Metadata = {
  title: "Companies",
  description: "Every organisation using Dexter, their people, and their usage.",
};

/**
 * Every customer, at a glance.
 *
 * The columns are chosen to answer the two questions an operator actually has:
 * is this account being used, and by how many people. Document counts appear
 * because "they have uploaded nothing" is the difference between a stalled
 * onboarding and a working one — but the count is all that appears, and
 * `listOrganisations` is where that boundary is kept.
 */
export default async function AdminPage() {
  const [organisations, totals] = await Promise.all([listOrganisations(), platformSpend()]);

  const people = organisations.reduce((sum, organisation) => sum + organisation.memberCount, 0);

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-ink">
          Companies
        </h1>
        <p className="mt-2 text-[15px] text-ink/68">
          Every organisation on the platform.
        </p>
      </header>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <Stat
          icon={<Building2 size={16} strokeWidth={1.9} />}
          label="Companies"
          value={String(totals.organisations)}
        />
        <Stat
          icon={<Users size={16} strokeWidth={1.9} />}
          label="People with access"
          value={String(people)}
        />
        <Stat
          icon={<Coins size={16} strokeWidth={1.9} />}
          label="Tokens used"
          value={formatTokens(totals.totalTokens)}
          hint={`${totals.calls.toLocaleString()} model calls`}
        />
      </div>

      {organisations.length === 0 ? (
        <p className="rounded-2xl border border-line p-10 text-center text-[13.5px] text-ink/62">
          No companies have registered yet.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {organisations.map((organisation) => (
            <li key={organisation.id}>
              <Link
                href={`/admin/organisations/${organisation.id}`}
                className="group block rounded-2xl border border-line bg-card shadow-card p-5 transition-[border-color,background-color] hover:border-line-strong hover:bg-canvas-sunk"
              >
                <div className="flex flex-wrap items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">
                        {organisation.name}
                      </h2>
                      {organisation.documentCount === 0 && (
                        <span className="rounded-full border border-warn-line bg-warn-tint px-2 py-0.5 text-[10.5px] text-warn">
                          Nothing uploaded
                        </span>
                      )}
                    </div>

                    <p className="mt-1 text-[12.5px] text-ink/64">
                      {organisation.owners.length > 0
                        ? organisation.owners
                            .map((owner) => `${owner.name || owner.email} (${owner.email})`)
                            .join(", ")
                        : "No administrator"}
                    </p>

                    <dl className="mt-3.5 flex flex-wrap gap-x-6 gap-y-1.5 text-[12.5px]">
                      <Pair label="People" value={String(organisation.memberCount)} />
                      {organisation.invitedCount > 0 && (
                        <Pair label="Invited" value={String(organisation.invitedCount)} />
                      )}
                      {organisation.pendingCount > 0 && (
                        <Pair label="Not admitted" value={String(organisation.pendingCount)} />
                      )}
                      <Pair label="Documents" value={String(organisation.documentCount)} />
                      <Pair label="Assessments" value={String(organisation.assessmentCount)} />
                      <Pair label="Tokens" value={formatTokens(organisation.totalTokens)} />
                    </dl>
                  </div>

                  <div className="text-right">
                    <p className="text-[11.5px] text-ink/62">
                      Joined{" "}
                      {organisation.createdAt.toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </p>
                    <p className="mt-1 text-[11.5px] text-ink/62">
                      {organisation.lastActivityAt
                        ? `Active ${organisation.lastActivityAt.toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "short",
                          })}`
                        : "No activity"}
                    </p>
                    <ArrowUpRight
                      size={15}
                      className="ml-auto mt-2 text-ink/58 transition-colors group-hover:text-ink/72"
                    />
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink/62">{label}</dt>
      <dd className="tabular-nums text-ink/78">{value}</dd>
    </div>
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
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-card shadow-card p-5">
      <div className="flex items-center gap-2 text-ink/64">
        <span className="text-royal">{icon}</span>
        <span className="text-[11px] font-medium uppercase tracking-[0.13em]">{label}</span>
      </div>
      <p className="mt-3 font-display text-[26px] font-semibold tabular-nums tracking-tight text-ink">
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[12px] text-ink/62">{hint}</p>}
    </div>
  );
}
