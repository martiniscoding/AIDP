"use client";

import { useEffect, useRef } from "react";
import { animate, useInView } from "framer-motion";
import { useReducedMotion } from "@/lib/useReducedMotion";

/**
 * Counts from 0 to `value` the first time it scrolls into view.
 * Writes straight to textContent — no per-frame React render.
 */
export function CountUp({
  value,
  duration = 1.4,
  delay = 0,
  className,
}: {
  value: number;
  duration?: number;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -15% 0px" });
  const reduced = useReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (reduced) {
      node.textContent = String(value);
      return;
    }
    if (!inView) {
      // Zero out on mount so the count actually has somewhere to travel
      // from. SSR still emits the final value for no-JS readers.
      node.textContent = "0";
      return;
    }

    const controls = animate(0, value, {
      duration,
      delay,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => {
        node.textContent = String(Math.round(latest));
      },
    });

    return () => controls.stop();
  }, [inView, value, duration, delay, reduced]);

  return (
    <span ref={ref} className={className}>
      {/* Server-rendered fallback keeps the final value in the DOM for
          no-JS readers and avoids a layout jump on hydration. */}
      {value}
    </span>
  );
}
