"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  motion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { FileUp, Library, ScanText, ShieldCheck } from "lucide-react";
import { useReducedMotion } from "@/lib/useReducedMotion";

const STEPS = [
  {
    icon: FileUp,
    title: "Submit",
    body: "An architect drops in the documents, the diagrams and the requirements, then picks an assessment type.",
    meta: "Requestor · minutes",
  },
  {
    icon: ScanText,
    title: "Extract",
    body: "Every upload is read: metadata, technologies and integration points come out on their own, and diagrams become a component graph.",
    meta: "Parsing · seconds",
  },
  {
    icon: Library,
    title: "Retrieve",
    body: "Your own principles, standards and prior decisions are pulled in — only the ones that bear on this submission.",
    meta: "Your knowledge base",
  },
  {
    icon: ShieldCheck,
    title: "Assess",
    body: "Compliance and risk run against that context, clause by clause, and every finding lands cited to its source.",
    meta: "Compliance + risk",
  },
];

/* ------------------------------------------------------------------ *
 * The score.
 *
 * One scroll progress value drives the whole section, and these are the
 * windows each card's entrance occupies inside it. The gaps between the
 * windows are the point: a card finishes arriving, the rail then spends a
 * beat travelling on to the next node, and only then does the next card
 * appear. Without those pauses the four cards read as one staggered group
 * rather than as four separate things the reader scrolled to.
 *
 * The last window closes at 0.82, so the final fifth of the travel is the
 * finished row holding still under the pin — a moment of simply being
 * looked at before the page starts moving again.
 * ------------------------------------------------------------------ */
const FIRST = 0.04; // where card one begins
const SLOT = 0.22; // scroll each card gets to itself
const ENTER = 0.12; // how much of that slot the card's own move uses
const SHEEN = 0.2; // the light sweeping over the glass outlasts the move
const LEAD = 0.08; // rail travel ahead of the card it leads to

const cardStart = (i: number) => FIRST + i * SLOT;

// The rail, as a piecewise map. Node centres sit at 12.5%, 37.5%, 62.5% and
// 87.5% of the row, so those are the scaleX values the fill has to stop on —
// anything else and the line's leading edge parks beside a node instead of
// under it. Each window moves the fill from the previous node to this one;
// repeating the arrival value as the next window's start is what holds the
// line still in between instead of creeping across the pause.
const RAIL_IN = STEPS.flatMap((_, i) => [cardStart(i) - LEAD, cardStart(i) + 0.02]);
const RAIL_OUT = STEPS.flatMap((_, i) => {
  const at = (i * 2 + 1) / (STEPS.length * 2);
  return [i === 0 ? 0 : at - 1 / STEPS.length, at];
});

/**
 * How it works: four glass cards in a row, dealt out one scroll at a time.
 *
 * At `lg` and up the section is 340vh of scroll wrapped around a
 * viewport-high sticky frame. That height *is* the choreography — the frame
 * holds still while the page scrolls through it, which is the only way a
 * reader can scroll once more and have the next card answer. Shorten the
 * section and the cards arrive on top of one another; lengthen it and the
 * reader is scrolling at nothing between stages.
 *
 * Below `lg` four cards abreast do not fit, so the row stacks and the pin is
 * dropped: a pinned frame on a phone spends a whole screen of height to show
 * one card. Both layouts run off the same entrance windows above, measured
 * from the same section with a different scroll offset, so there is one
 * timeline rather than two to keep in step.
 */
export function HowItWorks() {
  const reduced = useReducedMotion();
  const wide = useIsWide();

  // Remounted on the breakpoint rather than reconfigured. `useSpring` binds to
  // its source in an insertion effect that does not list the source as a
  // dependency, so handing it a different scroll value leaves it following the
  // old one; a key is the honest way to rewire it. This flips at most when
  // someone drags a window across 1024px.
  return <Walk key={wide ? "pinned" : "stacked"} wide={wide} reduced={reduced} />;
}

