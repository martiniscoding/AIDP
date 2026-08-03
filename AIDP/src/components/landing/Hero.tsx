"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { ArrowRight } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { MeshGradient } from "@/components/visuals/MeshGradient";

const PILLARS = [
  "Automated assessment",
  "Principle-driven",
  "Always consistent",
  "Fully auditable",
];

export function Hero() {
  const reduced = useReducedMotion();

  // Always the same prop shape — see the note in Reveal. Dropping `initial`
  // and `animate` when motion is reduced would strand the opacity:0 that
  // Framer already wrote during the first (pre-detection) render.
  const rise = (delay: number) => ({
    initial: { opacity: 0, y: reduced ? 0 : 24 },
    animate: { opacity: 1, y: 0 },
    transition: reduced
      ? { duration: 0 }
      : { duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] as const },
  });

  // min-h is just under a full viewport: a true 100svh hero leaves a long dead
  // tail below the copy, and letting the next section peek is a better cue
  // that there is more below than empty space is.
  return (
    <section className="relative isolate flex min-h-[92svh] flex-col justify-center overflow-hidden pt-28 pb-12 sm:pt-32 sm:pb-16">
      {/* Backdrop, full bleed behind the copy.
          The artwork's brightest region — the magenta band along the horizon —
          runs straight through the paragraph, the buttons and the pillar row,
          so it needs a real scrim rather than just low opacity: a flat wash for
          overall level, then a centre-weighted vignette that is darkest behind
          the text and lifts toward the edges, which keeps the sunset saturated
          at the margins where nothing is set over it. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <Image
          src="/test.png"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-center"
        />
        {/* Scrim kept as light as the contrast budget allows. The copy over it
            is measured, not eyeballed — body text needs 4.5:1 and currently
            clears it, which is what caps how far these values can drop. The
            band is far brighter than the old skyline was, hence the heavier
            centre. */}
        <div className="absolute inset-0 bg-ink-900/28" />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 104% at 50% 47%, rgba(6,7,10,0.72) 0%, rgba(6,7,10,0.5) 44%, rgba(6,7,10,0.14) 78%, rgba(6,7,10,0) 100%)",
          }}
        />
        {/* Blend into the nav above and the page below. */}
        <div className="absolute inset-x-0 top-0 h-40 bg-linear-to-b from-ink-900 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-56 bg-linear-to-b from-transparent to-ink-900" />
      </div>

      {/* Gradient sits above the photo so the accent glow still reads. Held
          back to just over half strength: at full opacity its purple washes
          stack on an already-purple sky and the two turn to mud. */}
      <MeshGradient
        mode="pointer"
        showGrid={false}
        fadeBottom={false}
        className="opacity-55"
      />

      <div className="relative mx-auto w-full max-w-[1280px] px-5 sm:px-8">
        <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
          {/* Chips are dark glass, not white glass. A 6%-white fill over the
              magenta band tints pink and leaves its own label at roughly 2:1;
              tinting the ink instead keeps them legible wherever they land. */}
          <motion.div {...rise(0)}>
            <span className="inline-flex items-center gap-2.5 rounded-full border border-white/15 bg-ink-900/45 py-1.5 pl-2.5 pr-4 text-[12px] font-medium tracking-[-0.005em] text-white/90 backdrop-blur-md">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-royal-soft opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-royal-soft" />
              </span>
              AI-native architecture governance
            </span>
          </motion.div>

          {/* Two explicit lines: the spans are `block` rather than relying on
              text-balance so the break is fixed, and the clamp floor is low
              enough that neither line wraps again on a 360px screen.
              Medium weight rather than semibold — at this size the lighter cut
              with tighter tracking reads sharper, which is the point of
              moving to Inter Tight.

              The soft shadow is legibility, not decoration: it's the halo that
              keeps the glyph edges off the sunset if a viewport crop slides a
              bright stretch of sky up under the second line.

              Emphasis is royal-soft here rather than the usual accent —
              royal-mid is the same value and hue family as the sky behind it
              and drops to about 2:1 against it; the lighter step clears the
              3:1 large-text bar and still reads as the accent. */}
          <motion.h1
            {...rise(0.08)}
            className="mt-8 font-display text-[clamp(2rem,6.6vw,5rem)] font-medium leading-[1.01] tracking-[-0.045em] text-white [text-shadow:0_2px_28px_rgba(6,7,10,0.5)]"
          >
            <span className="block">Architecture reviews,</span>
            <span className="block text-royal-soft">automated end to end.</span>
          </motion.h1>

          <motion.p
            {...rise(0.16)}
            className="mt-7 max-w-xl text-[16.5px] leading-[1.65] tracking-[-0.005em] text-white/90 text-pretty [text-shadow:0_1px_16px_rgba(6,7,10,0.55)] sm:text-[17.5px]"
          >
            Dexter compresses a 6–8 week manual architecture review into 3–5 days.
            Every submission is assessed against your organization&apos;s own
            principles, standards, and prior decisions — not a generic rulebook.
          </motion.p>

          <motion.div
            {...rise(0.24)}
            className="mt-11 flex flex-col items-center gap-3 sm:flex-row sm:justify-center"
          >
            <ButtonLink href="/sign-up" size="lg" className="group">
              Get started
              <ArrowRight
                size={17}
                className="transition-transform duration-300 group-hover:translate-x-0.5"
              />
            </ButtonLink>
            <ButtonLink href="#how-it-works" variant="secondary" size="lg">
              See how it works
            </ButtonLink>
          </motion.div>

          {/* Where the scroll path begins — directly under the CTA row, so the
              line reads as descending out of the hero copy rather than out of
              the section's empty tail. Everything below it (the proof line and
              the pillar chips) is crossed by the rail, which is why the rail is
              only 7.5% white: at that level it passes behind centred text
              without competing with it, and the lit stretch has moved on by the
              time the hero has scrolled anywhere.

              ScrollPath measures this element and pulls itself up to meet it —
              it lives inside the copy column so the offset below the text is
              fixed at every viewport height, where an offset from the section's
              bottom edge would drift with the centred layout's slack. */}
          {/* Not a motion element: ScrollPath measures this marker on mount,
              and a y-offset still animating out would be baked into the lead. */}
          <div data-path-origin aria-hidden="true" className="mt-10 size-px" />

          <motion.div
            {...rise(0.34)}
            className="mt-10 flex flex-col items-center gap-4"
          >
            <p className="text-[13.5px] tracking-[-0.005em] text-white/80 [text-shadow:0_1px_14px_rgba(6,7,10,0.6)]">
              Every finding cited. Every step audited.
            </p>
            <ul className="flex flex-wrap items-center justify-center gap-2">
              {PILLARS.map((pillar) => (
                <li
                  key={pillar}
                  className="rounded-md border border-white/12 bg-ink-900/45 px-2.5 py-1 text-[12px] font-medium tracking-[-0.005em] text-white/85 backdrop-blur-md"
                >
                  {pillar}
                </li>
              ))}
            </ul>
          </motion.div>

          {/* The glowing origin and the line descending from it replace the old
              chevron cue; the marker itself now sits above, under the CTAs. */}
        </div>
      </div>
    </section>
  );
}
