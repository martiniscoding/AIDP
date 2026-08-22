"use client";

import { useLinkStatus } from "next/link";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";

/**
 * Acknowledges a click on a `<Link>` while the router is still fetching the
 * destination.
 *
 * Next only skips the pending phase when the route was already prefetched. In
 * development it never is — prefetching is a production behaviour and the route
 * is compiled on demand — so without this the button looks inert for as long as
 * the compile takes, which is exactly the "nothing happens, then it jumps"
 * feeling. In production it covers the same gap when a click lands before the
 * viewport prefetch has finished, e.g. on a slow connection.
 *
 * Must be rendered *inside* the `<Link>` it reports on: `useLinkStatus` reads
 * the nearest Link above it and returns `{ pending: false }` anywhere else.
 *
 * The overlay is fixed-size and absolutely positioned, so it can never shift
 * the button's own layout, and `.link-pending` holds it invisible for the first
 * 120ms — a navigation that resolves quickly shows nothing at all rather than
 * flashing a spinner.
 */
export function LinkPending({
  className,
  spinnerClassName,
}: {
  className?: string;
  spinnerClassName?: string;
}) {
  const { pending } = useLinkStatus();

  if (!pending) return null;

  return (
    <span
      className={cn(
        "link-pending absolute inset-0 z-10 grid place-items-center rounded-[inherit] bg-canvas/70 backdrop-blur-[1px]",
        className,
      )}
    >
      <Spinner className={cn("size-4", spinnerClassName)} />
    </span>
  );
}
