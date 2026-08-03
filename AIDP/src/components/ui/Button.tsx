import Link from "next/link";
import { LinkPending } from "@/components/ui/LinkPending";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

const sizes: Record<Size, string> = {
  sm: "h-9 px-4 text-[13px]",
  md: "h-11 px-5 text-sm",
  lg: "h-13 px-7 text-[15px]",
};

const base =
  "relative inline-flex select-none items-center justify-center gap-2 overflow-hidden rounded-full font-medium " +
  "transition-[transform,box-shadow,background-color,border-color,color] duration-300 ease-out " +
  "disabled:pointer-events-none disabled:opacity-55";

/**
 * Royal purple is reserved for the primary action — the one thing on any
 * screen that should pull the eye. Secondary and ghost stay monochrome so
 * it keeps that job to itself.
 */
const variants: Record<Variant, string> = {
  primary: cn(
    "bg-royal text-white shadow-[0_1px_0_0_rgba(255,255,255,0.18)_inset,0_8px_30px_-10px_rgba(109,40,217,0.9)]",
    "hover:-translate-y-px hover:bg-royal-mid active:translate-y-0",
    "hover:shadow-[0_1px_0_0_rgba(255,255,255,0.26)_inset,0_16px_44px_-10px_rgba(139,92,246,0.85)]",
  ),
  secondary: cn(
    "border border-white/15 bg-white/[0.04] text-white/85 backdrop-blur-md",
    "hover:-translate-y-px hover:border-white/30 hover:bg-white/[0.08] hover:text-white",
    "hover:shadow-[0_10px_36px_-16px_rgba(255,255,255,0.4)] active:translate-y-0",
  ),
  ghost: "text-white/65 hover:text-white hover:bg-white/[0.06] rounded-full",
};

type CommonProps = {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: React.ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: CommonProps & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(base, sizes[size], variants[variant], className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: CommonProps & { href: string } & Omit<
    React.AnchorHTMLAttributes<HTMLAnchorElement>,
    "href"
  >) {
  const classes = cn(base, sizes[size], variants[variant], className);

  // Anchor-scroll links stay as plain <a> so the browser handles the hash.
  // No pending indicator here: there is no navigation to wait on, and
  // `useLinkStatus` only reports inside a real <Link>.
  if (href.startsWith("#")) {
    return (
      <a href={href} className={classes} {...props}>
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={classes} {...props}>
      {children}
      {/* Route navigation can take a moment before the new page renders —
          cover the button so the click is visibly acknowledged. `base` is
          already `relative`, so this positions against the button. */}
      <LinkPending />
    </Link>
  );
}
