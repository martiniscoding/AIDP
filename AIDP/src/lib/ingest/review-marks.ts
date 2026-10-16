"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * What one reviewer has done with a suggestion or a design gap, in their own
 * browser.
 *
 * Compliance findings carry their decision on the `finding` row, where it is
 * shared, audited and survives a re-run. Suggestions and coverage gaps have no
 * such row: both are JSON blobs on `assessment_run`, written whole by the
 * worker and replaced whole on the next run. There is nowhere to record "this
 * one is accepted" without a schema change.
 *
 * So these marks live in `localStorage`, and the UI says so rather than
 * implying a shared backlog. That is a real limitation and the honest way to
 * ship it: a reviewer working down thirty suggestions needs to see which ones
 * they have already dealt with, and the alternative — a button that reports
 * success and loses the decision when the tab closes — is worse than one that
 * tells the truth about its scope.
 *
 * Keyed by run so a re-assessment starts clean: last week's dismissals should
 * not silently hide this week's suggestions, which may be about different
 * passages entirely.
 *
 * Every read and write is wrapped: storage throws in a private window, comes
 * back empty with site data cleared, and is unavailable during thumbnail
 * capture. The page has to render correctly with none of it.
 */

export type Mark = "accepted" | "dismissed";

export type Marks = Record<string, Mark>;

function keyFor(runId: string, kind: "advice" | "coverage"): string {
  return `aidp:${kind}:${runId}`;
}

function read(storageKey: string): Marks {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Anything not one of the two values is dropped rather than trusted: this
    // is browser storage, and another tab or an older build may have written
    // a shape this version does not know.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, value]) => value === "accepted" || value === "dismissed",
      ),
    ) as Marks;
  } catch {
    return {};
  }
}

/**
 * The marks for one run's suggestions or gaps, and a way to set one.
 *
 * Returns an empty map on the first render even where storage has something,
 * because the server render has no storage to read: the panel has to be
 * correct before the effect lands, and a mark appearing a frame later is
 * better than a hydration mismatch.
 */
export function useReviewMarks(runId: string, kind: "advice" | "coverage") {
  const storageKey = keyFor(runId, kind);
  const [snapshot, setSnapshot] = useState<{
    storageKey: string | null;
    marks: Marks;
  }>({ storageKey: null, marks: {} });

  useEffect(() => {
    // Keep storage out of the render path so the server and the first client
    // render match. Defer the browser read, and don't overwrite a mark made
    // before the frame runs.
    const frame = requestAnimationFrame(() => {
      setSnapshot((current) =>
        current.storageKey === storageKey
          ? current
          : { storageKey, marks: read(storageKey) },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [storageKey]);

  // If the component is reused for another run, never flash the prior run's
  // marks while the new run's local storage is being read.
  const marks = snapshot.storageKey === storageKey ? snapshot.marks : {};

  const mark = useCallback(
    (id: string, value: Mark | null) => {
      const previous =
        snapshot.storageKey === storageKey ? snapshot.marks : read(storageKey);
      const next = { ...previous };
      if (value === null) delete next[id];
      else next[id] = value;
      setSnapshot({ storageKey, marks: next });
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Private window, blocked storage, or a full quota. The mark still
        // applies for this session; it simply will not outlive the tab.
      }
    },
    [snapshot, storageKey],
  );

  return { marks, mark };
}

/**
 * A stable id for an item that has none of its own.
 *
 * Suggestions and gaps are positions in a JSON array, so an index would move
 * the moment the array is re-ordered or re-generated and carry somebody's
 * decision onto a different item. Built from the content instead: the same
 * suggestion about the same passage keeps its mark across a page load, and a
 * different one does not inherit it.
 */
export function itemKey(parts: (string | number | null | undefined)[]): string {
  return parts
    .map((part) => (part === null || part === undefined ? "" : String(part)))
    .join("|")
    .slice(0, 400);
}
