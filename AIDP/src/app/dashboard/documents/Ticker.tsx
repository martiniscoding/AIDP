"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/ingest/pipeline";

/**
 * A duration that keeps moving between refreshes.
 *
 * The page re-renders from the server every few seconds with a fresh value; in
 * between, this counts from the moment it mounted, so the clock does not stand
 * still and then jump. The server's clock is the one trusted — the browser's
 * only measures how long ago that value was sent.
 */
export function Ticker({ ms, direction = "up" }: { ms: number; direction?: "up" | "down" }) {
  // Keyed on the value, so a fresh one from the server starts the count again.
  return <Count key={`${direction}:${ms}`} ms={ms} direction={direction} />;
}

function Count({ ms, direction }: { ms: number; direction: "up" | "down" }) {
  const [moved, setMoved] = useState(0);

  useEffect(() => {
    const mounted = Date.now();
    const timer = window.setInterval(() => setMoved(Date.now() - mounted), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const value = direction === "up" ? ms + moved : Math.max(0, ms - moved);
  return <span className="tabular-nums">{formatDuration(value)}</span>;
}
