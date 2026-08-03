"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the page while any document is still moving through the pipeline.
 *
 * Polling rather than a socket: the interesting window is a minute or two after
 * an upload, the payload is a handful of rows, and a persistent connection to
 * Neon per open tab would keep the compute awake for no benefit. When nothing
 * is in flight this component renders nothing and schedules nothing.
 */
export function PipelineWatcher({
  active,
  intervalMs = 4000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;

    // Pause while the tab is hidden — a backgrounded tab polling for hours is
    // the kind of thing that shows up on a Neon bill and nowhere else.
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, intervalMs, router]);

  return null;
}
