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
 * The AIDP mark: three layers of a stack seen from above, split down the
 * middle by a fault, with the left halves slipped below the right.
 *
 * The stack is the architecture — layers resting on each other. The fault is
 * what the product does to it: the standards are held against the design and
 * the halves no longer line up. Drawn, not imported, so it takes the page's
 * ground and stays crisp at 16px, where a rasterised lockup goes to mush.
 *
 * The wordmark is left out. It is set in live type beside the mark, so it
 * inherits the page's colour instead of carrying a plate behind it. The full
 * lockup — mark, wordmark, tagline — lives in `public/logo.svg`.
 */

/** Half-diagonals of one layer, and the fault's half-width at the centre. */
const HALF_W = 46;
const HALF_H = 21;
const FAULT = 3;
const CENTRE = 60;

/** Centre-to-centre drop down the stack, and the slip across the fault. */
const PITCH = 27;
const SLIP = 18;

/** The dark line a layer leaves on the one beneath it. */
const SEAM = 6;

const LAYERS = 3;
const TOP = 24;

/**
 * The ramp is read top to bottom of the *drawing*, not of the stack: a
 * layer's two halves are a step apart, so the six faces fall in one
 * continuous descent and the slip reads as light leaving the lower half.
 *
 * `light` is the brand master's own palette. `ink` walks the same six steps
 * down the royal ladder, because the master's top face is all but white and
 * would disappear on paper.
 */
const RAMPS: Record<Tone, readonly string[]> = {
  light: ["#d6f0ff", "#9ccbe7", "#7eb3d5", "#5a9cc5", "#397ca7", "#2e6a92"],
  ink: ["#5aa7d4", "#3f8fc0", "#2a77a6", "#19608b", "#0c4a6e", "#042a41"],
};

/**
 * One visible face. `dir` is +1 for the half right of the fault, -1 for the
 * half left of it.
 *
 * The top layer is the whole half-diamond. Every layer below it is the same
 * shape with the layer above subtracted — so its upper edge is that layer's
 * lower edge pushed down by the seam, and the two meet halfway along the
 * face, which is what puts the knee in the outline.
 */
function face(dir: 1 | -1, centre: number, covered: boolean) {
  const edge = CENTRE + dir * FAULT;
  const tip = edge + dir * HALF_W;
  const apex = `${edge} ${centre - HALF_H}`;
  const foot = `${edge} ${centre + HALF_H}`;

  if (!covered) {
    return `M${apex}L${tip} ${centre}L${foot}Z`;
  }

  const seam = `${edge} ${centre - PITCH + HALF_H + SEAM}`;
  const knee = `${edge + dir * (HALF_W / 2)} ${centre - HALF_H / 2}`;
  return `M${seam}L${knee}L${tip} ${centre}L${foot}Z`;
}

/** The six faces, in paint order: lowest layer first, so each one is laid
 *  over the one it cuts into. */
const FACES = Array.from({ length: LAYERS }, (_, i) => i)
  .reverse()
  .flatMap((i) => {
    const covered = i > 0;
    return [
      { d: face(1, TOP + i * PITCH, covered), step: i * 2 },
      { d: face(-1, TOP + i * PITCH + SLIP, covered), step: i * 2 + 1 },
    ];
  });

export function LogoMark({
  className,
  tone = "ink",
}: {
  className?: string;
  tone?: Tone;
}) {
  const ramp = RAMPS[tone];

  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
      className={cn("h-7 w-7", className)}
    >
      {FACES.map((f) => (
        <path key={f.step} d={f.d} fill={ramp[f.step]} />
      ))}
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
  // A lift, not a skew or a spin. The mark is a stack read in projection, and
  // any transform that is not parallel to the page breaks the projection —
  // the layers stop being parallel and the drawing stops being a stack.
  const lift = "transition-transform duration-500 ease-out group-hover:-translate-y-0.5";

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
          <LogoMark tone="ink" className={cn("rail-mark-light", lift)} />
          <LogoMark tone="light" className={cn("rail-mark-dark", lift)} />
        </>
      ) : (
        <LogoMark tone={tone} className={lift} />
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
