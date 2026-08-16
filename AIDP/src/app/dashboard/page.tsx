import Link from "next/link";
import { ArrowRight, Check, Layers } from "lucide-react";
import { BrandMark } from "@/components/brand/BrandMark";
import { requireAccess } from "@/lib/access/gate";
import {
  BI_REPORTING,
  DATA_SOURCES,
  DATA_WAREHOUSING,
  PRIMARY_CLOUD,
  resolveOption,
} from "@/lib/tech-stack/catalog";
import { loadAssessment } from "@/lib/tech-stack/load";
import { sectionProgress } from "@/lib/tech-stack/schema";
import { cn } from "@/lib/cn";

export default async function DashboardPage() {
  // `requireAccess` rather than a session lookup. A page renders concurrently
  // with its layout, so the layout's refusal cannot be relied on to have run
  // first — and `resolveActive` *creates* an organisation for anyone without
  // one, which would hand a workspace to somebody an administrator had
  // deliberately not admitted.
  const { user, organisation } = await requireAccess();
  const { input, status } = await loadAssessment(
    { id: user.id, name: user.name, company: user.company },
    organisation.id,
  );

  const progress = sectionProgress(input);
  const done = progress.filter((section) => section.done).length;
  const firstName = (user.name || "").split(" ")[0];

  // A glance at what they've told us so far — the stack in their own colours.
  const chosen = [
    ...input.dataWarehousing.map((id) => resolveOption(DATA_WAREHOUSING, id)),
    ...input.biReporting.map((id) => resolveOption(BI_REPORTING, id)),
    ...input.primaryCloud.map((id) => resolveOption(PRIMARY_CLOUD, id)),
    ...input.dataSources.map((id) => resolveOption(DATA_SOURCES, id)),
  ].slice(0, 12);

  return (
    <>
      <header className="mb-9">
        <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-white">
          {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        </h1>
        <p className="mt-2 text-[15px] text-white/50">
          {done === progress.length
            ? "Your technology reference is complete. Every assessment is read against it — update it whenever your stack changes."
            : "Start with your technology reference. Once it is saved, assessments weigh their findings against the platforms you actually run."}
        </p>
      </header>

      <Link
        href="/dashboard/tech-stack"
        className={cn(
          "group relative block overflow-hidden rounded-2xl border border-white/12 bg-white/[0.025] p-6 sm:p-7",
          "transition-[border-color,background-color,transform] duration-300",
          "hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[0.045]",
        )}
      >
        {/* Accent wash, anchored to the corner the eye lands on last. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-royal/20 blur-3xl transition-opacity duration-500 group-hover:opacity-150"
        />

        <div className="relative flex flex-wrap items-start gap-5">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-royal-mid/30 bg-royal/15 text-royal-soft">
            <Layers size={19} strokeWidth={1.9} />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="font-display text-[19px] font-semibold tracking-tight text-white">
                Technology Stack &amp; Architecture Reference
              </h2>
              {status === "submitted" ? (
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-300">
                  Submitted
                </span>
              ) : null}
            </div>

            <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-white/45">
              Your current data infrastructure, workload mix, and platform
              preferences — the reference we design your architecture against.
            </p>

            <ol className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
              {progress.map((section, index) => (
                <li
                  key={section.id}
                  className="flex items-center gap-2 text-[12.5px]"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-4 place-items-center rounded-full border text-[8px] font-semibold",
                      section.done
                        ? "border-royal-mid bg-royal-mid text-white"
                        : "border-white/20 text-white/40",
                    )}
                  >
                    {section.done ? (
                      <Check size={9} strokeWidth={4} />
                    ) : (
                      String(index + 1)
                    )}
                  </span>
                  <span
                    className={section.done ? "text-white/70" : "text-white/35"}
                  >
                    {section.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <span className="flex items-center gap-2 self-center rounded-full border border-white/15 px-3.5 py-2 text-[13px] text-white/70 transition-colors group-hover:border-white/30 group-hover:text-white">
            {done === 0 ? "Start" : done === progress.length ? "Review" : "Continue"}
            <ArrowRight
              size={14}
              className="transition-transform duration-300 group-hover:translate-x-0.5"
            />
          </span>
        </div>

        {chosen.length > 0 ? (
          <div className="relative mt-6 border-t border-white/[0.08] pt-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/30">
              Your stack so far
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {chosen.map((option, index) => (
                <span
                  key={`${option.id}-${index}`}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] py-1 pl-1 pr-2.5"
                >
                  <BrandMark
                    brand={option.brand}
                    label={option.label}
                    size="sm"
                    active
                  />
                  <span className="text-[12.5px] text-white/70">
                    {option.label}
                  </span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </Link>
    </>
  );
}
