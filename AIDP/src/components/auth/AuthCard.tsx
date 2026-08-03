import Link from "next/link";
import { LinkPending } from "@/components/ui/LinkPending";
import { cn } from "@/lib/cn";

/**
 * Segmented switch between the two entry points. Links rather than local
 * state — sign-in and sign-up are separate routes, and the control should be
 * a real navigation so both stay linkable and prefetchable.
 */
function AuthTabs({ active }: { active: "sign-in" | "sign-up" }) {
  const tabs = [
    { href: "/sign-in", label: "Sign in", key: "sign-in" },
    { href: "/sign-up", label: "Create account", key: "sign-up" },
  ] as const;

  return (
    <div className="grid grid-cols-2 gap-1 rounded-full border border-white/10 bg-ink-950/40 p-1">
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative inline-flex h-9 items-center justify-center rounded-full text-[13.5px] font-medium",
              "transition-[background-color,color,box-shadow] duration-200",
              isActive
                ? "bg-white/[0.1] text-white shadow-[0_1px_0_0_rgba(255,255,255,0.14)_inset]"
                : "text-white/45 hover:bg-white/[0.04] hover:text-white/80",
            )}
          >
            {tab.label}
            {/* Switching tabs is a route change; without this the pill sits
                inert until the other form renders. */}
            {isActive ? null : <LinkPending spinnerClassName="size-3.5" />}
          </Link>
        );
      })}
    </div>
  );
}

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
  /** Renders the sign-in / sign-up switch above the heading. */
  tab,
  /** `wide` gives the longer sign-up form room for its two-column row. */
  width = "default",
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  tab?: "sign-in" | "sign-up";
  width?: "default" | "wide";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "w-full",
        width === "wide" ? "max-w-[500px]" : "max-w-[440px]",
        className,
      )}
    >
      <div className="edge-light relative overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.035] p-7 shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_50px_120px_-60px_rgba(124,58,237,0.85),0_20px_60px_-40px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-9">
        {/* Light falling on the top edge of the glass, from the same side as
            the artwork's glow. Sits under the content, not over it. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-48"
          style={{
            background:
              "radial-gradient(90% 100% at 50% 0%, rgba(139,92,246,0.14), transparent 72%)",
          }}
        />

        <div className="relative">
          {tab ? (
            <div className="mb-7">
              <AuthTabs active={tab} />
            </div>
          ) : null}

          <h1 className="font-display text-[27px] font-medium leading-[1.15] tracking-[-0.035em] text-white text-balance">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-2.5 text-[14.5px] leading-relaxed text-white/50 text-pretty">
              {subtitle}
            </p>
          ) : null}

          <div className="mt-7">{children}</div>
        </div>
      </div>

      {footer ? (
        <p className="mt-6 text-center text-[14px] text-white/45">{footer}</p>
      ) : null}
    </div>
  );
}

export function FormError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-[13px] leading-relaxed text-rose-200"
    >
      {children}
    </p>
  );
}
