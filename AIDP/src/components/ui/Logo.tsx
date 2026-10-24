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
 * The AIDP mark: four rounded tiles on a skewed 2x2 pinwheel — two large,
 * two small, leaning into the reading direction. Traced from the brand
 * master in `public/logo.png` (tile geometry and the colour ramps are
 * measured off it), with the wordmark left out: it is set in live type
 * beside the mark, so it stays legible at 28px and inherits the page's
 * colour instead of carrying a black plate behind it.
 */
const TILES = [
  { x: 0, y: 0, w: 152, h: 143, r: 11 },
  { x: 170, y: 62, w: 85, h: 81, r: 9 },
  { x: 0, y: 165, w: 85, h: 88, r: 9 },
  { x: 103, y: 165, w: 153, h: 145, r: 11 },
] as const;

/**
 * Ramp per tile, top to bottom. `light` is the master's own palette; `ink`
 * walks the same pinwheel down into the royal ladder so the brightest tile
 * does not vanish into a white footer.
 */
const RAMPS: Record<Tone, readonly (readonly [string, string])[]> = {
  light: [
    ["#f2fdff", "#c9f8ff"],
    ["#b2e6fe", "#93d9ff"],
    ["#96c0d6", "#71a0ba"],
    ["#3a8dbb", "#003a66"],
  ],
  ink: [
    ["#1d84c0", "#0b6498"],
    ["#67b2dc", "#4b9bcb"],
    ["#9dbfd2", "#7fa5bb"],
    ["#01547f", "#00263f"],
  ],
};

export function LogoMark({
  className,
  tone = "ink",
}: {
  className?: string;
  tone?: Tone;
}) {
  // Keyed by tone rather than by instance: every mark of a given tone defines
  // the same four ramps, so repeated ids resolve to an identical gradient and
  // the component stays usable from a server component (no useId).
  const id = (i: number) => `aidp-mark-${tone}-${i}`;

  return (
    <svg
      viewBox="0 0 325 325"
      fill="none"
      aria-hidden="true"
      className={cn("h-7 w-7", className)}
    >
      <defs>
        {RAMPS[tone].map(([from, to], i) => (
          <linearGradient key={i} id={id(i)} x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0" stopColor={from} />
            <stop offset="1" stopColor={to} />
          </linearGradient>
        ))}
      </defs>
      {/* The lean is the mark's whole gesture, so it is one skew on the group
          rather than four hand-drawn parallelograms. */}
      <g transform="translate(84.5 7.5) skewX(-17.4)">
        {TILES.map((tile, i) => (
          <rect
            key={i}
            x={tile.x}
            y={tile.y}
            width={tile.w}
            height={tile.h}
            rx={tile.r}
            fill={`url(#${id(i)})`}
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
  const spin = "transition-transform duration-500 ease-out group-hover:rotate-[8deg]";

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
          <LogoMark tone="ink" className={cn("rail-mark-light", spin)} />
          <LogoMark tone="light" className={cn("rail-mark-dark", spin)} />
        </>
      ) : (
        <LogoMark tone={tone} className={spin} />
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