function Walk({ wide, reduced }: { wide: boolean; reduced: boolean }) {
  const sectionRef = useRef<HTMLElement>(null);

  // Pinned: progress runs the length of the sticky travel. Stacked: it runs as
  // the section crosses the viewport, which puts each card's window at roughly
  // the moment that card comes into view.
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: wide ? ["start start", "end end"] : ["start 85%", "end 75%"],
  });

  // The spring is what keeps the row off the scrollbar. Scroll-linked values
  // move in hard steps under a trackpad flick; sprung, a card keeps arriving
  // for a few frames after the wheel stops, which is what makes the sequence
  // read as dealt rather than scrubbed.
  const progress = useSpring(scrollYProgress, {
    stiffness: 120,
    damping: 28,
    mass: 0.35,
  });

  const railScale = useTransform(progress, RAIL_IN, RAIL_OUT);

  // The field behind the glass drifts across the whole section. While the
  // frame is pinned the cards are nailed to the viewport, so this is the only
  // thing moving behind them — which is what makes the frosting legible as
  // frosting rather than as a flat pale fill.
  const driftA = useTransform(progress, [0, 1], [0, -90]);
  const driftB = useTransform(progress, [0, 1], [0, 70]);
  const driftC = useTransform(progress, [0, 1], [0, -130]);

  const pin = wide && !reduced;
  const still = (v: MotionValue<number>) => (reduced ? 0 : v);

  return (
    <section
      ref={sectionRef}
      id="how-it-works"
      className={`relative bg-white ${pin ? "h-[340vh]" : ""}`}
    >
      <div
        className={`relative px-5 pt-4 pb-24 sm:px-6 sm:pb-32 ${
          pin ? "sticky top-0 flex h-dvh flex-col justify-center py-0" : ""
        }`}
      >
        {/* The stage.
            
            Glass is only glass if there is something under it, and this page is
            a white sheet — the product shot above it had to drop its own
            backdrop blur for exactly that reason. So the section lays down a
            tinted field with three blue blooms drifting in it, and the cards
            frost *that*.
            
            It lives inside the sticky frame, not on the section: on the
            section it would be 340vh of gradient sliding past a pinned row,
            and the first card would arrive while the field was still white.
            Pinned here, the stage is viewport-locked and always at full
            strength, and it slides softly in and out under the fade mask as
            the frame enters and leaves.
            
            No z-index anywhere in here. A negative one would drop the whole
            stage behind the section's own white background, and anything that
            establishes a backdrop root between the cards and the page — a
            filter, an opacity, a mask on an *ancestor* of the cards — would
            leave the frosting with nothing to sample. In-flow order is enough:
            this paints first, the content after it. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{
            maskImage:
              "linear-gradient(180deg, transparent 0%, #000 13%, #000 87%, transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(180deg, transparent 0%, #000 13%, #000 87%, transparent 100%)",
          }}
        >
          <div className="absolute inset-0 bg-[linear-gradient(180deg,#f6fcff_0%,#e4f4fe_34%,#d9eefc_62%,#eef9ff_100%)]" />

          {/* Blooms, with no `blur()` on them. A closest-side radial gradient
              is already smooth, and a 40px filter over three 500px layers is
              a GPU bill for a difference nobody can see. */}
          <motion.div
            style={{ y: still(driftA) }}
            className="absolute -top-28 left-[4%] size-[540px] rounded-full bg-[radial-gradient(closest-side,rgba(10,110,168,0.30),rgba(10,110,168,0))]"
          />
          <motion.div
            style={{ y: still(driftB) }}
            className="absolute -right-24 bottom-[-22%] size-[600px] rounded-full bg-[radial-gradient(closest-side,rgba(62,146,192,0.34),rgba(62,146,192,0))]"
          />
          <motion.div
            style={{ x: still(driftC) }}
            className="absolute top-[26%] left-[36%] size-[460px] rounded-full bg-[radial-gradient(closest-side,rgba(0,70,113,0.20),rgba(0,70,113,0))]"
          />

          {/* A grid, faint enough to be texture rather than graph paper. It is
              what gives the frosting something with an edge to smear: a blur
              over a smooth gradient looks identical to the gradient. */}
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(90deg, rgba(4,42,65,0.055) 1px, transparent 1px), linear-gradient(180deg, rgba(4,42,65,0.055) 1px, transparent 1px)",
              backgroundSize: "72px 72px",
              maskImage:
                "radial-gradient(130% 90% at 50% 45%, #000 20%, transparent 78%)",
              WebkitMaskImage:
                "radial-gradient(130% 90% at 50% 45%, #000 20%, transparent 78%)",
            }}
          />
        </div>

        <div className="relative mx-auto w-full max-w-[1120px]">
          <div className="flex flex-col items-center text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/55 py-1.5 pr-3.5 pl-3 text-[11.5px] font-medium tracking-[0.02em] text-[#005c92] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.9),0_2px_10px_-4px_rgba(4,42,65,0.2)] backdrop-blur-md">
              <span className="block size-[6px] rounded-full bg-[#0a6ea8]" />
              How it works
            </span>

            <h2 className="mt-6 max-w-[760px] font-display text-[clamp(1.75rem,4.1vw,2.85rem)] leading-[1.1] font-semibold tracking-[-0.038em] text-[#02151f]">
              Four stages, from upload to cited report.
            </h2>

            <p className="mt-5 max-w-[520px] text-[15px] leading-[1.6] tracking-[-0.005em] text-ink/65 text-pretty">
              Nothing here runs against a generic rulebook. Every stage works
              from the standards your organisation already wrote.
            </p>
          </div>

          {/* The rail, desktop only: one line through all four nodes, filling
              left to right as the cards arrive. It is its own row of equal
              cells sharing the card row's gap, so a node centres over its card
              at any width. Both ends fade out under a mask rather than
              stopping — once the gap is taken out of the columns no percentage
              endpoint lands on the first and last node centres, and a line
              that stops just shy of a node is worse than one that never
              claims to stop at all.
              
              The unlit track is white rather than pale blue now: on the tinted
              stage a blue line is the stage. */}
          <div aria-hidden="true" className="relative mt-14 hidden lg:block">
            <div
              className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2"
              style={{
                maskImage:
                  "linear-gradient(90deg, transparent 0%, #000 11%, #000 89%, transparent 100%)",
                WebkitMaskImage:
                  "linear-gradient(90deg, transparent 0%, #000 11%, #000 89%, transparent 100%)",
              }}
            >
              <div className="absolute inset-0 rounded-full bg-white/75" />
              <motion.div
                style={{ scaleX: reduced ? 1 : railScale }}
                className="absolute inset-0 origin-left rounded-full bg-[linear-gradient(90deg,#3e92c0_0%,#0a6ea8_45%,#004671_100%)] shadow-[0_0_12px_0_rgba(10,110,168,0.5)]"
              />
            </div>

            <div className="relative flex gap-7">
              {STEPS.map((step, i) => (
                <div key={step.title} className="flex flex-1 basis-0 justify-center">
                  <StepNode index={i} progress={progress} reduced={reduced} />
                </div>
              ))}
            </div>
          </div>

          <ol className="mt-12 flex flex-col gap-8 lg:mt-7 lg:flex-row lg:items-stretch lg:gap-7">
            {STEPS.map((step, i) => (
              <StepCard
                key={step.title}
                step={step}
                index={i}
                progress={progress}
                reduced={reduced}
              />
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/** One card, plus the stub of rail reaching the card below it on mobile. */
function StepCard({
  step,
  index,
  progress,
  reduced,
}: {
  step: (typeof STEPS)[number];
  index: number;
  progress: MotionValue<number>;
  reduced: boolean;
}) {
  const start = cardStart(index);
  const end = start + ENTER;

  const opacity = useTransform(progress, [start, end], [0, 1]);
  const y = useTransform(progress, [start, end], [38, 0]);
  const scale = useTransform(progress, [start, end], [0.94, 1]);

  // Light crossing the pane as it arrives. This is where the entrance used to
  // carry a blur that resolved, which a frosted card has nothing to say with —
  // and `filter` on the same element as `backdrop-filter` is where WebKit
  // drops the backdrop altogether, so the card would have arrived sharp and
  // un-frosted. A specular sweep is the effect the glass actually wants.
  const sheenX = useTransform(progress, [start, start + SHEEN], ["-70%", "70%"]);
  const sheen = useTransform(
    progress,
    [start, start + 0.05, start + 0.13, start + SHEEN],
    [0, 0.62, 0.62, 0],
  );

  // The stub of rail below the card on mobile, drawn in the beat before the
  // next card lands — the same job the desktop rail does between two nodes.
  const nextStart = cardStart(index + 1);
  const stub = useTransform(progress, [nextStart - LEAD, nextStart + 0.02], [0, 1]);
  const isLast = index === STEPS.length - 1;

  const Icon = step.icon;

  return (
    <li className="relative lg:flex-1 lg:basis-0">
      {!isLast ? (
        // Centred on the node inside the card above it: the card's own padding
        // plus half a node, which is why this moves at `sm` with the padding.
        <div
          aria-hidden="true"
          className="absolute top-full left-[41px] h-8 w-[2px] sm:left-[45px] lg:hidden"
        >
          <div className="absolute inset-0 rounded-full bg-white/75" />
          <motion.div
            style={{ scaleY: reduced ? 1 : stub }}
            className="absolute inset-0 origin-top rounded-full bg-[linear-gradient(180deg,#3e92c0_0%,#004671_100%)]"
          />
        </div>
      ) : null}

      {/* The pane.
          
          A translucent white fill, a real backdrop blur with the saturation
          pushed up so the blooms underneath keep their colour through it, and
          then the two things that actually sell glass: a bright inset hairline
          along the top edge, where a pane catches the light, and a shadow deep
          enough that the card is clearly floating above the field rather than
          printed on it.
          
          Opacity animating on this same element is fine — an element's own
          `opacity` establishes a backdrop root for its *descendants*, not for
          itself, so the frosting still samples the stage while the card fades
          in. `filter` would not be fine, which is what the sheen above is
          about. */}
      <motion.div
        style={reduced ? { opacity: 1, y: 0, scale: 1 } : { opacity, y, scale }}
        className="relative flex h-full flex-col overflow-hidden rounded-[18px] bg-white/55 p-5 ring-1 ring-white/60 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.95),inset_0_-1px_0_0_rgba(255,255,255,0.35),0_1px_2px_-1px_rgba(4,42,65,0.14),0_26px_52px_-26px_rgba(4,42,65,0.36)] backdrop-blur-[22px] backdrop-saturate-150 transition-[background-color,box-shadow] duration-500 hover:bg-white/70 hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,1),inset_0_-1px_0_0_rgba(255,255,255,0.4),0_1px_2px_-1px_rgba(4,42,65,0.16),0_38px_68px_-28px_rgba(4,42,65,0.46)] sm:p-6"
      >
        {/* The lit top edge, brightest at the middle. The inset hairline above
            runs the full width at one value; this is what gives it a hotspot,
            which is the difference between a border and a reflection. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-5 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent)]"
        />

        <div className="flex items-center gap-3.5">
          {/* On a phone the number has no rail to sit on, so it rides in the
              card beside the icon instead. */}
          <span className="lg:hidden">
            <StepNode index={index} progress={progress} reduced={reduced} />
          </span>

          {/* No backdrop blur on this one, deliberately. The card above it
              already has one, and a `backdrop-filter` is a backdrop root for
              everything inside it — so this would be blurring the card's own
              translucent white, which is to say nothing. A gradient fill with
              a lit edge is the same look without the lie. */}
          <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-[linear-gradient(145deg,rgba(255,255,255,0.95)_0%,rgba(255,255,255,0.3)_100%)] text-[#005c92] ring-1 ring-white/80 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.9),0_4px_10px_-6px_rgba(4,42,65,0.35)]">
            <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
          </span>
        </div>

        <h3 className="mt-5 font-display text-[19px] leading-[1.2] font-semibold tracking-[-0.03em] text-[#02151f]">
          {step.title}
        </h3>

        {/* A step darker than it was on white paper. Body copy needs /62 or
            better against this ground to clear the contrast floor, and the
            glass fill sits lighter than the stage behind it. */}
        <p className="mt-2.5 text-[13.5px] leading-[1.6] text-ink/68 text-pretty">
          {step.body}
        </p>

        {/* Blue rather than a faint grey. At 10.5px this has to carry real
            contrast, and ink at the alpha this label wants would not: royal-mid
            measures 7.1:1 and ties the footer to the accent besides. */}
        <span className="mt-6 border-t border-white/70 pt-3.5 text-[10.5px] font-medium tracking-[0.14em] text-[#005c92] uppercase lg:mt-auto">
          {step.meta}
        </span>

        {/* The sweep sits over the content, not under it. Light crossing a pane
            crosses everything behind the pane — tuck it below the text and it
            reads as a stripe painted inside the card. */}
        <motion.div
          aria-hidden="true"
          style={
            reduced
              ? { opacity: 0 }
              : { opacity: sheen, x: sheenX }
          }
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(112deg,transparent_32%,rgba(255,255,255,0.9)_47%,rgba(255,255,255,0.35)_54%,transparent_68%)]"
        />
      </motion.div>
    </li>
  );
}

/**
 * The numbered node. Two stacked discs — a pale one and the blue one over it —
 * so lighting up is an opacity crossfade rather than a background that has to
 * animate between two gradients. The translucent white bezel is what makes the
 * rail read as threaded through the node rather than running behind it: the
 * line passes under a frosted collar instead of butting into a hard edge.
 *
 * The bezel gets no backdrop blur, tempting as it is. `backdrop-filter` is
 * clipped to the border box, every pixel of which is covered by the opaque
 * discs, and the ring is a box-shadow painted outside that box — so the blur
 * would spend a compositing layer to frost nothing.
 */
function StepNode({
  index,
  progress,
  reduced,
}: {
  index: number;
  progress: MotionValue<number>;
  reduced: boolean;
}) {
  const start = cardStart(index) - 0.02;
  const fill = useTransform(progress, [start, start + ENTER], [0, 1]);
  const pop = useTransform(progress, [start, start + ENTER], [0.9, 1]);
  const halo = useTransform(progress, [start, start + ENTER], [0, 1]);

  return (
    <motion.span
      style={{ scale: reduced ? 1 : pop }}
      className="relative grid size-11 shrink-0 place-items-center rounded-full ring-[5px] ring-white/55"
    >
      <span className="absolute inset-0 rounded-full bg-white/70 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.9)]" />
      <motion.span
        style={{ opacity: reduced ? 1 : fill }}
        className="absolute inset-0 rounded-full bg-[linear-gradient(140deg,#0a6ea8_0%,#004671_100%)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.35),0_8px_18px_-8px_rgba(0,70,113,0.85)]"
      />
      {/* The lit node throws a little colour onto the stage around it. */}
      <motion.span
        aria-hidden="true"
        style={{ opacity: reduced ? 1 : halo }}
        className="absolute -inset-[14px] -z-10 rounded-full bg-[radial-gradient(closest-side,rgba(10,110,168,0.3),rgba(10,110,168,0))]"
      />
      <span className="relative font-display text-[12.5px] font-semibold tabular-nums text-white">
        {String(index + 1).padStart(2, "0")}
      </span>
    </motion.span>
  );
}

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Whether the row is laid out abreast, which decides both the pin and which
 * scroll offset the section is measured with. It settles before paint for the
 * same reason `useReducedMotion` does: a frame measured against the wrong
 * offset is a frame of cards sitting at the wrong point in their entrance.
 *
 * The fallback is the stacked mapping, which is the safe one to be wrong
 * about — it ends with every card at full opacity either way.
 */
function useIsWide() {
  const [wide, setWide] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(query.matches);

    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return wide;
}
