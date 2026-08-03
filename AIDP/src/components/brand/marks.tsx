import {
  Boxes,
  Cloud,
  Cpu,
  Database,
  FileSpreadsheet,
  Layers,
  Minus,
  Plug,
  Radio,
  Server,
  type LucideIcon,
} from "lucide-react";
import { LOGOS } from "./logo-data";

/**
 * Non-brand marks.
 *
 * Vendor logos live in the generated `logo-data.ts`. This file covers the
 * options that are concepts rather than companies — "On-premise", "IoT
 * devices", "No warehouse yet" — where a logo would imply a product that
 * doesn't exist and a monogram would imply a brand.
 */
export const CONCEPT_ICONS = {
  onprem: Server,
  multicloud: Cloud,
  iot: Radio,
  files: FileSpreadsheet,
  apis: Plug,
  warehouse: Database,
  lakehouse: Layers,
  modular: Boxes,
  compute: Cpu,
  none: Minus,
} as const satisfies Record<string, LucideIcon>;

export type ConceptSlug = keyof typeof CONCEPT_ICONS;
export type LogoSlug = keyof typeof LOGOS;

/** Every value the catalog may put in an option's `brand` field. */
export type BrandSlug = LogoSlug | ConceptSlug;

export function isConcept(slug: BrandSlug): slug is ConceptSlug {
  return slug in CONCEPT_ICONS;
}
