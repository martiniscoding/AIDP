import { cn } from "@/lib/cn";

/**
 * The opening block of a product page.
 *
 * Title, one line of what the screen is for, and whatever this screen's
 * primary action is, pulled out to the right where it reads as belonging to
 * the page rather than to the first panel underneath it.
 *
 * It opens straight onto the page ground rather than inside a panel of its
 * own. Every screen here used to start with a white card that carried nothing
 * but its own title, which pushed the actual content of the page below the
 * fold and made the first real panel look like the second one.
 *
 * It is one component rather than the same markup on six pages so the eyebrow,
 * title, lede and meta keep the same relationship everywhere instead of
 * drifting a pixel at a time.
 */
export function PageHeader({
  eyebrow,
  title,
  lede,
  meta,
  action,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  lede?: React.ReactNode;
  /** The quieter line under the lede — provenance, counts, when it last ran. */
  meta?: React.ReactNode;
  /** Right-aligned control — the primary action for this screen, if it has one. */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-line pb-5",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-[0.14em] text-royal">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-display text-[27px] font-semibold tracking-[-0.025em] text-ink">
          {title}
        </h1>
        {lede ? (
          <p className="mt-2 max-w-[36rem] text-[14px] leading-relaxed text-ink/68">
            {lede}
          </p>
        ) : null}
        {meta ? <p className="mt-1.5 text-[12.5px] text-ink/62">{meta}</p> : null}
      </div>
      {action ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2.5">{action}</div>
      ) : null}
    </header>
  );
}
