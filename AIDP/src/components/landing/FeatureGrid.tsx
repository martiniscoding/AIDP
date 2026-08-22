"use client";

import {
  History,
  Layers,
  Quote,
  Radar,
  ScrollText,
  Workflow,
} from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeading } from "@/components/ui/SectionHeading";

const FEATURES = [
  {
    icon: Quote,
    title: "Explainable",
    body: "Every finding cites the specific principle or standard it came from. No black-box scores, no unattributable judgements.",
  },
  {
    icon: ScrollText,
    title: "Auditable",
    body: "Every agent step is logged. The full trace behind any assessment is retrievable long after the decision was made.",
  },
  {
    icon: Layers,
    title: "Async & chunked",
    body: "Large documents and multi-minute pipelines run in the background. The interface never blocks waiting on a model.",
  },
  {
    icon: Workflow,
    title: "Diagram intelligence",
    body: "Reads draw.io and ArchiMate natively to extract the component graph, with Vision AI covering everything else.",
  },
  {
    icon: History,
    title: "Precedent search",
    body: "Surfaces the past ADRs and decisions relevant to a submission, so comparable proposals get comparable answers.",
  },
  {
    icon: Radar,
    title: "Technology radar",
    body: "Automatically flags anything in a submission that sits on your Hold or Assess list before it reaches the board.",
  },
];

export function FeatureGrid() {
  return (
    <section id="features" className="relative py-28 sm:py-40">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8">
        <SectionHeading
          eyebrow="Why it holds up"
          title="Assessment you can defend in the room."
          lede="Speed is only useful if the output survives scrutiny. Every part of the platform is built so a finding can be traced back to a source and a decision back to its evidence."
        />

        <div
          data-path-anchor
          className="mt-20 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {FEATURES.map((feature, i) => (
            <Reveal key={feature.title} delay={(i % 3) * 0.08}>
              <div className="group edge-light relative h-full overflow-hidden rounded-xl border border-line bg-card p-6 shadow-card backdrop-blur-xl transition-[transform,border-color,background-color,box-shadow] duration-500 ease-out hover:-translate-y-1 hover:border-line-strong hover:shadow-card-hover">
                {/* Inner glow that only appears on hover */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-24 left-1/2 size-56 -translate-x-1/2 rounded-full opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100"
                  style={{
                    background:
                      "radial-gradient(circle, rgba(124,58,237,0.32), transparent 70%)",
                  }}
                />
                <div className="relative">
                  <span className="grid size-9 place-items-center rounded-md border border-line bg-card text-ink/78 transition-colors duration-500 group-hover:border-line-strong group-hover:text-royal">
                    <feature.icon size={18} aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 font-display text-[16.5px] font-medium tracking-[-0.02em] text-ink">
                    {feature.title}
                  </h3>
                  <p className="mt-2.5 text-[14.5px] leading-relaxed text-ink/70 text-pretty">
                    {feature.body}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
