"use client";

import { motion } from "framer-motion";

/**
 * Six abstract diagrams, one per workflow step. Everything here is drawn from
 * the product's own vocabulary — documents, chunks, vectors, similarity,
 * parallel agents, scorecards — rather than generic SaaS decoration.
 *
 * Shared conventions: 220×170 viewBox, 1.25px strokes, accent gradient for
 * anything "live" and white/12 for structure.
 */

const VIEW = "0 0 220 170";
const STRUCTURE = "rgba(26,20,48,0.16)";
const STRUCTURE_SOFT = "rgba(26,20,48,0.09)";

function Defs({ id }: { id: string }) {
  return (
    <defs>
      {/*
        Two ramps, and the split is the whole point of these diagrams reading
        as monochrome:
          -g  white — the working parts. Most of the drawing uses this.
          -p  royal purple — exactly one focal element per diagram, the thing
              that step is actually about.
      */}
      <linearGradient id={`${id}-g`} x1="0" y1="170" x2="220" y2="0">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
        <stop offset="100%" stopColor="#ffffff" stopOpacity="0.55" />
      </linearGradient>
      <linearGradient id={`${id}-p`} x1="0" y1="170" x2="220" y2="0">
        <stop offset="0%" stopColor="#7c3aed" />
        <stop offset="100%" stopColor="#a78bfa" />
      </linearGradient>
      <radialGradient id={`${id}-r`}>
        <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.4" />
        <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

const loop = (duration: number, delay = 0) => ({
  duration,
  delay,
  repeat: Infinity,
  ease: "easeInOut" as const,
});

/* ---------------------------------------------------------------- 1 ---- */
/* Submit Request — documents and diagrams entering an intake frame.        */

export function SubmitVisual() {
  return (
    <svg viewBox={VIEW} fill="none" className="h-full w-full">
      <Defs id="v1" />
      <ellipse cx="110" cy="132" rx="72" ry="26" fill="url(#v1-r)" opacity="0.5" />

      {[0, 1, 2].map((i) => (
        <motion.g
          key={i}
          animate={{ y: [0, -4, 0] }}
          transition={loop(3.6, i * 0.35)}
        >
          <rect
            x={40 + i * 46}
            y={26 + i * 8}
            width="44"
            height="56"
            rx="6"
            stroke={i === 1 ? "url(#v1-g)" : STRUCTURE}
            strokeWidth="1.25"
            fill="rgba(26,20,48,0.03)"
          />
          <path
            d={`M${48 + i * 46} ${40 + i * 8}h28M${48 + i * 46} ${48 + i * 8}h20M${48 + i * 46} ${56 + i * 8}h24`}
            stroke={i === 1 ? "url(#v1-g)" : STRUCTURE_SOFT}
            strokeWidth="1.25"
            strokeLinecap="round"
          />
        </motion.g>
      ))}

      {/* Intake tray */}
      <rect
        x="34"
        y="104"
        width="152"
        height="38"
        rx="10"
        stroke="url(#v1-g)"
        strokeWidth="1.25"
        fill="rgba(26,20,48,0.038)"
      />
      <motion.path
        d="M110 96v-14"
        stroke="url(#v1-g)"
        strokeWidth="1.5"
        strokeLinecap="round"
        animate={{ opacity: [0.3, 1, 0.3] }}
        transition={loop(2.4)}
      />
      <path
        d="M104 90l6 6 6-6"
        stroke="url(#v1-g)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="48" y="117" width="34" height="12" rx="6" fill="rgba(26,20,48,0.1)" />
      {/* Focal: the chosen assessment type */}
      <rect x="88" y="117" width="52" height="12" rx="6" fill="url(#v1-p)" />
      <rect x="146" y="117" width="26" height="12" rx="6" fill="rgba(26,20,48,0.1)" />
    </svg>
  );
}

/* ---------------------------------------------------------------- 2 ---- */
/* AI Auto-Fill — extracted metadata populating a form.                     */

const ROWS = [
  { w: 96, label: 62 },
  { w: 74, label: 48 },
  { w: 108, label: 56 },
  { w: 84, label: 44 },
];

export function AutofillVisual() {
  return (
    <svg viewBox={VIEW} fill="none" className="h-full w-full">
      <Defs id="v2" />
      <ellipse cx="110" cy="85" rx="88" ry="58" fill="url(#v2-r)" opacity="0.35" />

      <rect
        x="26"
        y="24"
        width="168"
        height="122"
        rx="12"
        stroke={STRUCTURE}
        strokeWidth="1.25"
        fill="rgba(26,20,48,0.03)"
      />

      {ROWS.map((row, i) => (
        <g key={i}>
          <rect
            x="42"
            y={44 + i * 25}
            width={row.label}
            height="7"
            rx="3.5"
            fill="rgba(26,20,48,0.14)"
          />
          <rect
            x="42"
            y={56 + i * 25}
            width={row.w}
            height="9"
            rx="4.5"
            fill="rgba(26,20,48,0.05)"
          />
          <motion.rect
            x="42"
            y={56 + i * 25}
            height="9"
            rx="4.5"
            fill="url(#v2-g)"
            opacity="0.8"
            initial={{ width: 0 }}
            animate={{ width: [0, row.w, row.w, 0] }}
            transition={{
              duration: 5,
              delay: i * 0.4,
              repeat: Infinity,
              times: [0, 0.35, 0.85, 1],
              ease: "easeInOut",
            }}
          />
        </g>
      ))}

      {/* Focal: extraction confirmed */}
      <motion.circle
        cx="168"
        cy="120"
        r="12"
        stroke="url(#v2-p)"
        strokeWidth="1.25"
        animate={{ scale: [1, 1.14, 1], opacity: [0.5, 1, 0.5] }}
        transition={loop(2.8)}
        style={{ transformOrigin: "168px 120px" }}
      />
      <path
        d="M164 120l3 3 6-7"
        stroke="url(#v2-p)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ---------------------------------------------------------------- 3 ---- */
/* Parse & Embed — a component graph resolving into a vector field.         */

const GRAPH_NODES = [
  { x: 34, y: 44 },
  { x: 68, y: 26 },
  { x: 62, y: 78 },
  { x: 30, y: 108 },
  { x: 78, y: 124 },
];
const GRAPH_EDGES: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [1, 2],
  [2, 4],
  [0, 3],
  [3, 4],
];

export function ParseEmbedVisual() {
  return (
    <svg viewBox={VIEW} fill="none" className="h-full w-full">
      <Defs id="v3" />
      <ellipse cx="110" cy="85" rx="92" ry="60" fill="url(#v3-r)" opacity="0.3" />

      {GRAPH_EDGES.map(([a, b], i) => (
        <motion.line
          key={i}
          x1={GRAPH_NODES[a].x}
          y1={GRAPH_NODES[a].y}
          x2={GRAPH_NODES[b].x}
          y2={GRAPH_NODES[b].y}
          stroke="url(#v3-g)"
          strokeWidth="1.25"
          animate={{ opacity: [0.2, 0.75, 0.2] }}
          transition={loop(3.2, i * 0.22)}
        />
      ))}
      {GRAPH_NODES.map((n, i) => (
        <motion.circle
          key={i}
          cx={n.x}
          cy={n.y}
          r="4.5"
          fill="#0a0b0f"
          stroke="url(#v3-g)"
          strokeWidth="1.5"
          // See KnowledgeGraph: without an explicit origin, a client-side
          // navigation animates `r` from undefined.
          initial={{ r: 4.5 }}
          animate={{ r: [4.5, 5.6, 4.5] }}
          transition={loop(3, i * 0.3)}
        />
      ))}

      {/* Transform arrow */}
      <path
        d="M100 85h20"
        stroke={STRUCTURE}
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path
        d="M116 81l4 4-4 4"
        stroke={STRUCTURE}
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Embedding field */}
      <rect
        x="132"
        y="30"
        width="62"
        height="110"
        rx="10"
        stroke={STRUCTURE}
        strokeWidth="1.25"
        fill="rgba(26,20,48,0.03)"
      />
      {Array.from({ length: 24 }).map((_, i) => {
        const col = i % 4;
        const row = Math.floor(i / 4);
        return (
          <motion.circle
            key={i}
            cx={146 + col * 12}
            cy={44 + row * 17}
            r="2.4"
            // Focal: the embeddings this step produces
            fill="url(#v3-p)"
            animate={{ opacity: [0.15, 0.9, 0.15] }}
            transition={loop(2.8, (i % 7) * 0.28)}
          />
        );
      })}
    </svg>
  );
}

/* ---------------------------------------------------------------- 4 ---- */
/* Retrieve Context — nearest-neighbour lookup around a query vector.       */

const NEIGHBOURS = [
  { x: 78, y: 56, hit: true },
  { x: 148, y: 62, hit: true },
  { x: 132, y: 116, hit: true },
  { x: 52, y: 104, hit: false },
  { x: 176, y: 34, hit: false },
  { x: 44, y: 36, hit: false },
  { x: 186, y: 124, hit: false },
];

export function RetrieveVisual() {
  return (
    <svg viewBox={VIEW} fill="none" className="h-full w-full">
      <Defs id="v4" />

      {[30, 48, 66].map((r, i) => (
        <motion.circle
          key={r}
          cx="110"
          cy="85"
          r={r}
          stroke="url(#v4-g)"
          strokeWidth="1.25"
          strokeDasharray="3 5"
          animate={{ opacity: [0.12, 0.5, 0.12] }}
          transition={loop(3.4, i * 0.5)}
        />
      ))}

      {NEIGHBOURS.map((n, i) => (
        <g key={i}>
          {n.hit ? (
            <motion.line
              x1="110"
              y1="85"
              x2={n.x}
              y2={n.y}
              stroke="url(#v4-g)"
              strokeWidth="1.25"
              animate={{ opacity: [0.25, 0.85, 0.25] }}
              transition={loop(3, i * 0.4)}
            />
          ) : null}
          <circle
            cx={n.x}
            cy={n.y}
            r={n.hit ? 5 : 3.2}
            fill={n.hit ? "url(#v4-g)" : "rgba(26,20,48,0.18)"}
          />
        </g>
      ))}

      {/* Focal: the query vector everything is measured against */}
      <circle cx="110" cy="85" r="16" fill="url(#v4-r)" />
      <circle
        cx="110"
        cy="85"
        r="7"
        fill="#0a0b0f"
        stroke="url(#v4-p)"
        strokeWidth="1.75"
      />
      <circle cx="110" cy="85" r="2.4" fill="#a78bfa" />
    </svg>
  );
}

/* ---------------------------------------------------------------- 5 ---- */
/* AI Assessment — compliance and risk running as parallel lanes.           */

export function AssessVisual() {
  return (
    <svg viewBox={VIEW} fill="none" className="h-full w-full">
      <Defs id="v5" />
      <ellipse cx="110" cy="85" rx="92" ry="56" fill="url(#v5-r)" opacity="0.28" />

      {/* Split from a single context feed */}
      <path
        d="M20 85h22c10 0 10-32 20-32h16M20 85h22c10 0 10 32 20 32h16"
        stroke={STRUCTURE}
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <circle cx="18" cy="85" r="4" fill="url(#v5-g)" />

      {(
        [
          { y: 34, label: "compliance" },
          { y: 98, label: "risk" },
        ] as const
      ).map((lane, laneIndex) => (
        <g key={lane.label}>
          <rect
            x="78"
            y={lane.y}
            width="118"
            height="38"
            rx="9"
            stroke="url(#v5-g)"
            strokeWidth="1.25"
            fill="rgba(26,20,48,0.038)"
          />
          {[0, 1, 2, 3].map((i) => (
            <motion.rect
              key={i}
              x={92 + i * 26}
              y={lane.y + 14}
              width="18"
              height="10"
              rx="3"
              // Focal: the two agent lanes doing the work in parallel
              fill="url(#v5-p)"
              animate={{ opacity: [0.18, 0.95, 0.18] }}
              transition={loop(2.6, laneIndex * 0.5 + i * 0.18)}
            />
          ))}
          <motion.circle
            cx="78"
            cy={lane.y + 19}
            r="3.5"
            // The lane head. Literal white here was left over from the dark
            // build — on the white card this visual sits on it was invisible.
            fill="#6d28d9"
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={loop(2.6, laneIndex * 0.5)}
          />
        </g>
      ))}

      {/* Parallel marker */}
      <path
        d="M204 60v50"
        stroke={STRUCTURE_SOFT}
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ---------------------------------------------------------------- 6 ---- */
/* Report Generated — scorecard, risk matrix, ranked findings.              */

const ARC_LENGTH = Math.PI * 66; // semicircle, r = 66

export function ReportVisual() {
  return (
    <svg viewBox={VIEW} fill="none" className="h-full w-full">
      <Defs id="v6" />
      <ellipse cx="110" cy="90" rx="86" ry="52" fill="url(#v6-r)" opacity="0.3" />

      {/* Compliance gauge */}
      <path
        d="M44 100a66 66 0 0 1 132 0"
        stroke="rgba(26,20,48,0.1)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      {/* Focal: the compliance score */}
      <motion.path
        d="M44 100a66 66 0 0 1 132 0"
        stroke="url(#v6-p)"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={ARC_LENGTH}
        initial={{ strokeDashoffset: ARC_LENGTH }}
        whileInView={{ strokeDashoffset: ARC_LENGTH * 0.24 }}
        viewport={{ once: true }}
        transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1] }}
      />

      {/* Ranked findings */}
      {[
        { w: 68, o: 0.9 },
        { w: 52, o: 0.6 },
        { w: 38, o: 0.38 },
      ].map((bar, i) => (
        <g key={i}>
          <rect
            x="62"
            y={110 + i * 14}
            width="96"
            height="7"
            rx="3.5"
            fill="rgba(26,20,48,0.06)"
          />
          <motion.rect
            x="62"
            y={110 + i * 14}
            height="7"
            rx="3.5"
            fill="url(#v6-g)"
            opacity={bar.o}
            initial={{ width: 0 }}
            whileInView={{ width: bar.w }}
            viewport={{ once: true }}
            transition={{
              duration: 1,
              delay: 0.35 + i * 0.14,
              ease: [0.16, 1, 0.3, 1],
            }}
          />
        </g>
      ))}

      {/* Score readout */}
      <text
        x="110"
        y="94"
        textAnchor="middle"
        className="fill-ink font-display"
        style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.03em" }}
      >
        86
      </text>
    </svg>
  );
}

export const STEP_VISUALS = [
  SubmitVisual,
  AutofillVisual,
  ParseEmbedVisual,
  RetrieveVisual,
  AssessVisual,
  ReportVisual,
];
