"use client";

import { Reveal } from "@/components/ui/Reveal";
import { Eyebrow } from "@/components/ui/SectionHeading";
import { KnowledgeGraph } from "@/components/visuals/KnowledgeGraph";

const POINTS = [
  {
    title: "Upload once, apply everywhere",
    body: "Architects load principles, standards, and past ADRs into the repository. The platform chunks and embeds them automatically.",
  },
  {
    title: "Updates take effect immediately",
    body: "Revise a standard and the next assessment retrieves the new version. There is no re-training step and no stale rulebook.",
  },
  {
    title: "Versioned, so decisions stay explicable",
    body: "Each assessment records which version of the knowledge base it ran against, so an old decision still makes sense a year later.",
  },
];

export function KnowledgeSection() {
  return (
    <section id="knowledge" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8">
        <div className="grid items-center gap-14 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-5">
            <Reveal>
              <Eyebrow>Knowledge repository</Eyebrow>
            </Reveal>
            <Reveal delay={0.06}>
              <h2 className="mt-5 font-display text-[2.5rem] font-medium leading-[1.04] tracking-[-0.04em] text-white text-balance sm:text-[3.25rem]">
                Built on your organization&apos;s knowledge.
              </h2>
            </Reveal>
            <Reveal delay={0.12}>
              <p className="mt-5 text-[17px] leading-relaxed text-white/60 text-pretty">
                Dexter does not arrive with an opinion about your architecture. It
                assesses against the principles, standards, and precedents you
                give it — and every future assessment reflects the latest ones.
              </p>
            </Reveal>

            <ul className="mt-10 flex flex-col gap-7">
              {POINTS.map((point, i) => (
                <Reveal as="li" key={point.title} delay={0.18 + i * 0.07}>
                  <div className="border-l border-white/10 pl-5">
                    <h3 className="font-display text-[15px] font-semibold text-white">
                      {point.title}
                    </h3>
                    <p className="mt-1.5 text-[14.5px] leading-relaxed text-white/55 text-pretty">
                      {point.body}
                    </p>
                  </div>
                </Reveal>
              ))}
            </ul>
          </div>

          <div className="lg:col-span-6 lg:col-start-7">
            <Reveal delay={0.1}>
              <div
                data-path-anchor
                className="edge-light relative rounded-xl border border-white/[0.08] bg-white/[0.02] p-5 backdrop-blur-xl sm:p-8"
              >
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-xl opacity-60"
                  style={{
                    background:
                      "radial-gradient(60% 60% at 70% 40%, rgba(255,255,255,0.05), transparent 70%)",
                  }}
                />
                <div className="relative aspect-[420/200]">
                  <KnowledgeGraph />
                </div>
                <p className="relative mt-5 border-t border-white/[0.07] pt-4 text-[13px] text-white/40">
                  Sources are chunked, embedded, and versioned — then retrieved
                  per submission rather than applied as a blanket ruleset.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
