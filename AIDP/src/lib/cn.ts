/**
 * Minimal class-name joiner. Deliberately not `clsx` + `tailwind-merge` —
 * this project has few enough conditional classes that a dependency isn't
 * worth it, and every call site controls its own ordering.
 */
export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}
