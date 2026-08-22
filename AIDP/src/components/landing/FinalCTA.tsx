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
            "radial-gradient(circle, rgba(124,58,237,0.30), rgba(109,40,217,0.10) 45%, transparent 70%)",
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

        {/* The page's closing anchor. Inset rather than full-bleed so the
            light ground carries on past it on every side — a full-width dark
            band here would read as the page ending twice, once at the CTA and
            again at the footer. */}
        <div className="relative isolate mx-auto max-w-4xl overflow-hidden rounded-3xl bg-deep px-6 py-16 text-center shadow-pop sm:px-14 sm:py-20">
          {/* Light thrown from the top edge, so the block has a direction
              rather than sitting as a flat rectangle of colour. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(85% 120% at 50% 0%, rgba(139,92,246,0.42), rgba(124,58,237,0.12) 45%, transparent 70%)",
            }}
          />

          <div className="relative mx-auto flex max-w-2xl flex-col items-center">
            <Reveal>
              <h2 className="font-display text-[clamp(2rem,4.6vw,3.5rem)] font-medium leading-[1.02] tracking-[-0.045em] text-white text-balance">
                Give your architecture board its weeks back.
              </h2>
            </Reveal>
            <Reveal delay={0.08}>
              <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-white/75 text-pretty">
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
                <ButtonLink href="/sign-in" variant="glass" size="lg">
                  Sign in
                </ButtonLink>
              </div>
            </Reveal>
            <Reveal delay={0.24}>
              <p className="mt-8 text-[13px] text-white/60">
                Every finding cited. Every step audited.
              </p>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
