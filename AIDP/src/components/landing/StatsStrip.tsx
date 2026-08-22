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
          className="relative overflow-hidden rounded-2xl bg-deep px-6 py-12 shadow-pop sm:px-10 sm:py-14"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 100% at 50% 0%, rgba(139,92,246,0.38), transparent 70%)",
            }}
          />
          {/* Hairline along the top edge. On a deep block the light comes from
              above, which is the one place `edge-light` cannot help — that
              utility draws an ink crease for the light surfaces. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-[12%] top-0 h-px bg-linear-to-r from-transparent via-white/30 to-transparent"
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
                          ? "text-white/45"
                          : stat.accent
                            ? "text-royal-light"
                            : "text-white",
                      )}
                    >
                      {stat.value}
                    </span>
                    <span
                      className={
                        stat.muted
                          ? "font-display text-lg text-white/40"
                          : "font-display text-lg text-white/60"
                      }
                    >
                      {stat.unit}
                    </span>
                  </dd>
                  <p
                    aria-hidden="true"
                    className="max-w-[15rem] text-[13.5px] leading-relaxed text-white/65 text-pretty"
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
