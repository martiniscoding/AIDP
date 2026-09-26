import { CalendarClock, ChevronDown, ExternalLink } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  describe,
  formatDay,
  type LifecycleStatus,
  type LifecycleView,
  type Technology,
} from "@/lib/ingest/lifecycle";

/**
 * The report's "Technology support": whether the products this design builds on
 * are still supported by their vendors, from endoflife.date.
 *
 * Facts about the products, not a verdict against the customer's standards, so
 * they wear their own labels and say where they came from and when — the dates
 * change, and a report read next year must not pass last year's status off as
 * today's. Only product names were looked up, and the section says so: a reader
 * of a compliance report is entitled to know what left the system.
 */

const STATUS_META: Record<LifecycleStatus, { label: string; tone: string }> = {
  ended: { label: "Support ended", tone: "border-danger-line bg-danger-tint text-danger" },
  ending: { label: "Ending soon", tone: "border-warn-line bg-warn-tint text-warn" },
  unchecked: { label: "Not checked", tone: "border-line bg-canvas-sunk text-ink/72" },
  unknownVersion: { label: "Check version", tone: "border-line bg-canvas-sunk text-ink/72" },
  unversioned: { label: "No version stated", tone: "border-line bg-canvas-sunk text-ink/72" },
  supported: { label: "Supported", tone: "border-ok-line bg-ok-tint text-ok" },
  untracked: { label: "No public data", tone: "border-line bg-card text-ink/62" },
};

function where(t: Technology): string {
  const path = t.headingPath
    .split("›")
    .map((part) => part.trim())
    .filter(Boolean);
  const name =
    path.length === 0 ? t.sectionTitle : path.length <= 2 ? path[path.length - 1] : path.slice(-2).join(" › ");
  const page = t.page !== null ? `page ${t.page}` : "";
  return [name, page].filter(Boolean).join(", ");
}

function Notice({ children, warn = false }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <p
      className={cn(
        "rounded-xl border px-4 py-3 text-[12.5px] leading-relaxed",
        warn ? "border-warn-line bg-warn-tint text-warn" : "border-line bg-card text-ink/64",
      )}
    >
      {children}
    </p>
  );
}

export function Lifecycle({ lifecycle }: { lifecycle: LifecycleView | null }) {
  // Runs from before this check existed have nothing to say, and say nothing.
  if (!lifecycle) return null;

  const complete = lifecycle.state === "complete" ? lifecycle : null;
  const tracked = complete ? complete.technologies.filter((t) => t.status !== "untracked") : [];
  const untracked = complete ? complete.technologies.filter((t) => t.status === "untracked") : [];
  const tally = (["ended", "ending", "supported"] as const)
    .map((status) => ({ status, n: tracked.filter((t) => t.status === status).length }))
    .filter(({ n }) => n > 0);

  return (
    <section aria-labelledby="lifecycle-heading" className="mt-10">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3
          id="lifecycle-heading"
          className="flex items-center gap-2 font-display text-[15px] font-semibold tracking-[-0.01em] text-ink"
        >
          <CalendarClock size={15} className="text-royal" aria-hidden="true" />
          Technology support
        </h3>
        {tally.length > 0 && (
          <p className="text-[12px] text-ink/62">
            {tally
              .map(({ status, n }) => `${n} ${STATUS_META[status].label.toLowerCase()}`)
              .join(" · ")}
          </p>
        )}
      </div>

      {!complete ? (
        <Notice warn={lifecycle.state === "failed"}>
          {lifecycle.note ?? "The support status of this design's technologies was not checked."}
        </Notice>
      ) : (
        <div className="space-y-3">
          <p className="text-[12.5px] leading-relaxed text-ink/68">
            Support dates for the products this design names, from{" "}
            <a
              href="https://endoflife.date"
              target="_blank"
              rel="noreferrer"
              className="text-royal underline decoration-royal/40 underline-offset-2 hover:text-ink"
            >
              endoflife.date
            </a>
            {complete.checkedAt ? `, checked on ${formatDay(complete.checkedAt)}` : ""}. Only
            product names were looked up; nothing from the design left this system. These are
            facts about the products, not requirements of your standards.
          </p>

          {tracked.length === 0 ? (
            <Notice>None of the technologies this design names has public support data to check.</Notice>
          ) : (
            <ul className="space-y-2">
              {tracked.map((technology) => (
                <Row
                  key={`${technology.product ?? technology.name}-${technology.version ?? ""}`}
                  technology={technology}
                />
              ))}
            </ul>
          )}

          {untracked.length > 0 && (
            <p className="text-[12px] leading-relaxed text-ink/58">
              Also named, with no public support data to check:{" "}
              {untracked.map((t) => (t.version ? `${t.name} ${t.version}` : t.name)).join(", ")}.
              Confirm their support with the vendor.
            </p>
          )}
          {complete.setAside > 0 && (
            <p className="text-[12px] text-ink/58">
              {complete.setAside} more {complete.setAside === 1 ? "was" : "were"} left out because
              the design&rsquo;s own words did not bear {complete.setAside === 1 ? "it" : "them"} out.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Row({ technology: t }: { technology: Technology }) {
  const meta = STATUS_META[t.status];
  return (
    <li className="rounded-xl border border-line bg-card">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid [&::-webkit-details-marker]:hidden">
          <span
            className={cn(
              "mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
              meta.tone,
            )}
          >
            {meta.label}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium text-ink">
              {t.label}
              {t.version ? ` ${t.version}` : ""}
              {t.name.toLowerCase() !== t.label.toLowerCase() && (
                <span className="ml-1.5 text-[12px] font-normal text-ink/58">
                  named &ldquo;{t.name}&rdquo;
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink/70">
              {describe(t)}
            </span>
          </span>
          <ChevronDown
            size={15}
            aria-hidden="true"
            className="mt-1 shrink-0 text-ink/50 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="space-y-2.5 border-t border-line px-4 py-3">
          {t.quote && (
            <figure className="rounded-lg border border-line bg-canvas-sunk px-3 py-2">
              <blockquote className="text-[12.5px] text-ink/82">&ldquo;{t.quote}&rdquo;</blockquote>
              <figcaption className="mt-1 text-[11.5px] text-ink/58">
                From the design{where(t) ? `, ${where(t)}` : ""}
              </figcaption>
            </figure>
          )}
          {t.link && (
            <a
              href={t.link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[12px] text-royal underline decoration-royal/40 underline-offset-2 hover:text-ink"
            >
              {t.label} release lines on endoflife.date
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
        </div>
      </details>
    </li>
  );
}
