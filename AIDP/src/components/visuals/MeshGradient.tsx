"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

type Props = {
  /**
   * `pointer` follows the cursor with a soft lag on fine-pointer devices and
   * falls back to the ambient drift on touch. `ambient` never tracks — used
   * on the auth pages, which should feel calm.
   */
  mode?: "pointer" | "ambient";
  className?: string;
  /** Blend the bottom edge into the page background. */
  fadeBottom?: boolean;
  /**
   * The faint engineering grid. Turn it off where something else already
   * supplies texture — over the hero photograph it reads as noise.
   */
  showGrid?: boolean;
  /**
   * Which ground this is painted on. `light` is pigment over the page canvas
   * — violet that tints paper, and it has to stay weak or it bruises. `deep`
   * is emitted light over one of the dark anchor surfaces, where the same
   * composition needs roughly three times the alpha to register at all.
   */
  tone?: "light" | "deep";
};

/** The same five stops in both tones; only how hard they are pushed changes. */
const TONE = {
  light: {
    core: "rgba(124,58,237,0.15), rgba(124,58,237,0) 64%",
    inner: "rgba(91,33,182,0.10), rgba(91,33,182,0) 62%",
    a: "rgba(109,40,217,0.14), rgba(109,40,217,0) 68%",
    b: "rgba(99,102,241,0.11), rgba(99,102,241,0) 66%",
    c: "rgba(124,58,237,0.11), rgba(124,58,237,0) 70%",
    grid: "rgba(26,20,48,0.055)",
    gridOpacity: 0.5,
  },
  deep: {
    core: "rgba(139,92,246,0.42), rgba(139,92,246,0) 64%",
    inner: "rgba(196,181,253,0.28), rgba(196,181,253,0) 62%",
    a: "rgba(124,58,237,0.44), rgba(124,58,237,0) 68%",
    b: "rgba(255,255,255,0.14), rgba(255,255,255,0) 66%",
    c: "rgba(167,139,250,0.30), rgba(167,139,250,0) 70%",
    grid: "rgba(255,255,255,0.06)",
    gridOpacity: 0.28,
  },
} as const;

const LERP = 0.085; // easing factor per frame: lagged enough to feel like
// weight, fast enough that the response to the cursor is unmistakable

export function MeshGradient({
  mode = "pointer",
  className,
  fadeBottom = true,
  showGrid = true,
  tone = "light",
}: Props) {
  const t = TONE[tone];
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedQuery.matches) return; // CSS defaults already hold a static composition

    const fineQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
    const tracksPointer = () => mode === "pointer" && fineQuery.matches;

    // Normalised 0..1 within the container.
    let targetX = 0.5;
    let targetY = 0.4;
    let currentX = targetX;
    let currentY = targetY;
    let phase = 0;
    let raf = 0;
    let running = false;

    const onPointerMove = (event: PointerEvent) => {
      if (!tracksPointer()) return;
      const rect = el.getBoundingClientRect();
      if (rect.height === 0) return;
      targetX = (event.clientX - rect.left) / rect.width;
      targetY = (event.clientY - rect.top) / rect.height;
    };

    const frame = () => {
      if (!tracksPointer()) {
        // Slow Lissajous drift so touch devices still get motion.
        phase += 0.0022;
        targetX = 0.5 + Math.cos(phase) * 0.26;
        targetY = 0.42 + Math.sin(phase * 0.73) * 0.2;
      }

      currentX += (targetX - currentX) * LERP;
      currentY += (targetY - currentY) * LERP;

      el.style.setProperty("--mx", `${(currentX * 100).toFixed(2)}%`);
      el.style.setProperty("--my", `${(currentY * 100).toFixed(2)}%`);
      // Signed offsets (-1..1) for blob parallax.
      el.style.setProperty("--px", (currentX * 2 - 1).toFixed(4));
      el.style.setProperty("--py", (currentY * 2 - 1).toFixed(4));

      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    // Don't burn frames once the gradient has scrolled out of view.
    const observer = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting ? start() : stop()),
      { threshold: 0 },
    );
    observer.observe(el);

    window.addEventListener("pointermove", onPointerMove, { passive: true });

    return () => {
      observer.disconnect();
      stop();
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [mode]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        "[--mx:50%] [--my:40%] [--px:0] [--py:0]",
        className,
      )}
    >
      {/* Cursor-anchored core wash: one violet field with a denser violet
          core inside it. No second hue. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            `radial-gradient(46rem 40rem at var(--mx) var(--my), ${t.core})`,
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            `radial-gradient(20rem 18rem at var(--mx) var(--my), ${t.inner})`,
        }}
      />

      {/* Fixed depth blobs, parallaxed by a fraction of the cursor offset */}
      <div
        className="animate-drift-a absolute -left-[12%] top-[-18%] size-[46rem] rounded-full opacity-70 blur-[110px]"
        style={{
          background:
            `radial-gradient(circle, ${t.a})`,
          translate: "calc(var(--px) * 105px) calc(var(--py) * 72px)",
        }}
      />
      <div
        className="animate-drift-b absolute -right-[14%] top-[6%] size-[40rem] rounded-full opacity-60 blur-[120px]"
        style={{
          background:
            `radial-gradient(circle, ${t.b})`,
          translate: "calc(var(--px) * -88px) calc(var(--py) * -58px)",
        }}
      />
      <div
        className="animate-drift-a absolute bottom-[-24%] left-[28%] size-[38rem] rounded-full opacity-55 blur-[130px]"
        style={{
          background:
            `radial-gradient(circle, ${t.c})`,
          translate: "calc(var(--px) * 60px) calc(var(--py) * -42px)",
          animationDelay: "-9s",
        }}
      />

      {/* Engineering grid, faded out toward the edges */}
      {showGrid ? (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              `linear-gradient(to right, ${t.grid} 1px, transparent 1px), linear-gradient(to bottom, ${t.grid} 1px, transparent 1px)`,
            opacity: t.gridOpacity,
            backgroundSize: "68px 68px",
            maskImage:
              "radial-gradient(70% 55% at var(--mx) var(--my), #000 0%, transparent 78%)",
            WebkitMaskImage:
              "radial-gradient(70% 55% at var(--mx) var(--my), #000 0%, transparent 78%)",
          }}
        />
      ) : null}

      {fadeBottom ? (
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 h-56 bg-linear-to-b from-transparent",
            tone === "deep" ? "to-deep" : "to-canvas",
          )}
        />
      ) : null}
    </div>
  );
}
