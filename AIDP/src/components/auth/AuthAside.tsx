"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/ui/Logo";

/**
 * The visual half of the auth split. Same artwork as the landing hero, but
 * cropped to a tall panel: the source is a wide desert sunset, so filling a
 * portrait column keeps the whole vertical composition (sky → horizon band →
 * dark foreground) and crops width only. The foreground is where the copy
 * sits, which is why it lands on near-black rather than on the bright band.
 */

const PILLARS = [
  "Principle-driven",
  "Always consistent",
  "Fully auditable",
] as const;

type Copy = {
  eyebrow: string;
  title: React.ReactNode;
  body: string;
};

const DEFAULT_COPY: Copy = {
  eyebrow: "Architecture governance",
  title: (
    <>
      Architecture reviews,{" "}
      <span className="text-royal-light">automated end to end.</span>
    </>
  ),
  body: "Every submission assessed against your organization's own principles, standards, and prior decisions — not a generic rulebook.",
};

const COPY: Record<string, Copy> = {
  "/sign-in": {
    eyebrow: "Welcome back",
    title: (
      <>
        Your review pipeline,{" "}
        <span className="text-royal-light">right where you left it.</span>
      </>
    ),
    body: "Pick up open submissions, work through findings, and publish decisions your teams can trace.",
  },
  "/sign-up": DEFAULT_COPY,
  "/forgot-password": {
    eyebrow: "Account recovery",
    title: (
      <>
        Let&apos;s get you <span className="text-royal-light">back in.</span>
      </>
    ),
    body: "We'll email a single-use link so you can choose a new password. It expires an hour after it's sent.",
  },
  "/reset-password": {
    eyebrow: "Account recovery",
    title: (
      <>
        One step from{" "}
        <span className="text-royal-light">your workspace.</span>
      </>
    ),
    body: "Choose a new password and every open review is waiting exactly as you left it.",
  },
};

export function AuthAside() {
  const pathname = usePathname();
  const copy = COPY[pathname] ?? DEFAULT_COPY;

  return (
    <aside className="relative isolate hidden overflow-hidden bg-deep lg:sticky lg:top-0 lg:flex lg:h-svh lg:flex-col lg:justify-between">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <Image
          src="/test.png"
          alt=""
          fill
          priority
          sizes="(min-width: 1024px) 90vw, 0px"
          /* The source is wide and this panel is tall, so cover crops width
             only and the horizon lands about 72% down — too low to leave any
             dark ground for the copy. Scaling from the bottom edge trims sky
             off the top instead, lifting the horizon to roughly 58% and
             enlarging the cactus and pylons that make the crop read as a
             landscape rather than a purple wash. */
          className="origin-bottom scale-[1.45] object-cover object-[26%_center]"
        />

        {/* Level the whole plate, then pull the lower third to deep violet so
            the headline below sits on colour rather than on the magenta band.
            This panel is the auth screen's anchor: it carries the accent at
            full strength so the white form column beside it reads as light by
            contrast rather than by default. */}
        <div className="absolute inset-0 bg-deep/20" />
        {/* Two jobs, kept apart: a wash over the sky so the logo row reads,
            and a hard ramp that starts below the horizon so the copy block
            sits on solid violet while the landscape above it stays visible. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, rgba(46,16,101,0.55) 0%, rgba(46,16,101,0.10) 24%, rgba(46,16,101,0.34) 46%, rgba(46,16,101,0.84) 64%, rgba(46,16,101,0.96) 80%, #2e1065 94%)",
          }}
        />
        {/* Purple wash ties the photo to the accent used on the form side. */}
        <div
          className="absolute inset-0 mix-blend-soft-light"
          style={{
            background:
              "radial-gradient(70% 50% at 30% 20%, rgba(139,92,246,0.55), transparent 70%)",
          }}
        />
        {/* Engineering grid — faint, and only over the darker lower half. */}
        <div
          className="absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.07) 1px, transparent 1px)",
            backgroundSize: "72px 72px",
            maskImage:
              "linear-gradient(to bottom, transparent 45%, #000 75%, transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent 45%, #000 75%, transparent 100%)",
          }}
        />
      </div>

      <div className="relative flex items-center justify-between gap-4 px-10 pt-9 xl:px-12">
        <Logo tone="light" />
        <span className="inline-flex items-center gap-2.5 rounded-full border border-white/20 bg-white/10 py-1.5 pl-2.5 pr-4 text-[12px] font-medium tracking-[-0.005em] text-white/90 backdrop-blur-md">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-royal-light opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-royal-light" />
          </span>
          {copy.eyebrow}
        </span>
      </div>

      <div className="relative px-10 pb-12 xl:px-12 xl:pb-14">
        {/* The halo is legibility, not decoration: a short headline on the
            sign-in copy rides higher up the panel, where a viewport crop can
            still slide the bright band under it. */}
        <h2 className="max-w-[16ch] font-display text-[clamp(2rem,2.9vw,2.75rem)] font-medium leading-[1.06] tracking-[-0.04em] text-white text-balance [text-shadow:0_2px_26px_rgba(46,16,101,0.7)]">
          {copy.title}
        </h2>

        <p className="mt-5 max-w-[46ch] text-[15px] leading-[1.65] text-white/78 text-pretty [text-shadow:0_1px_14px_rgba(46,16,101,0.7)]">
          {copy.body}
        </p>

        {/* The one quantitative claim the product makes, stated as the
            before/after it actually is. */}
        <dl className="mt-9 flex items-end gap-7 border-t border-white/15 pt-7">
          <div>
            <dt className="text-[12px] font-medium uppercase tracking-[0.14em] text-white/55">
              Manual review
            </dt>
            <dd className="mt-1.5 font-display text-[2rem] font-medium tracking-[-0.045em] text-white/45 tabular-nums">
              6–8{" "}
              <span className="font-sans text-[15px] tracking-normal">
                weeks
              </span>
            </dd>
          </div>

          <div
            aria-hidden="true"
            className="mb-3 h-px flex-1 bg-linear-to-r from-white/10 via-white/25 to-royal-light/70"
          />

          <div>
            <dt className="text-[12px] font-medium uppercase tracking-[0.14em] text-royal-light">
              With Dexter
            </dt>
            <dd className="mt-1.5 font-display text-[2rem] font-medium tracking-[-0.045em] text-white tabular-nums">
              3–5{" "}
              <span className="font-sans text-[15px] tracking-normal text-white/70">
                days
              </span>
            </dd>
          </div>
        </dl>

        <ul className="mt-7 flex flex-wrap items-center gap-2">
          {PILLARS.map((pillar) => (
            <li
              key={pillar}
              className="rounded-md border border-white/20 bg-white/10 px-2.5 py-1 text-[12px] font-medium tracking-[-0.005em] text-white/80 backdrop-blur-md"
            >
              {pillar}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
