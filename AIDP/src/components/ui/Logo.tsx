import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * The Dexter mark: three stacked bars converging into a node — layers of
 * architecture resolving to a single decision. Drawn, not imported.
 */
/**
 * `ink` for the light surfaces, `light` for the deep violet anchors — the
 * mark is drawn rather than imported, so it has to be told which ground it is
 * sitting on instead of inheriting a fill.
 */
type Tone = "ink" | "light";

export function LogoMark({
  className,
  tone = "ink",
}: {
  className?: string;
  tone?: Tone;
}) {
  const stroke = tone === "ink" ? "#1a1430" : "#ffffff";
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={cn("h-7 w-7", className)}
    >
      {/* Monochrome frame and layers; the decision node is the only part
          that takes the accent. */}
      <rect
        x="0.75"
        y="0.75"
        width="30.5"
        height="30.5"
        rx="9"
        stroke={stroke}
        strokeOpacity={tone === "ink" ? 0.22 : 0.32}
        strokeWidth="1.5"
      />
      <path
        d="M8 22.5h7.5M8 16h11M8 9.5h6"
        stroke={stroke}
        strokeOpacity={tone === "ink" ? 0.82 : 0.92}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle
        cx="22.5"
        cy="16"
        r="3"
        fill={tone === "ink" ? "#6d28d9" : "#c4b5fd"}
      />
    </svg>
  );
}

export function Logo({
  className,
  href = "/",
  tone = "ink",
}: {
  className?: string;
  href?: string;
  tone?: Tone;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-2.5 rounded-md",
        className,
      )}
      aria-label="Dexter home"
    >
      <LogoMark
        tone={tone}
        className="transition-transform duration-500 ease-out group-hover:rotate-[8deg]"
      />
      <span
        className={cn(
          "font-display text-[17px] font-semibold tracking-tight",
          tone === "ink" ? "text-ink" : "text-white",
        )}
      >
        Dexter
      </span>
    </Link>
  );
}
