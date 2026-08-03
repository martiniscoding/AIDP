"use client";

import { CountUp } from "@/components/ui/CountUp";
import { Reveal } from "@/components/ui/Reveal";
import { cn } from "@/lib/cn";

/**
 * Deliberately conservative. The only quantitative claim the product makes is
 * the review-cycle timeline; the rest describe how the system is built rather
 * than inventing adoption or accuracy figures.
 */
const STATS = [
  {
    value: (
      <>
        <CountUp value={6} />–<CountUp value={8} delay={0.1} />
      </>
    ),
    unit: "weeks",
    label: "Typical manual architecture review cycle today",
    muted: true,
  },
  {
    value: (
      <>
        <CountUp value={3} />–<CountUp value={5} delay={0.1} />
      </>
    ),
    unit: "days",
    label: "Same review, assessed automatically by Dexter",
    // The one figure carrying the product's actual claim, so the one that
    // gets the accent. The rest read as white.
    accent: true,
  },
  {
    value: (
      <>
        <CountUp value={100} />%
      </>
    ),
    unit: "cited",
    label: "Findings traced to a specific principle or standard",
  },
  {
    value: <CountUp value={6} />,
    unit: "stages",
    label: "Pipeline steps, every one logged for audit",
  },
];

export function StatsStrip() {
  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8">
        <div
          data-path-anchor
          className="edge-light relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02] px-6 py-12 backdrop-blur-xl sm:px-10 sm:py-14"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 100% at 50% 0%, rgba(124,58,237,0.12), transparent 70%)",
            }}
          />
          <dl className="relative grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
            {STATS.map((stat, i) => (
              <Reveal key={stat.label} delay={i * 0.08}>
                <div className="flex flex-col gap-2.5">
                  <dt className="sr-only">{stat.label}</dt>
                  <dd className="flex items-baseline gap-2">
                    <span
                      className={cn(
                        "font-display text-5xl font-medium tracking-[-0.05em] tabular-nums sm:text-[3.5rem]",
                        stat.muted
                          ? "text-white/30"
                          : stat.accent
                            ? "text-accent"
                            : "text-white",
                      )}
                    >
                      {stat.value}
                    </span>
                    <span
                      className={
                        stat.muted
                          ? "font-display text-lg text-white/25"
                          : "font-display text-lg text-white/45"
                      }
                    >
                      {stat.unit}
                    </span>
                  </dd>
                  <p
                    aria-hidden="true"
                    className="max-w-[15rem] text-[13.5px] leading-relaxed text-white/45 text-pretty"
                  >
                    {stat.label}
                  </p>
                </div>
              </Reveal>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
