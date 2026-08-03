"use client";

import { ArrowUpRight, CheckCircle2, RefreshCw } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { STEP_VISUALS } from "@/components/visuals/StepVisuals";

const STEPS = [
  {
    title: "Submit Request",
    body: "An architect uploads documents, diagrams, and requirements, then picks an assessment type. Everything the review needs arrives in one place.",
    meta: "Requestor · minutes",
  },
  {
    title: "AI Auto-Fill",
    body: "The platform reads the uploads and extracts metadata, technologies, and integration points — so the submission form completes itself instead of being retyped.",
    meta: "Extraction · seconds",
  },
  {
    title: "Parse & Embed",
    body: "The document parser chunks content while the diagram analyzer pulls out the component graph. Both are converted into vector embeddings.",
    meta: "Pipeline · async",
  },
  {
    title: "Retrieve Context",
    body: "Retrieval-augmented generation pulls the principles, standards, and past decisions relevant to this specific submission out of the knowledge base.",
    meta: "RAG · pgvector",
  },
  {
    title: "AI Assessment",
    body: "A compliance checker and a risk analyzer run in parallel against the retrieved context — never against a generic, org-agnostic rulebook.",
    meta: "Parallel agents",
  },
  {
    title: "Report Generated",
    body: "Structured output: a compliance scorecard, a risk matrix, ranked findings, and concrete recommendations — each one traceable to its source.",
    meta: "Output · structured",
  },
];

const OUTCOMES = [
  {
    icon: CheckCircle2,
    title: "Approve",
    body: "Findings are acceptable. The decision and its full trace are recorded.",
  },
  {
    icon: RefreshCw,
    title: "Revise & resubmit",
    body: "Address the findings and run the assessment again against the same context.",
  },
  {
    icon: ArrowUpRight,
    title: "Escalate to ARB",
    body: "Route to the architecture review board with the report attached.",
  },
];

export function WorkflowSection() {
  // Light top padding on purpose: the hero already ends with a long tail of
  // open space, so a full-size section pad stacked on top of it reads as a void.
  return (
    <section id="how-it-works" className="relative pt-10 pb-28 sm:pt-12 sm:pb-40">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8">
        <SectionHeading
          eyebrow="How it works"
          title="From submission to sign-off, automated."
          lede="Six stages run end to end. The architect stays in control of the decision — the platform removes the weeks of manual collation, cross-referencing, and consistency checking that used to sit in front of it."
        />

        <ol className="mt-24 flex flex-col gap-28 sm:gap-36">
          {STEPS.map((step, i) => {
            const Visual = STEP_VISUALS[i];
            const visualFirst = i % 2 === 1;

            // Each half enters from the side it ends up on. Percentages, so the
            // travel scales with the column instead of being a fixed px nudge
            // on desktop and half the screen on a phone.
            const fromLeft = "-52%";
            const fromRight = "52%";

            return (
              <li
                key={step.title}
                data-path-step
                className="group relative grid items-center gap-6 lg:grid-cols-12 lg:gap-6"
              >
                {/* Copy. Six columns each with a single gutter — the previous
                    5+5 with two empty columns between read as two unrelated
                    panels rather than one step. */}
                <Reveal
                  className={
                    visualFirst
                      ? "lg:col-span-6 lg:col-start-7 lg:order-2"
                      : "lg:col-span-6 lg:col-start-1"
                  }
                  x={visualFirst ? fromRight : fromLeft}
                  y={0}
                  duration={0.95}
                >
                  <div className="step-card relative rounded-xl border border-white/[0.1] bg-white/[0.025] p-7 backdrop-blur-md transition-[border-color,background-color,box-shadow] duration-700 sm:p-8">
                    <div className="flex items-center gap-3">
                      <span className="step-index grid size-8 place-items-center rounded-md border border-white/15 font-display text-[12px] font-medium tabular-nums text-white/70 transition-colors duration-700">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="text-[11px] uppercase tracking-[0.18em] text-white/30">
                        {step.meta}
                      </span>
                    </div>
                    <h3 className="mt-6 font-display text-[26px] font-medium tracking-[-0.03em] text-white">
                      {step.title}
                    </h3>
                    <p className="mt-3 text-[14.5px] leading-[1.65] text-white/60 text-pretty">
                      {step.body}
                    </p>
                  </div>
                </Reveal>

                {/* Diagram. The anchor the scroll path threads through is the
                    outer, untransformed box: ScrollPath measures anchors with
                    getBoundingClientRect, which includes the slide-in offset,
                    so putting it on the moving element would drag the line's
                    control points sideways whenever it measures before a card
                    has landed. The wrapper holds the geometry; the card inside
                    it does the moving.

                    Hugs the inner edge of its column rather than centring in
                    it, so the diagram sits beside its copy instead of drifting
                    out toward the page margin. */}
                <div
                  className={
                    visualFirst
                      ? "lg:col-span-6 lg:col-start-1 lg:order-1"
                      : "lg:col-span-6 lg:col-start-7"
                  }
                >
                  <div
                    data-path-anchor
                    className={`mx-auto aspect-[220/170] w-full max-w-[420px] ${
                      visualFirst ? "lg:mr-0 lg:ml-auto" : "lg:ml-0 lg:mr-auto"
                    }`}
                  >
                    <Reveal
                      className="h-full"
                      x={visualFirst ? fromLeft : fromRight}
                      y={0}
                      delay={0.1}
                      duration={0.95}
                    >
                      <div className="step-visual relative h-full w-full rounded-xl border border-white/[0.1] bg-white/[0.025] p-3 transition-[border-color,box-shadow,transform] duration-700">
                        <Visual />
                      </div>
                    </Reveal>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        {/* Where the six stages land */}
        <div className="mt-28 sm:mt-36">
          <Reveal>
            <p className="mx-auto max-w-xl text-center text-[15px] leading-relaxed text-white/50 text-pretty">
              The report is a decision point, not a verdict. Every assessment
              ends in one of three recorded outcomes.
            </p>
          </Reveal>

          <div
            data-path-anchor
            className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-3"
          >
            {OUTCOMES.map((outcome, i) => (
              <Reveal key={outcome.title} delay={i * 0.08}>
                <div className="h-full rounded-xl border border-white/[0.1] bg-white/[0.025] p-6 backdrop-blur-md">
                  <outcome.icon
                    size={18}
                    className="text-white/70"
                    aria-hidden="true"
                  />
                  <h4 className="mt-4 font-display text-[15px] font-semibold text-white">
                    {outcome.title}
                  </h4>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-white/50">
                    {outcome.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
