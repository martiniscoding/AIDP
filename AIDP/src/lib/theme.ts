/**
 * Which theme the product interior wears.
 *
 * Two names, not one. `ThemeChoice` is what the person picked and what we
 * store; `Theme` is what that resolves to right now. They differ only for
 * `system`, which has no fixed answer — it is whatever the OS is saying this
 * minute, and it can change while the tab is open.
 *
 * The resolved value is what lands on `<html data-theme>`, so the stylesheet
 * never has to ask about the OS: `[data-theme="dark"] .app-shell` is the whole
 * contract, and the preference lives in exactly one place instead of being
 * half in CSS media queries and half in storage.
 *
 * Scope: the *interior* only. The landing page is a light sheet by design —
 * it is the marketing surface and its art direction depends on it — so the
 * dark tokens are scoped to `.app-shell` and `data-theme` is inert out there.
 */
export type Theme = "light" | "dark";
export type ThemeChoice = Theme | "system";

export const THEME_STORAGE_KEY = "aidp-theme";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/** What `choice` means right now. Only `system` depends on the environment. */
export function resolveTheme(choice: ThemeChoice): Theme {
  if (choice !== "system") return choice;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/**
 * The stored preference, as an external store.
 *
 * `localStorage` is exactly that — state React does not own — so the control
 * subscribes to it rather than copying it into component state on mount.
 * Which also gets cross-tab sync for nothing: the `storage` event fires in
 * every *other* tab, and the local set notifies this one.
 */
const listeners = new Set<() => void>();

export function subscribeThemeChoice(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : "system";
  } catch {
    // Storage can throw outright under a blocked-cookies setting, so a read
    // failure falls back to the default rather than taking the page with it.
    return "system";
  }
}

export function storeThemeChoice(choice: ThemeChoice) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Unpersisted is survivable — this session still honours the click.
  }
  for (const listener of listeners) listener();
}

/** Puts the resolved theme where the stylesheet looks for it. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/**
 * The same resolution, inlined into the document head.
 *
 * It has to run before first paint, which rules out doing it in a component:
 * React's first commit happens after the browser has already painted the
 * server HTML, so a person who chose dark would watch the app flash white on
 * every navigation that reloads. A blocking inline script in `<head>` is the
 * one place that is early enough.
 *
 * Deliberately duplicated rather than imported: a module import would be a
 * network round trip in front of the first paint, which is the thing this
 * exists to avoid. The duplication is four lines and both copies are in this
 * file, where they can be read against each other.
 *
 * `document.documentElement` is written directly — `document.body` does not
 * exist yet at this point in the parse.
 */
export const THEME_BOOT_SCRIPT = `(function(){var t="dark";try{t=window.matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches?"dark":"light"}catch(e){}try{var c=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(c==="light"||c==="dark"){t=c}}catch(e){}document.documentElement.dataset.theme=t})()`;
