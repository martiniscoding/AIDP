import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * `ink` for the light surfaces, `light` for the deep navy anchors. The mark
 * is drawn rather than imported, so it has to be told which ground it is
 * sitting on instead of inheriting a fill.
 */
type Tone = "ink" | "light";

/**
 * `rail` is the third case: a ground that is white under one theme and navy
 * under the other, which no single ramp can serve. It draws both and lets
 * the stylesheet choose — see the `.rail-mark-*` rules in globals.css.
 */
type LogoTone = Tone | "rail";

/**
 * The AIDP mark: four courses of a wall leaning into the reading direction,
 * with the third course broken open and its halves pulled apart.
 *
 * The product's own sentence is that it turns standards into a gate every
 * design is checked against, and what it hands back is the list of what does
 * not hold. So the mark is a structure with the gap left in it, rather than
 * the tidy pinwheel of tiles the brand master draws — that one is a shape,
 * not a claim, and it would sit as comfortably on a hosting company.
 *
 * The lean is kept from the master in `public/logo.png`, shallower: 12°
 * against its 17.4°, because a full-width course is far wider than the
 * master's tiles and the steeper angle walks the stack off its own footing.
 *
 * The wordmark is left out. It is set in live type beside the mark, so it
 * stays legible at 28px and inherits the page's colour instead of carrying a
 * black plate behind it.
 */
const COURSE_HEIGHT = 20;
const COURSE_RADIUS = 6;

const COURSES = [
  { x: 14, y: 8, w: 72, broken: false },
  { x: 14, y: 34, w: 92, broken: false },
  { x: 14, y: 60, w: 32, broken: true },
  { x: 66, y: 60, w: 40, broken: true },
  { x: 14, y: 86, w: 56, broken: false },
] as const;

/**
 * Two rungs, not the master's four. The wall is one colour and the break is
 * the other, so the eye lands on the gap at any size. Stepping a ramp down
 * the stack instead — which is what the master does across its tiles — spends
 * the contrast on decoration, and by 16px the broken course is no longer
 * distinguishable from its neighbours.
 *
 * `light` is the master's own pale palette, for the deep navy anchors. `ink`
 * walks the same pair down into the royal ladder so that neither rung washes
 * out against paper.
 */
type Ramp = readonly [from: string, to: string];

const RAMPS: Record<Tone, { wall: Ramp; broken: Ramp }> = {
  light: {
    wall: ["#9ec6de", "#5f93b4"],
    broken: ["#e8f8ff", "#93d9ff"],
  },
  ink: {
    wall: ["#0b3c5a", "#021a28"],
    broken: ["#3aa0d8", "#1273a8"],
  },
};

const PARTS = ["wall", "broken"] as const;

export function LogoMark({
  className,
  tone = "ink",
}: {
  className?: string;
  tone?: Tone;
}) {
  // Keyed by tone rather than by instance: every mark of a given tone defines
  // the same two ramps, so repeated ids resolve to an identical gradient and
  // the component stays usable from a server component (no useId).
  const id = (part: (typeof PARTS)[number]) => `aidp-mark-${tone}-${part}`;

  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
      className={cn("h-7 w-7", className)}
    >
      <defs>
        {PARTS.map((part) => {
          const [from, to] = RAMPS[tone][part];
          return (
            <linearGradient key={part} id={id(part)} x1="0" y1="0" x2="0.3" y2="1">
              <stop offset="0" stopColor={from} />
              <stop offset="1" stopColor={to} />
            </linearGradient>
          );
        })}
      </defs>
      {/* The lean is the mark's whole gesture, so it is one skew on the group
          rather than five hand-drawn parallelograms. Pivoted on the stack's
          own middle (y=57) rather than on y=0, which is where skewX would
          otherwise hinge — from there the bottom course swings a full 22 units
          left and takes the mark out of the viewBox with it. */}
      <g transform="translate(60 57) skewX(-12) translate(-60 -57)">
        {COURSES.map((course, i) => (
          <rect
            key={i}
            x={course.x}
            y={course.y}
            width={course.w}
            height={COURSE_HEIGHT}
            rx={COURSE_RADIUS}
            fill={`url(#${id(course.broken ? "broken" : "wall")})`}
          />
        ))}
      </g>
    </svg>
  );
}

const WORDMARK: Record<LogoTone, string> = {
  ink: "text-ink",
  light: "text-white",
  // Live type, so this one needs no trick: the rail's foreground token is
  // already whichever colour the theme put there.
  rail: "text-rail-ink",
};

export function Logo({
  className,
  href = "/",
  tone = "ink",
}: {
  className?: string;
  href?: string;
  tone?: LogoTone;
}) {
  // Deepening the lean rather than spinning the mark: the lean is the thing
  // the drawing is already doing, and a rotation on a stack of courses reads
  // as the wall coming off its footing.
  const lean = "transition-transform duration-500 ease-out group-hover:-skew-x-6";

  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-2.5 rounded-md",
        className,
      )}
      aria-label="AIDP home"
    >
      {tone === "rail" ? (
        <>
          <LogoMark tone="ink" className={cn("rail-mark-light", lean)} />
          <LogoMark tone="light" className={cn("rail-mark-dark", lean)} />
        </>
      ) : (
        <LogoMark tone={tone} className={lean} />
      )}
      <span
        className={cn(
          "font-display text-[17px] font-semibold tracking-tight",
          WORDMARK[tone],
        )}
      >
        AIDP
      </span>
    </Link>
  );
}
