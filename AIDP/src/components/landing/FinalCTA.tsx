"use client";

import { ArrowRight } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { Reveal } from "@/components/ui/Reveal";

export function FinalCTA() {
  return (
    <section className="relative overflow-hidden pt-24 pb-28 sm:pt-32 sm:pb-36">
      {/* The scroll path terminates here — this glow is where it comes to rest. */}
      <div
        aria-hidden="true"
        className="animate-drift-a pointer-events-none absolute left-1/2 top-16 size-[42rem] -translate-x-1/2 rounded-full blur-[120px]"
        style={{
          background:
            "radial-gradient(circle, rgba(124,58,237,0.22), rgba(109,40,217,0.08) 45%, transparent 70%)",
        }}
      />

      <div className="relative mx-auto max-w-[1280px] px-5 sm:px-8">
        {/* Terminus. The path ends on this marker rather than on the copy
            block below, so the line comes to rest above the headline instead
            of striking through it. */}
        <div
          data-path-anchor
          aria-hidden="true"
          className="mx-auto mb-14 size-px sm:mb-16"
        />

        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <Reveal>
            <h2 className="font-display text-[clamp(2.25rem,5.5vw,4.25rem)] font-medium leading-[1.02] tracking-[-0.045em] text-white text-balance">
              Give your architecture board its weeks back.
            </h2>
          </Reveal>
          <Reveal delay={0.08}>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-white/60 text-pretty">
              Load your principles, submit a request, and see the assessment
              your team would have spent a month assembling by hand.
            </p>
          </Reveal>
          <Reveal delay={0.16}>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
              <ButtonLink href="/sign-up" size="lg" className="group">
                Get started
                <ArrowRight
                  size={17}
                  className="transition-transform duration-300 group-hover:translate-x-0.5"
                />
              </ButtonLink>
              <ButtonLink href="/sign-in" variant="secondary" size="lg">
                Sign in
              </ButtonLink>
            </div>
          </Reveal>
          <Reveal delay={0.24}>
            <p className="mt-8 text-[13px] text-white/35">
              Every finding cited. Every step audited.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
