/**
 * Provider marks.
 *
 * Each provider's own logo, so the picker is read at a glance rather than
 * decoded from three similar lines of text — an administrator setting this up
 * knows the marks long before they know our wording for them.
 *
 * The path data is the official mark, taken from Simple Icons (the paths are
 * CC0; the trademarks remain each provider's own). Inlined rather than
 * installed so the page carries three paths instead of a dependency, and so it
 * renders with no network request — a settings screen that waits on a CDN for
 * its logos is a settings screen that looks broken on a slow connection.
 *
 * Drawn in `currentColor`, always. Three logos from three brands sitting in a
 * row clash if each keeps its own colour, and two of these three have no colour
 * worth keeping — OpenRouter's mark is slate grey and Anthropic's is near
 * black, so "the brand colour shows which is selected" would say nothing on two
 * tiles out of three. The selected tile is marked in the product's own accent
 * instead, like every other chosen thing in this interface, and the marks take
 * their weight from the text colour around them.
 */

export type MarkName = "openrouter" | "anthropic" | "gemini";

const PATHS: Record<MarkName, string> = {
  openrouter:
    "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z",
  anthropic:
    "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  gemini:
    "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
};

export function ProviderMark({ name, size = 20 }: { name: MarkName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 transition-colors"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
