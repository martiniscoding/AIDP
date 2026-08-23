"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  motion,
  useMotionValue,
  useMotionValueEvent,
  useScroll,
  useSpring,
} from "framer-motion";
import { useReducedMotion } from "@/lib/useReducedMotion";

/**
 * ScrollPath
 * ----------
 * A single continuous line that threads down the page and connects every
 * major section, with a glowing "playhead" node riding it at the current
 * scroll position.
 *
 * How it stays aligned with the content:
 *
 *  1. Any descendant marked `data-path-anchor` is a point the line must pass
 *     through. We measure those elements' real centres in pixels, so the path
 *     follows the actual responsive layout instead of a hand-authored viewBox.
 *  2. Consecutive anchors are joined with cubic béziers whose control points
 *     are offset only vertically. That produces smooth S-curves and, because
 *     all four y-values of every segment are non-decreasing, guarantees the
 *     line never doubles back upward.
 *  3. On mount (and on resize) the rendered <path> is sampled into a lookup
 *     table of {t, x, y}. Mapping a scroll position to a point then means a
 *     binary search by y — which keeps the node exactly level with the section
 *     it belongs to, rather than drifting because arc length ≠ vertical
 *     distance on the curved stretches.
 *  4. Scroll progress drives the node position and the stroke dash offset from
 *     the *same* lookup, so the drawn end of the line and the node are always
 *     the same point.
 */

const SAMPLE_COUNT = 600;
/** How close (px) the node must be to an anchor to light that section up. */
const ACTIVE_RADIUS = 150;
/**
 * Distance (px) over which the stroke ramps up from nothing at the origin.
 * The origin sits directly under the hero's CTAs, so the first stretch of the
 * line runs behind the proof line and the pillar chips; at full strength a 2px
 * white stroke cuts straight through them. Fading in over roughly the height
 * of that block reads as the line emerging from the origin node instead.
 */
const ORIGIN_FADE = 190;

type Sample = { t: number; x: number; y: number };
type Anchor = { y: number; step: HTMLElement | null };

const clamp = (v: number, min: number, max: number) =>
  v < min ? min : v > max ? max : v;

