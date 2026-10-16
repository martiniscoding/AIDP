"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The shell every review dialog shares: one item of a queue, over the list.
 *
 * Compliance findings, suggested improvements and design gaps are three
 * different things to read and three different decisions to take, but they are
 * the same job to work through — open the first, read it, decide, land on the
 * next. Before this, only compliance had that; the other two tabs were lists
 * you scrolled. A reviewer learned the keys on one tab and lost them on the
 * others, which is the kind of inconsistency that makes a tool feel unfinished
 * however good each screen is on its own.
 *
 * So the behaviour lives here once and the three panels supply only their own
 * content: the position counter, Previous and Next, the arrow and j/k
 * shortcuts, Escape, the backdrop, the scroll lock, the focus move, and the
 * scroll-to-top when the item changes. A panel cannot get any of that subtly
 * wrong, because it does not implement it.
 *
 * `footer` is rendered inside the scroll area by the caller rather than pinned
 * here. The keyboard-hint bar below is the only fixed element, and it is a flex
 * sibling of the scroller — not an overlay — so it cannot cover the controls
 * the way an absolutely positioned bar did.
 */
export function ReviewDialog({
  title,
  badges,
  subtitle,
  position,
  onNavigate,
  onClose,
  children,
}: {
  /** The item's own name, read first by a screen reader. */
  title: ReactNode;
  /** Severity, priority or status chips, shown above the title. */
  badges?: ReactNode;
  /** Where in the document this came from, under the title. */
  subtitle?: ReactNode;
  /** Where this item sits in the list behind the dialog, for "3 of 41". */
  position: { index: number; total: number };
  /** Step by -1 or +1 through that list. */
  onNavigate: (delta: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  // A modal owns keyboard focus until it closes, then returns it to the
  // control that opened it. Keeping this separate from the navigation effect
  // avoids restoring focus whenever the current item changes.
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const hasPrev = position.index > 0;
  const hasNext = position.index < position.total - 1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key === "Tab") {
        const focusable = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        ).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;

        if (!first || !last) {
          event.preventDefault();
          panel.current?.focus();
        } else if (event.shiftKey && (active === first || active === panel.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      // Anything with a text caret keeps its keystrokes: a reviewer writing a
      // justification with "k" in it must not be thrown onto the next item. A
      // modifier means the shortcut was meant for the browser, not for us.
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "ArrowLeft" || event.key === "k") {
        event.preventDefault();
        onNavigate(-1);
      } else if (event.key === "ArrowRight" || event.key === "j") {
        event.preventDefault();
        onNavigate(1);
      }
    };

    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose, onNavigate]);

  // Stepping from a long item to a short one otherwise opens the next already
  // scrolled past its own first line, which is the line that matters most.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [position.index]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center"
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-dialog-title"
    >
      {/* A button, so a pointer and the keyboard both dismiss it. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/45 backdrop-blur-[2px]"
      />

      <div
        ref={panel}
        tabIndex={-1}
        className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-line bg-canvas shadow-card-hover focus-visible:outline-none sm:max-h-[88vh] sm:rounded-2xl"
      >
        <div className="flex items-start gap-3 border-b border-line bg-card px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            {badges && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">{badges}</p>
            )}
            <h2
              id="review-dialog-title"
              className="mt-0.5 font-display text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink"
            >
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink/58">{subtitle}</p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <span className="hidden whitespace-nowrap px-1 text-[11.5px] tabular-nums text-ink/58 sm:inline">
              {position.index + 1} of {position.total}
            </span>
            <button
              type="button"
              onClick={() => onNavigate(-1)}
              disabled={!hasPrev}
              aria-label="Previous"
              title="Previous (← or k)"
              className="rounded-lg p-1.5 text-ink/58 transition-colors hover:bg-canvas-sunk hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => onNavigate(1)}
              disabled={!hasNext}
              aria-label="Next"
              title="Next (→ or j)"
              className="rounded-lg p-1.5 text-ink/58 transition-colors hover:bg-canvas-sunk hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
            >
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="ml-0.5 rounded-lg p-1.5 text-ink/58 transition-colors hover:bg-canvas-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6 sm:px-5"
        >
          {children}
        </div>

        <div className="hidden items-center justify-between gap-3 border-t border-line bg-card px-5 py-2 text-[11.5px] text-ink/55 sm:flex">
          <span>
            <Key>←</Key>
            {" / "}
            <Key>→</Key>
            {" or "}
            <Key>k</Key>
            {" / "}
            <Key>j</Key>
            {" to step between items"}
          </span>
          <span>
            <Key>Esc</Key>
            {" to close"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Key({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line px-1 font-mono">{children}</kbd>;
}

/**
 * One labelled block of the body: a heading in small caps over its content.
 *
 * The three panels lay out the same way on purpose — where you were reading on
 * one tab is where you read on the next — so the box is shared rather than
 * reimplemented with slightly different spacing each time.
 */
export function Box({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-3.5", className)}>
      <h3 className="mb-1.5 font-display text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink/52">
        {label}
      </h3>
      {children}
    </section>
  );
}

/**
 * Raw source, behind a toggle that starts closed.
 *
 * The analysis is three sentences; the evidence under it is quoted passages,
 * whole table rows and sometimes a rendered diagram. Shown by default, the
 * evidence pushed the gap and the fix off the first screen, so a reviewer
 * scrolled past the document to reach the finding about it — the clutter this
 * exists to remove.
 *
 * `openFor` is keyed to the item rather than held as a boolean, which is what
 * makes the reset free: when navigation changes the id, the next item renders
 * collapsed on the same frame. A boolean plus an effect would show the previous
 * item's expanded state for a frame first, which reads as a flicker and is the
 * usual way this pattern goes wrong. The same keying is used by the compliance
 * dialog; this is that implementation, shared rather than copied a third time.
 *
 * The open/close itself is a grid-rows transition, so the panel animates to its
 * own height without anyone measuring it, and `motion-reduce` turns it off for
 * a reader who has asked for that.
 */
export function Disclosure({
  id,
  itemId,
  openFor,
  setOpenFor,
  label,
  children,
}: {
  /** Ties the button to the region it controls, for a screen reader. */
  id: string;
  /** The item this evidence belongs to; opening is remembered against it. */
  itemId: string;
  openFor: string | null;
  setOpenFor: (next: string | null) => void;
  /** What is inside, counted: "2 excerpts", "this table". */
  label: string;
  children: ReactNode;
}) {
  const open = openFor === itemId;

  return (
    <section className="mb-3.5 overflow-hidden rounded-xl border border-line bg-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpenFor(open ? null : itemId)}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left text-[13px] font-medium text-ink/78 transition-colors hover:bg-canvas-sunk focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-royal-mid"
      >
        <span>{open ? "[-] Hide Source Evidence" : `[+] View Source Evidence (${label})`}</span>
        <ChevronDown
          size={15}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-ink/52 transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>

      <div
        id={id}
        aria-hidden={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {open && <div className="border-t border-line p-3.5">{children}</div>}
        </div>
      </div>
    </section>
  );
}

/**
 * The row of actions at the end of an item.
 *
 * Inside the scroll area rather than pinned, so a long item scrolls its
 * controls into view instead of hiding text behind them. `pb-6` on the
 * scroller keeps them clear of the keyboard-hint bar.
 */
export function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
      {children}
    </div>
  );
}
