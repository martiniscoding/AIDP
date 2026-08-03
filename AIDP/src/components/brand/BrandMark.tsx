"use client";

import { useId, useMemo } from "react";
import { cn } from "@/lib/cn";
import { LOGOS } from "./logo-data";
import { CONCEPT_ICONS, isConcept, type BrandSlug } from "./marks";

type Size = "sm" | "md";

const box: Record<Size, string> = {
  sm: "size-7 rounded-lg",
  md: "size-9 rounded-xl",
};

const inner: Record<Size, string> = {
  sm: "size-[17px]",
  md: "size-[21px]",
};

const letter: Record<Size, string> = {
  sm: "text-[9px]",
  md: "text-[10.5px]",
};

/**
 * A vendor logo in a light tile.
 *
 * The artwork is the vendor's own, baked in at build time by
 * scripts/fetch-logos.mts — nothing is fetched at render, so the form has no
 * third-party requests and no layout shift while forty logos load.
 *
 * The tile is light on purpose. Logos always render in full colour, and a
 * good number of these are drawn in black or dark navy for print on white —
 * Kafka, Tableau, PostgreSQL, IBM. On a near-black tile those would be close
 * to invisible while the bright ones shouted. A light tile makes every vendor
 * render the way it was designed, and reads as deliberate rather than as a
 * theming bug.
 *
 * Selection is carried by the ring and the card, never by dimming the mark,
 * so every logo stays recognisable while scanning the catalog.
 *
 * Falls back to a monogram for write-ins, so a client's "Teradata Vantage"
 * looks like part of the set rather than a broken image.
 */
export function BrandMark({
  brand,
  label,
  size = "md",
  active = false,
  className,
}: {
  brand?: BrandSlug;
  /** Drives the monogram fallback when there is no logo for this option. */
  label: string;
  size?: Size;
  active?: boolean;
  className?: string;
}) {
  const logo = brand && !isConcept(brand) ? LOGOS[brand] : undefined;
  const ConceptIcon = brand && isConcept(brand) ? CONCEPT_ICONS[brand] : undefined;

  /**
   * Namespace the gradient/clipPath ids inside the logo body.
   *
   * Iconify already randomises ids per icon, so different logos never collide.
   * The same logo rendered twice does though — Power BI appears under both
   * "BI & reporting" and "Workloads" — and two elements sharing an id is
   * invalid HTML. Browsers resolve `url(#id)` to the first definition, so the
   * paint happens to be right, but the document isn't valid and an id-based
   * selector would hit the wrong node.
   */
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const body = useMemo(() => {
    if (!logo) return "";
    return logo.body
      .replace(/id="([^"]+)"/g, `id="$1${uid}"`)
      .replace(/url\(#([^)]+)\)/g, `url(#$1${uid})`)
      .replace(/(xlink:href|href)="#([^"]+)"/g, `$1="#$2${uid}"`);
  }, [logo, uid]);

  const initials =
    label
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join("") || "?";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden",
        "bg-white transition-shadow duration-200",
        box[size],
        // Hairline keeps the white tile from bleeding into a light logo's own
        // whitespace; the accent ring marks selection without touching the art.
        active
          ? "shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_0_0_2.5px_var(--color-royal-mid)]"
          : "shadow-[0_0_0_1px_rgba(255,255,255,0.14)]",
        className,
      )}
    >
      {logo ? (
        <svg
          viewBox={`0 0 ${logo.width} ${logo.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="presentation"
          className={inner[size]}
          // Monochrome sources ship a shape with no colour of their own;
          // `color` feeds the currentColor fill in their path data.
          style={logo.tint ? { color: logo.tint } : undefined}
          // Not user input: this markup comes from logo-data.ts, generated at
          // build time from vetted icon packages and committed to the repo.
          dangerouslySetInnerHTML={{ __html: body }}
        />
      ) : ConceptIcon ? (
        <ConceptIcon
          className={cn(inner[size], "text-slate-500")}
          strokeWidth={1.9}
        />
      ) : (
        <span className={cn("font-semibold tracking-tight text-slate-600", letter[size])}>
          {initials}
        </span>
      )}
    </span>
  );
}