function buildPath(points: Array<{ x: number; y: number }>) {
  if (points.length < 2) return "";
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    // Vertical-only control handles: smooth weave, monotonic descent.
    const dy = (b.y - a.y) * 0.5;
    d +=
      ` C ${a.x.toFixed(1)} ${(a.y + dy).toFixed(1)}` +
      ` ${b.x.toFixed(1)} ${(b.y - dy).toFixed(1)}` +
      ` ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  }
  return d;
}

export function ScrollPath({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  const [d, setD] = useState("");
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** Container-relative y where the line begins; see `data-path-origin`. */
  const [startY, setStartY] = useState(0);
  /**
   * How far the container is pulled up into the preceding section so the line
   * can start beside that section's copy. Derived, not configured: the hero
   * centres its content, so the slack beneath it grows with viewport height
   * and no fixed value works everywhere.
   */
  const [lead, setLead] = useState(0);
  const leadRef = useRef(0);

  const samplesRef = useRef<Sample[]>([]);
  const anchorsRef = useRef<Anchor[]>([]);
  const heightRef = useRef(0);
  const activeRef = useRef<HTMLElement | null>(null);
  /** Last y actually painted, so settling frames that move nothing can be
   *  dropped. NaN forces the next call through. */
  const paintedYRef = useRef(Number.NaN);

  const reduced = useReducedMotion();

  const nodeX = useMotionValue(0);
  const nodeY = useMotionValue(0);
  const dashOffset = useMotionValue(1);
  const proximity = useMotionValue(0);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start center", "end center"],
  });

  // A gentle spring gives the node the soft lag that makes it feel physical
  // rather than glued to the scrollbar.
  const springed = useSpring(scrollYProgress, {
    stiffness: 95,
    damping: 26,
    mass: 0.35,
  });
  const progress = reduced ? scrollYProgress : springed;

  /** Binary-search the sample table for the point at a given container y. */
  const pointAtY = useCallback((y: number): Sample | null => {
    const s = samplesRef.current;
    if (s.length === 0) return null;
    if (y <= s[0].y) return s[0];
    if (y >= s[s.length - 1].y) return s[s.length - 1];

    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].y < y) lo = mid;
      else hi = mid;
    }
    const a = s[lo];
    const b = s[hi];
    const span = b.y - a.y;
    const f = span === 0 ? 0 : (y - a.y) / span;
    return { t: a.t + (b.t - a.t) * f, x: a.x + (b.x - a.x) * f, y };
  }, []);

  const render = useCallback(() => {
    const height = heightRef.current;
    if (!height || samplesRef.current.length === 0) return;

    const y = clamp(progress.get(), 0, 1) * height;
    // The spring settles asymptotically, so the tail of every scroll is a run
    // of frames that move the node by a fraction of a pixel. Each one still
    // costs a repaint of a page-tall stroke, and none of them can change a
    // pixel. NaN on the first call and after every re-measure, so this never
    // swallows the initial placement.
    if (Math.abs(y - paintedYRef.current) < 0.25) return;
    paintedYRef.current = y;

    const hit = pointAtY(y);
    if (!hit) return;

    nodeX.set(hit.x);
    nodeY.set(hit.y);
    dashOffset.set(reduced ? 0 : clamp(1 - hit.t, 0, 1));

    // Light up whichever step the node is currently passing.
    let nearest: Anchor | null = null;
    let nearestDist = Infinity;
    for (const anchor of anchorsRef.current) {
      const dist = Math.abs(anchor.y - hit.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = anchor;
      }
    }
    proximity.set(1 - clamp(nearestDist / ACTIVE_RADIUS, 0, 1));

    const nextActive =
      nearest && nearestDist < ACTIVE_RADIUS ? nearest.step : null;
    if (nextActive !== activeRef.current) {
      activeRef.current?.removeAttribute("data-path-active");
      nextActive?.setAttribute("data-path-active", "");
      activeRef.current = nextActive;
    }
  }, [dashOffset, nodeX, nodeY, pointAtY, progress, proximity, reduced]);

  useMotionValueEvent(progress, "change", render);

  /** Re-derive the path from the live layout. */
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width === 0 || height === 0) return;

    const centre = width / 2;
    // Narrow viewports get a nearly straight line — a full weave would clip
    // off-screen and fight the single-column layout.
    const maxAmplitude =
      width < 768 ? width * 0.1 : Math.min(width * 0.34, 430);

    const elements = Array.from(
      container.querySelectorAll<HTMLElement>("[data-path-anchor]"),
    );

    const anchors: Anchor[] = [];

    // The preceding section nominates where the line begins by marking an
    // element `data-path-origin`. We pull the container up until its top edge
    // reaches that marker, so the origin sits the same distance below the hero
    // copy at every viewport height.
    const originEl = document.querySelector<HTMLElement>("[data-path-origin]");

    if (originEl) {
      const markerTop = originEl.getBoundingClientRect().top;
      // Where the container would sit with no lead at all. Computing the
      // requirement against that fixed reference makes this converge in one
      // step instead of oscillating.
      const naturalTop = rect.top + leadRef.current;
      const required = Math.max(0, Math.round(naturalTop - markerTop));

      if (required !== leadRef.current) {
        leadRef.current = required;
        setLead(required);
        // Changing the lead changes the container's height, so the
        // ResizeObserver re-runs this with the corrected geometry.
        return;
      }
    }

    const originY = originEl
      ? clamp(
          originEl.getBoundingClientRect().top - rect.top,
          0,
          Math.max(0, height - 1),
        )
      : 0;

    const points: Array<{ x: number; y: number }> = [
      { x: centre, y: originY },
    ];
    setStartY(originY);

    for (const el of elements) {
      const r = el.getBoundingClientRect();
      const y = r.top - rect.top + r.height / 2;
      const rawX = r.left - rect.left + r.width / 2;
      const x = centre + clamp(rawX - centre, -maxAmplitude, maxAmplitude);

      // Skip anchors that would sit on top of the previous one — the bézier
      // needs strictly increasing y to stay monotonic.
      const prev = points[points.length - 1];
      if (y - prev.y < 8) continue;

      points.push({ x, y });
      anchors.push({ y, step: el.closest<HTMLElement>("[data-path-step]") });
    }

    anchorsRef.current = anchors;
    heightRef.current = height;
    setSize((prev) =>
      prev.w === width && prev.h === height ? prev : { w: width, h: height },
    );
    setD(buildPath(points));
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    schedule();

    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    window.addEventListener("resize", schedule);
    // Late-loading webfonts reflow the copy and move every anchor.
    document.fonts?.ready.then(schedule).catch(() => {});

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [measure]);

  // Sample the path once the browser has laid out the new `d`.
  useEffect(() => {
    const path = pathRef.current;
    if (!path || !d) return;

    const total = path.getTotalLength();
    if (!total) return;

    const samples: Sample[] = new Array(SAMPLE_COUNT + 1);
    for (let i = 0; i <= SAMPLE_COUNT; i += 1) {
      const t = i / SAMPLE_COUNT;
      const pt = path.getPointAtLength(t * total);
      samples[i] = { t, x: pt.x, y: pt.y };
    }
    samplesRef.current = samples;
    paintedYRef.current = Number.NaN;
    render();
  }, [d, render]);

  const ready = d !== "" && size.w > 0;

  return (
    <div
      ref={containerRef}
      className="relative"
      style={lead ? { marginTop: -lead } : undefined}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 h-full w-full transition-opacity duration-1000"
        style={{ opacity: ready ? 1 : 0 }}
        viewBox={`0 0 ${size.w || 1} ${size.h || 1}`}
        fill="none"
      >
        <defs>
          {/* Radial gradients standing in for what used to be a Gaussian blur.
              WebKit rasterises every SVG filter into an image buffer of its own
              on every paint, and these nodes repaint on every scroll frame — on
              a Retina display that is four times the pixels of a 1x Windows
              screen, which is why this only ever stuttered on a Mac. A gradient
              fill is drawn straight into the destination, and on a soft round
              glow the two are indistinguishable. */}
          <radialGradient id="node-halo">
            <stop offset="0" stopColor="#8b5cf6" stopOpacity={1} />
            <stop offset="0.4" stopColor="#8b5cf6" stopOpacity={0.72} />
            <stop offset="0.72" stopColor="#8b5cf6" stopOpacity={0.24} />
            <stop offset="1" stopColor="#8b5cf6" stopOpacity={0} />
          </radialGradient>
          <radialGradient id="node-core-glow">
            <stop offset="0" stopColor="#7c3aed" stopOpacity={0.78} />
            <stop offset="0.42" stopColor="#7c3aed" stopOpacity={0.42} />
            <stop offset="1" stopColor="#7c3aed" stopOpacity={0} />
          </radialGradient>
          <radialGradient id="origin-glow">
            <stop offset="0" stopColor="#ffffff" stopOpacity={0.8} />
            <stop offset="0.38" stopColor="#ffffff" stopOpacity={0.42} />
            <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
          </radialGradient>

          {/* The origin fade, carried by the stroke paint rather than a mask.
              A <mask> is applied by drawing everything under it into a
              transparency buffer the size of the mask region — here the full
              height of the page — and the lit stroke inside it changes on every
              scroll frame, so that buffer was being allocated and composited
              sixty times a second. A gradient reaches the same picture with no
              buffer at all, because every stroke beneath it is one flat colour
              and fading the paint is the same as fading the shape. */}
          <linearGradient
            id="path-rail-fade"
            gradientUnits="userSpaceOnUse"
            x1={0}
            y1={startY}
            x2={0}
            y2={startY + ORIGIN_FADE}
          >
            <stop offset="0" stopColor="#1a1430" stopOpacity={0} />
            <stop offset="1" stopColor="#1a1430" stopOpacity={0.09} />
          </linearGradient>
          <linearGradient
            id="path-lit-fade"
            gradientUnits="userSpaceOnUse"
            x1={0}
            y1={startY}
            x2={0}
            y2={startY + ORIGIN_FADE}
          >
            <stop offset="0" stopColor="#6d28d9" stopOpacity={0} />
            <stop offset="1" stopColor="#6d28d9" stopOpacity={1} />
          </linearGradient>
        </defs>

        {/* Unlit rail — shows where the line is headed.
            Also the geometry we sample: no `pathLength` here, so
            getTotalLength()/getPointAtLength() operate on real user units. */}
        <path
          ref={pathRef}
          d={d}
          stroke="url(#path-rail-fade)"
          strokeWidth={1.5}
          strokeLinecap="round"
        />

        {/* Lit portion, in the accent — this line runs almost entirely over
            the light body, where white was invisible. The halo is three
            stacked strokes rather than a Gaussian blur: a filter region
            spanning the full page height is expensive to rasterise, and
            layered strokes are indistinguishable on a 2px line.
            `strokeOpacity` rather than `opacity`, for the same reason the mask
            went: opacity on an element is a transparency layer, opacity on the
            paint is just a colour. */}
        {[
          { width: 10, opacity: 0.09 },
          { width: 5, opacity: 0.2 },
          { width: 2, opacity: 1 },
        ].map((layer) => (
          <motion.path
            key={layer.width}
            d={d}
            pathLength={1}
            stroke="url(#path-lit-fade)"
            strokeWidth={layer.width}
            strokeLinecap="round"
            strokeDasharray={1}
            strokeOpacity={layer.opacity}
            style={{ strokeDashoffset: dashOffset }}
          />
        ))}

        {/* Origin node, sitting just below the hero copy */}
        <circle cx={size.w / 2} cy={startY} r={22} fill="url(#origin-glow)" />
        <circle cx={size.w / 2} cy={startY} r={2.5} fill="#ffffff" />

        {/* The playhead — violet core against the light body, with a lighter
            proximity halo, so passing a step reads as an event rather than
            just a brighter dot. */}
        <motion.circle
          cx={nodeX}
          cy={nodeY}
          r={34}
          fill="url(#node-halo)"
          style={{ opacity: reduced ? 0.7 : proximity }}
        />
        <motion.circle cx={nodeX} cy={nodeY} r={25} fill="url(#node-core-glow)" />
        <motion.circle
          cx={nodeX}
          cy={nodeY}
          r={4.5}
          fill="#6d28d9"
          animate={reduced ? { opacity: 1 } : { opacity: [0.8, 1, 0.8] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.circle cx={nodeX} cy={nodeY} r={2} fill="#4c1d95" />
      </svg>

      <div
        className="relative z-10"
        style={lead ? { paddingTop: lead } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
