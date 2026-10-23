"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { LandingNav } from "@/components/landing/LandingNav";
import { DashboardPreview } from "@/components/landing/DashboardPreview";

/**
 * The hero.
 *
 * The violet is a fixed-height block pinned to the top of the section rather
 * than a gradient over `inset-0`: percentage stops on a full-height section
 * would slide every time the copy rewrapped or the product shot changed
 * height, and the point where violet becomes paper has to land just under the
 * headline — that is what lets the headline be ink rather than white, which
 * is the whole character of this layout.
 *
 * Two layers make it. A vertical ramp carries violet to white, and an ellipse
 * of white light pools behind the copy on top of it. The ellipse is what keeps
 * the band saturated at the margins while the middle has already gone pale,
 * so the headline sits in its own clearing instead of on a flat wash.
 */
export function Hero() {
  const reduced = useReducedMotion();

  // Same prop shape either way: dropping `initial`/`animate` under reduced
  // motion would strand the opacity:0 Framer writes on the first render.
  const rise = (delay: number) => ({
    initial: { opacity: 0, y: reduced ? 0 : 22 },
    animate: { opacity: 1, y: 0 },
    transition: reduced
      ? { duration: 0 }
      : { duration: 0.85, delay, ease: [0.16, 1, 0.3, 1] as const },
  });

  return (
    <section id="top" className="relative isolate overflow-hidden bg-white">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[620px] sm:h-[700px]">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(180deg,#7a33de 0%,#8744e6 14%,#9458ec 24%,#a878f1 34%,#c5a8f7 44%,#e2d6fb 54%,#f4effd 62%,#fcfbff 70%,#ffffff 78%)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(720px 250px at 50% 225px, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.62) 40%, rgba(255,255,255,0.18) 72%, rgba(255,255,255,0) 100%)",
          }}
        />
        {/* Light shafts down the top band. Narrow and very faint — at 7%
            white they are texture on the violet, and anything wider or
            stronger turns into stripes the eye starts counting. The period
            stays put, so only the lit slice narrows. */}
        <div
          className="absolute inset-x-0 top-0 h-60"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, rgba(255,255,255,0) 0 68px, rgba(255,255,255,0.07) 68px 84px, rgba(255,255,255,0) 84px 152px)",
            maskImage: "linear-gradient(180deg,#000 0%,transparent 100%)",
            WebkitMaskImage: "linear-gradient(180deg,#000 0%,transparent 100%)",
          }}
        />
      </div>

      <LandingNav />

      <div className="mx-auto w-full max-w-[1060px] px-5 pt-14 sm:px-6 sm:pt-[72px]">
        <div className="flex flex-col items-center text-center">
          <motion.span
            {...rise(0)}
            className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 py-1.5 pr-4 pl-1.5 text-[12px] font-medium text-ink/80 shadow-[0_2px_10px_-4px_rgba(46,16,101,0.25)] backdrop-blur-md"
          >
            <span className="grid size-[18px] place-items-center rounded-full bg-[linear-gradient(140deg,#8b5cf6_0%,#6d28d9_100%)]">
              <span className="block size-[7px] rounded-full border-[2px] border-white border-b-transparent" />
            </span>
            Dexter — AI-native architecture governance
          </motion.span>

          {/* Two fixed lines rather than text-balance: the break is part of the
              shape, and leaving it to the balancer moves it at every width.
              The clamp floor keeps each line unwrapped down to 360px. */}
          <motion.h1
            {...rise(0.07)}
            className="mt-7 font-display text-[clamp(1.95rem,5.65vw,4.5rem)] leading-[1.06] font-semibold tracking-[-0.042em] text-[#13101f]"
          >
            <span className="block">Architecture reviews,</span>
            <span className="block">automated end to end.</span>
          </motion.h1>

          <motion.p
            {...rise(0.14)}
            className="mt-6 max-w-[540px] text-[15.5px] leading-[1.6] tracking-[-0.005em] text-ink/55 text-pretty"
          >
            Dexter assesses every submission against your own principles, standards
            and prior decisions — and cites every one of them.
          </motion.p>

          {/* Square-ish corners, not the pill the rest of the app uses. These
              two are the reference's shape and they are the only buttons on the
              page, so nothing sits beside them to look inconsistent with. */}
          <motion.div
            {...rise(0.2)}
            className="mt-9 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row sm:gap-3"
          >
            <Link
              href="#product"
              className="inline-flex h-14 w-full min-w-[140px] items-center justify-center rounded-[11px] border-[1.5px] border-[#8b5cf6] bg-white/70 px-7 text-[15px] font-medium text-[#7c3aed] transition-colors duration-300 hover:bg-white sm:w-auto"
            >
              Learn more
            </Link>
            <Link
              href="/sign-up"
              className="inline-flex h-14 w-full min-w-[140px] items-center justify-center rounded-[11px] bg-[linear-gradient(180deg,#8b5cf6_0%,#6d28d9_100%)] px-7 text-[15px] font-medium text-white shadow-[0_1px_0_0_rgba(255,255,255,0.25)_inset,0_12px_30px_-12px_rgba(109,40,217,0.75)] transition-[transform,box-shadow] duration-300 hover:-translate-y-px hover:shadow-[0_1px_0_0_rgba(255,255,255,0.3)_inset,0_18px_40px_-14px_rgba(109,40,217,0.85)] active:translate-y-0 sm:w-auto"
            >
              Get started
            </Link>
          </motion.div>
        </div>
      </div>

      <motion.div {...rise(0.3)} className="mt-14 sm:mt-16">
        <DashboardPreview />
      </motion.div>
    </section>
  );
}
