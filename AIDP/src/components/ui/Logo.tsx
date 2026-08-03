import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * The Dexter mark: three stacked bars converging into a node — layers of
 * architecture resolving to a single decision. Drawn, not imported.
 */
export function LogoMark({ className }: { className?: string }) {
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
        stroke="#ffffff"
        strokeOpacity="0.3"
        strokeWidth="1.5"
      />
      <path
        d="M8 22.5h7.5M8 16h11M8 9.5h6"
        stroke="#ffffff"
        strokeOpacity="0.8"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="22.5" cy="16" r="3" fill="#8b5cf6" />
    </svg>
  );
}

export function Logo({
  className,
  href = "/",
}: {
  className?: string;
  href?: string;
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
      <LogoMark className="transition-transform duration-500 ease-out group-hover:rotate-[8deg]" />
      <span className="font-display text-[17px] font-semibold tracking-tight text-white">
        Dexter
      </span>
    </Link>
  );
}
