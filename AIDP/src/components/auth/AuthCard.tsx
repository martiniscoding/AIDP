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
    <div className="grid grid-cols-2 gap-1 rounded-full border border-line bg-canvas-sunk p-1">
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
                ? "bg-card text-ink shadow-card"
                : "text-ink/66 hover:bg-card/60 hover:text-ink/84",
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
      <div className="edge-light relative overflow-hidden rounded-2xl border border-line bg-card p-7 shadow-[0_1px_2px_-1px_rgba(60,50,40,0.10),0_18px_50px_-24px_rgba(60,50,40,0.20),0_40px_90px_-60px_rgba(124,58,237,0.35)] backdrop-blur-2xl sm:p-9">
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

          <h1 className="font-display text-[27px] font-medium leading-[1.15] tracking-[-0.035em] text-ink text-balance">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-2.5 text-[14.5px] leading-relaxed text-ink/68 text-pretty">
              {subtitle}
            </p>
          ) : null}

          <div className="mt-7">{children}</div>
        </div>
      </div>

      {footer ? (
        <p className="mt-6 text-center text-[14px] text-ink/66">{footer}</p>
      ) : null}
    </div>
  );
}

export function FormError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-xl border border-danger-line bg-danger-tint px-3.5 py-2.5 text-[13px] leading-relaxed text-danger"
    >
      {children}
    </p>
  );
}
