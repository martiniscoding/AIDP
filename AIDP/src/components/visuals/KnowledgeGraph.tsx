"use client";

import { motion } from "framer-motion";
import { useReducedMotion } from "@/lib/useReducedMotion";

const SOURCES = [
  { label: "Principles", y: 30 },
  { label: "Standards", y: 96 },
  { label: "Past ADRs", y: 162 },
];

/** Graph nodes, positioned around the hub at (250, 96). */
const NODES = [
  { x: 320, y: 34, r: 5 },
  { x: 372, y: 74, r: 3.5 },
  { x: 344, y: 128, r: 4.5 },
  { x: 300, y: 164, r: 3.5 },
  { x: 386, y: 148, r: 3 },
  { x: 306, y: 96, r: 6 },
  { x: 388, y: 108, r: 3.5 },
];

const EDGES: Array<[number, number]> = [
  [5, 0],
  [5, 2],
  [5, 3],
  [0, 1],
  [1, 6],
  [2, 4],
  [2, 6],
];

export function KnowledgeGraph() {
  const reduced = useReducedMotion();

  return (
    <svg
      viewBox="0 0 420 200"
      fill="none"
      role="img"
      aria-label="Principles, standards, and past architecture decision records flowing into a versioned knowledge graph that every assessment retrieves from."
      className="h-full w-full"
    >
      <defs>
        {/* Same split as the step diagrams: white does the work, purple marks
            the one focal element — here the chunk-and-embed hub. */}
        <linearGradient id="kb-g" x1="0" y1="200" x2="420" y2="0">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id="kb-p" x1="0" y1="200" x2="420" y2="0">
          <stop offset="0%" stopColor="#7c3aed" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
        <radialGradient id="kb-hub">
          <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Source documents */}
      {SOURCES.map((source, i) => (
        <g key={source.label}>
          <rect
            x="8"
            y={source.y - 18}
            width="108"
            height="36"
            rx="9"
            stroke="rgba(255,255,255,0.16)"
            strokeWidth="1.25"
            fill="rgba(255,255,255,0.025)"
          />
          <text
            x="26"
            y={source.y + 4}
            className="fill-white/55"
            style={{ fontSize: 11, letterSpacing: "0.01em" }}
          >
            {source.label}
          </text>
          <circle cx="18" cy={source.y} r="2.5" fill="url(#kb-g)" />

          {/* Feed line into the hub */}
          <path
            d={`M116 ${source.y} C 168 ${source.y}, 176 96, 226 96`}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="1.25"
          />
          {/* Ingest pulse. SMIL rather than Framer here — motion along an
              arbitrary SVG path is what animateMotion is for, and it runs off
              the main thread. Omitted entirely when motion is reduced. */}
          {!reduced ? (
            <circle r="2.6" fill="url(#kb-g)">
              <animateMotion
                dur="3.2s"
                begin={`${i * 0.9}s`}
                repeatCount="indefinite"
                path={`M116 ${source.y} C 168 ${source.y}, 176 96, 226 96`}
              />
              <animate
                attributeName="opacity"
                values="0;1;1;0"
                keyTimes="0;0.15;0.8;1"
                dur="3.2s"
                begin={`${i * 0.9}s`}
                repeatCount="indefinite"
              />
            </circle>
          ) : null}
        </g>
      ))}

      {/* Chunk + embed hub */}
      <circle cx="250" cy="96" r="34" fill="url(#kb-hub)" />
      <circle
        cx="250"
        cy="96"
        r="20"
        fill="#0a0b0f"
        stroke="url(#kb-p)"
        strokeWidth="1.5"
      />
      {[0, 1, 2, 3].map((i) => (
        <motion.rect
          key={i}
          x={241 + (i % 2) * 10}
          y={87 + Math.floor(i / 2) * 10}
          width="8"
          height="8"
          rx="2"
          fill="url(#kb-p)"
          // A resting value, not `undefined`: dropping `animate` mid-loop
          // leaves the element stuck on whatever opacity the last frame wrote.
          animate={reduced ? { opacity: 1 } : { opacity: [0.25, 1, 0.25] }}
          transition={{
            duration: 2.4,
            delay: i * 0.25,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      ))}

      {/* Knowledge graph */}
      {EDGES.map(([a, b], i) => (
        <motion.line
          key={i}
          x1={NODES[a].x}
          y1={NODES[a].y}
          x2={NODES[b].x}
          y2={NODES[b].y}
          stroke="url(#kb-g)"
          strokeWidth="1.25"
          animate={reduced ? { opacity: 0.55 } : { opacity: [0.2, 0.7, 0.2] }}
          transition={{
            duration: 3.6,
            delay: i * 0.3,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      ))}
      <line
        x1="270"
        y1="96"
        x2="300"
        y2="96"
        stroke="rgba(255,255,255,0.16)"
        strokeWidth="1.25"
      />
      {NODES.map((node, i) => (
        <motion.circle
          key={i}
          cx={node.x}
          cy={node.y}
          r={node.r}
          fill="#0a0b0f"
          stroke="url(#kb-g)"
          strokeWidth="1.5"
          // `initial` is required, not decorative: on a client-side navigation
          // there is no server-rendered `r` for Framer to read as the keyframe
          // origin, and it interpolates from undefined.
          initial={{ r: node.r }}
          animate={
            reduced ? { r: node.r } : { r: [node.r, node.r * 1.2, node.r] }
          }
          transition={{
            duration: 3,
            delay: i * 0.22,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      ))}
    </svg>
  );
}
