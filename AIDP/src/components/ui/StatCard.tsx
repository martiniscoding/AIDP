import { cn } from "@/lib/cn";

/**
 * One figure in the band a console page opens with.
 *
 * Three pages had their own copy of this — same label, same number, same hint,
 * three sets of sizes — so the same figure read differently depending on which
 * screen you were on. One component, and a row of them is a `grid` on the page
 * that owns them.
 *
 * The label leads, because the number means nothing without it; the hint under
 * the number is where the qualification goes ("3 estimated", "none yet"), so
 * the figure itself never has to carry a parenthesis.
 */
export function StatCard({
  icon,
  label,
  value,
  hint,
  className,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-line bg-card p-5 shadow-card",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-ink/64">
        {icon ? <span className="shrink-0 text-royal">{icon}</span> : null}
        <span className="text-[11px] font-medium uppercase tracking-[0.13em]">
          {label}
        </span>
      </div>
      <p className="mt-3 font-display text-[26px] font-semibold tabular-nums tracking-[-0.02em] text-ink">
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[12px] text-ink/62">{hint}</p> : null}
    </div>
  );
}
