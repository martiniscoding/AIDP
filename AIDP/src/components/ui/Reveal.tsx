"use client";

import { motion } from "framer-motion";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { cn } from "@/lib/cn";

type Props = {
  children: React.ReactNode;
  className?: string;
  /** Stagger offset in seconds. */
  delay?: number;
  /** Distance travelled, px. */
  y?: number;
  /**
   * Horizontal travel. A percentage string ("-40%") is relative to the
   * element's own width, so a card slides in from beyond its own edge at every
   * breakpoint without a JS media query — which `initial` could not react to
   * anyway, since Framer only reads it on mount.
   */
  x?: number | string;
  /** Seconds. Longer travel needs longer to land without looking flung. */
  duration?: number;
  as?: "div" | "section" | "li" | "span" | "p" | "h2";
};

/**
 * Fade + rise on first scroll into view. `once` so sections don't re-animate on
 * the way back up, which reads as jitter.
 *
 * Reduced motion is handled by collapsing the transition to zero duration and
 * dropping the travel — deliberately NOT by rendering a different element.
 * Because `useReducedMotion` only reports the true value after mount (it has to,
 * to hydrate cleanly), a structural branch would let Framer write `opacity: 0`
 * on the first render and then remove the props that would ever animate it
 * back, leaving the content permanently invisible.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 22,
  x = 0,
  duration = 0.7,
  as = "div",
}: Props) {
  const reduced = useReducedMotion();
  const Tag = motion[as];

  return (
    <Tag
      className={cn(className)}
      initial={{ opacity: 0, y: reduced ? 0 : y, x: reduced ? 0 : x }}
      whileInView={{ opacity: 1, y: 0, x: 0 }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={
        reduced
          ? { duration: 0 }
          : { duration, delay, ease: [0.16, 1, 0.3, 1] }
      }
    >
      {children}
    </Tag>
  );
}
