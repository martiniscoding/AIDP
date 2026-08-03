"use client";

import { useEffect, useLayoutEffect, useState } from "react";

// useLayoutEffect warns when it runs during SSR; on the client we want the
// pre-paint timing so the reduced-motion value settles before the first frame.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * `prefers-reduced-motion`, hydration-safe.
 *
 * Framer Motion's own `useReducedMotion` reads the media query synchronously on
 * the client but has nothing to read on the server, so any component that
 * branches on it during render emits a different tree on each side and trips a
 * hydration mismatch. This starts at `false` — matching what the server
 * rendered — and corrects itself in a layout effect, before paint.
 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);

    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return reduced;
}
