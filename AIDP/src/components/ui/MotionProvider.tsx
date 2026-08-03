"use client";

import { MotionConfig } from "framer-motion";

/**
 * `reducedMotion="user"` makes Framer skip transform-based animation (movement,
 * scale, rotation) for anyone who has asked their OS for reduced motion,
 * without every decorative loop in the app having to check for itself.
 *
 * Framer applies this internally, so values are never left stranded — unlike
 * conditionally removing an `animate` prop, which strands whatever the last
 * frame wrote. Components that need to go further (Reveal, Hero, ScrollPath)
 * still opt out explicitly.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
