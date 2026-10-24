"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FilePlus2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { newRequest } from "../actions";

/**
 * Opening a request: the project it belongs to, and what to call it.
 *
 * Only two answers, and deliberately. Everything else is asked in the wizard,
 * which can only save into a row that exists — so this is the smallest thing
 * that creates one, and the reference is issued here.
 *
 * The project is chosen rather than created from the title. A project holds
 * several requests, and `Project` carries a unique name per organisation: two
 * requests called "Portal Upgrade" would collide on the second.
 *
 * ## Why this is a modal and not the inline form it was
 *
 * It used to replace the trigger in place, which put the form wherever the
 * trigger happened to sit — the far right of the page header, at the width the
 * header's action slot allowed. Filing a request is the primary thing this
 * screen is for, and it was being asked for in the corner, in a panel narrower
 * than the empty-state card below it.
 *
 * So it opens over the page, centred, at a width the two fields can breathe in,
 * and it borrows the shell `ReviewDialog` established: the same backdrop, the
 * same z-layer, Escape and the backdrop to dismiss, the scroll lock, the focus
 * trap, and focus handed back to the trigger on the way out. It is not
 * `ReviewDialog` itself because that shell is built around stepping through a
 * queue — it requires a position and a navigator, and there is one of these.
 *
 * The trigger stays mounted while the modal is up. Unmounting it reflowed the
 * header the moment the form opened, and left nothing to return focus to.
 */
export function NewRequest({ projects }: { projects: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  /**
   * Refused while the submission is in flight.
   *
   * The server action is already creating a row and the navigation that follows
   * is the confirmation. Dismissing here would leave the requestor on the list
   * with no sign that a draft now exists, and a second press would open a
   * second one.
   */
  const close = useCallback(() => {
    if (pending) return;
    setOpen(false);
    setError(null);
  }, [pending]);

  // A modal owns keyboard focus until it closes, then returns it to the control
  // that opened it — the trigger, which is still mounted precisely so it can be
  // focused again.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key !== "Tab") return;

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
    };

    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, close]);

  if (projects.length === 0) return null;

  /** Field chrome at the size `Field` and `Select` use, so the two questions
   *  asked here look like the ones asked everywhere else. */
  const field = cn(
    "h-12 w-full rounded-xl border border-line bg-canvas-sunk/60 px-3.5 text-[15px] text-ink",
    "placeholder:text-ink/58",
    "transition-[border-color,box-shadow,background-color] duration-200",
    "hover:border-line-strong focus:bg-card focus:outline-none",
    "focus:border-royal focus:shadow-[0_0_0_3px_rgba(0,70,113,0.15)]",
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-2 rounded-full bg-royal px-5 py-2.5",
          "text-[14px] font-medium text-white shadow-card cursor-pointer",
          "transition-[transform,box-shadow] duration-300",
          "hover:-translate-y-0.5 hover:shadow-card-hover",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
        )}
      >
        <FilePlus2 size={15} aria-hidden="true" />
        New request
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center"
          style={{
            paddingTop: "env(safe-area-inset-top, 0px)",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-request-title"
        >
          {/* A button, so a pointer and the keyboard both dismiss it. */}
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="absolute inset-0 cursor-default bg-ink/45 backdrop-blur-[2px]"
          />

          <div
            ref={panel}
            tabIndex={-1}
            className={cn(
              "relative flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden",
              "rounded-t-2xl border border-line bg-canvas shadow-card-hover",
              "focus-visible:outline-none sm:max-h-[88vh] sm:rounded-2xl",
            )}
          >
            <div className="flex items-start gap-3 border-b border-line bg-card px-5 py-4">
              <div className="min-w-0 flex-1">
                <h2
                  id="new-request-title"
                  className="font-display text-[17px] font-semibold leading-snug tracking-[-0.015em] text-ink"
                >
                  Open an architecture request
                </h2>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink/62">
                  Two answers now. The intake questions come next, and it saves as you
                  go.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="-mr-1 shrink-0 rounded-lg p-1.5 text-ink/58 transition-colors hover:bg-canvas-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
              >
                <X size={17} />
              </button>
            </div>

            <form
              action={(formData) =>
                startTransition(async () => {
                  const result = await newRequest(formData);
                  if (result.ok && result.id) {
                    router.push(`/dashboard/requests/${result.id}`);
                  } else {
                    setError(result.message);
                  }
                })
              }
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 pb-5 pt-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium text-ink/78">Project</span>
                  <div className="relative">
                    <select
                      name="projectId"
                      required
                      className={cn(field, "cursor-pointer appearance-none pr-10")}
                    >
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={16}
                      aria-hidden="true"
                      className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink/55"
                    />
                  </div>
                  <span className="text-[12.5px] text-ink/64">
                    The piece of work this belongs to. A project holds several requests.
                  </span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium text-ink/78">
                    Request title
                  </span>
                  <input
                    name="title"
                    required
                    autoFocus
                    maxLength={200}
                    placeholder="Customer Portal Upgrade"
                    className={field}
                  />
                  <span className="text-[12.5px] text-ink/64">
                    What a reviewer will recognise it by, alongside its reference.
                  </span>
                </label>

                {error && (
                  <p
                    role="status"
                    className="rounded-xl border border-warn-line bg-warn-tint px-3.5 py-2.5 text-[12.5px] text-ink/80"
                  >
                    {error}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-line bg-card px-5 py-3.5">
                <button
                  type="button"
                  onClick={close}
                  disabled={pending}
                  className="rounded-full px-4 py-2 text-[13.5px] text-ink/70 transition-colors hover:text-ink cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-full bg-royal px-5 py-2 text-[13.5px] font-medium text-white cursor-pointer transition-opacity disabled:opacity-50"
                >
                  {pending ? "Opening…" : "Open it"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
