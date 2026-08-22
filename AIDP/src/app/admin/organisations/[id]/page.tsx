import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import { organisationDetail } from "@/lib/access/platform";
import { ROLE_LABEL, toRole } from "@/lib/access/roles";
import { STATUS_META, isRosterStatus } from "@/lib/access/roster-status";
import { formatTokens, organisationSpend } from "@/lib/access/usage";

const TONE: Record<string, string> = {
  good: "border-ok-line bg-ok-tint text-ok",
  warn: "border-warn-line bg-warn-tint text-warn",
  neutral: "border-line bg-card text-ink/68",
  off: "border-line bg-card text-ink/62",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const organisation = await organisationDetail((await params).id);
  return { title: organisation ? organisation.name : "Company" };
}

/**
 * One customer.
 *
 * People and spend. The document count is repeated from the list for context,
 * and remains the only thing this console knows about them — see the note at
 * the top of src/lib/access/platform.ts.
 *
 * Read-only on purpose. An operator reaching into a customer's roster to admit
 * or revoke somebody would be acting on their behalf without their knowledge,
 * and their own administrator has the tools to do it. Support here means being
 * able to see what is going on and tell them.
 */
export default async function OrganisationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organisation = await organisationDetail(id);
  if (!organisation) notFound();

  const spend = await organisationSpend(id);
  const sorted = [...organisation.people].sort((a, b) => b.totalTokens - a.totalTokens);

  return (
    <>
      <Link
        href="/admin"
        className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-ink/64 transition-colors hover:text-ink/84"
      >
        <ArrowLeft size={13} />
        All companies
      </Link>

      <header className="mb-8">
        <h1 className="font-display text-[28px] font-semibold tracking-[-0.02em] text-ink">
          {organisation.name}
        </h1>
        <p className="mt-1.5 text-[13.5px] text-ink/66">
          Joined{" "}
          {organisation.createdAt.toLocaleDateString(undefined, {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
          {" · "}
          {organisation.documentCount} document{organisation.documentCount === 1 ? "" : "s"}
          {" · "}
          {organisation.assessmentCount} assessment
          {organisation.assessmentCount === 1 ? "" : "s"}
          {" · "}
          {formatTokens(spend.totalTokens)} tokens over {spend.calls.toLocaleString()} calls
        </p>
      </header>

      <section>
        <h2 className="mb-4 font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
          People
          <span className="ml-2 text-[13px] font-normal text-ink/62">
            {organisation.people.length}
          </span>
        </h2>

        <div className="overflow-hidden rounded-2xl border border-line">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-card">
                  <Th>Person</Th>
                  <Th>Status</Th>
                  <Th>Role</Th>
                  <Th className="text-right">Tokens</Th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((person) => {
                  const meta = isRosterStatus(person.status)
                    ? STATUS_META[person.status]
                    : STATUS_META.imported;
                  return (
                    <tr
                      key={person.email}
                      className="border-b border-line-soft last:border-0 hover:bg-card"
                    >
                      <td className="px-3 py-3">
                        <p className="text-[13.5px] leading-tight text-ink/92">
                          {person.name || person.email.split("@")[0]}
                          {person.isPlatformAdmin && (
                            <span className="ml-2 rounded border border-royal-mid/35 px-1.5 py-px text-[10px] text-royal">
                              operator
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[12px] leading-tight text-ink/64">
                          {person.email}
                        </p>
                        {(person.jobTitle || person.department) && (
                          <p className="mt-0.5 text-[11.5px] leading-tight text-ink/58">
                            {[person.jobTitle, person.department].filter(Boolean).join(" · ")}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={cn(
                            "inline-block rounded-md border px-2 py-0.5 text-[11.5px]",
                            TONE[meta.tone],
                          )}
                        >
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-[12.5px] text-ink/70">
                        {ROLE_LABEL[toRole(person.role)]}
                      </td>
                      <td className="px-3 py-3 text-right text-[13px] tabular-nums text-ink/78">
                        {person.totalTokens > 0 ? formatTokens(person.totalTokens) : "—"}
                      </td>
                    </tr>
                  );
                })}
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-[13px] text-ink/62">
                      Nobody on this company&rsquo;s list.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {spend.byStage.length > 0 && (
        <section className="mt-9">
          <h2 className="mb-4 font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
            Usage by stage
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {spend.byStage.map((stage) => (
              <li
                key={stage.stage}
                className="flex items-baseline justify-between rounded-xl border border-line px-3.5 py-2.5"
              >
                <span className="text-[13px] capitalize text-ink/78">{stage.stage}</span>
                <span className="text-[12.5px] tabular-nums text-ink/66">
                  {formatTokens(stage.totalTokens)} · {stage.calls.toLocaleString()} calls
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-ink/62",
        className,
      )}
    >
      {children}
    </th>
  );
}
