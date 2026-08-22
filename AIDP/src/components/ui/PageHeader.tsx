import { cn } from "@/lib/cn";

/**
 * The opening block of a product page.
 *
 * Every screen in here used to start with bare type sitting on the flat page
 * ground, which is most of what made the product read as plain — nothing
 * announced where you had arrived. This gives each page a surface to open on:
 * a white panel over the tinted canvas, with the accent blooming out of the
 * corner the eye reaches first.
 *
 * It is one component rather than the same markup on four pages so the
 * eyebrow, title and lede keep the same relationship everywhere instead of
 * drifting a pixel at a time.
 */
export function PageHeader({
  eyebrow,
  title,
  lede,
  action,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  lede?: React.ReactNode;
  /** Right-aligned control — the primary action for this screen, if it has one. */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "card-sheen relative mb-5 overflow-hidden rounded-2xl border border-line bg-card px-7 py-7 shadow-card",
        className,
      )}
    >
      <div aria-hidden="true" className="header-bloom absolute inset-0" />

      <div className="relative flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.14em] text-royal">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="font-display text-[32px] font-semibold tracking-[-0.025em] text-ink">
            {title}
          </h1>
          {lede ? (
            <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink/68">
              {lede}
            </p>
          ) : null}
        </div>
        {action}
      </div>
    </header>
  );
}
