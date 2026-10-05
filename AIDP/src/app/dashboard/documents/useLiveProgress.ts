"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { RunProgressView } from "@/lib/ingest/run-progress";

export type ProgressSeed = { id: string } & RunProgressView;

const isLive = (state: string) => state === "queued" || state === "running";

/**
 * A live run's progress, kept current without re-rendering the page.
 *
 * The banner used to move only because `PipelineWatcher` called
 * `router.refresh()` every four seconds. That re-ran the whole report — every
 * finding, every count, the decision history — to carry one number, and a render
 * slower than the interval meant refreshes overlapped and were coalesced: the
 * count stuck on its first clause and only a reload would show where the run had
 * got to. Polling a few hundred bytes instead cannot be outrun, and the page is
 * refreshed exactly once, when the run finishes and there is a report to show.
 *
 * The server's render still wins whenever it is the later reading, so this is an
 * accelerator rather than a second source of truth.
 */
export function useLiveProgress(seed: ProgressSeed, intervalMs = 2500): RunProgressView {
  const router = useRouter();
  // Tagged with the run it was read from, so a reading of the previous run is
  // discarded on sight rather than being cleared from an effect a render later.
  const [polled, setPolled] = useState<{ runId: string; view: RunProgressView } | null>(null);
  const runId = seed.id;
  const live = isLive(seed.state);
  const wasOrphaned = seed.orphaned;
  const reading = polled && polled.runId === runId ? polled.view : null;

  useEffect(() => {
    if (!live) return;

    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const stop = () => {
      stopped = true;
      clear();
    };
    const schedule = () => {
      if (!stopped && timer === null) timer = setTimeout(tick, intervalMs);
    };

    async function tick() {
      timer = null;
      try {
        const response = await fetch(`/api/runs/${runId}/progress`, {
          signal: abort.signal,
          cache: "no-store",
        });
        // Gone, or no longer ours to read. Nothing a retry would fix.
        if (!response.ok) return stop();

        const next = (await response.json()) as RunProgressView;
        if (stopped) return;
        setPolled({ runId, view: next });
        if (!isLive(next.state) || next.orphaned !== wasOrphaned) {
          // Either the run finished — the findings, the coverage, the advice and
          // the decision panel all appear together and only the server can
          // render them — or it lost the job behind it, which the page answers
          // with the offer to start another. Both are the server's to draw, and
          // both end the polling: this is the one refresh the page needs.
          stop();
          router.refresh();
          return;
        }
      } catch {
        // A poll that failed is not worth saying anything about: the next one is
        // seconds away and the banner keeps the last reading it had. An aborted
        // one means the component is gone.
        if (abort.signal.aborted) return;
      }
      schedule();
    }

    // Paused while the tab is hidden — a backgrounded tab polling for hours is
    // the kind of thing that shows up on a bill and nowhere else — and read once
    // on coming back, so the count is current the moment it is looked at again.
    const onVisibility = () => {
      clear();
      if (!document.hidden && !stopped) void tick();
    };

    if (!document.hidden) schedule();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      abort.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [runId, live, wasOrphaned, intervalMs, router]);

  // Whichever reading reports more clauses is the later one — progress within a
  // run only moves forward, which is what makes the comparison sound. A run the
  // server calls finished is final either way: a poll still mid-flight from a
  // moment earlier must not drag the banner back to "assessing".
  if (!reading || !live) return seed;
  return reading.completedClauses >= seed.completedClauses ? reading : seed;
}
