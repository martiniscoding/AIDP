"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  DARK_QUERY,
  applyTheme,
  readThemeChoice,
  resolveTheme,
  storeThemeChoice,
  subscribeThemeChoice,
  type ThemeChoice,
} from "@/lib/theme";

/**
 * Light / dark, from the top right.
 *
 * Three options rather than two. A plain switch has to invent an answer for
 * the first visit, and whichever one it picks is wrong for half the people
 * arriving — "System" is the honest default, and it is also the only setting
 * that keeps following the OS after the page has loaded.
 *
 * It sits in the TopBar, beside the account — the corner people already go
 * to for settings about themselves rather than about the work. It is drawn
 * in page tokens, so pressing it restyles the control along with everything
 * else: that is the point, and it is the shortest possible confirmation that
 * the click landed.
 *
 * The preference is per-browser, not per-account — it is a property of the
 * screen you are sitting at, and a person on a laptop and a wall display has
 * two different right answers. That is also why it is localStorage and not a
 * column on the user: no round trip, and no flash while it loads.
 */
const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

export function ThemeToggle() {
  // The server cannot know what is in this browser's storage, so it renders
  // the default and the first client pass corrects it. Only the highlight in
  // this control is ever briefly wrong — the page itself was already painted
  // in the right theme by the boot script, well before React ran.
  const choice = useSyncExternalStore(
    subscribeThemeChoice,
    readThemeChoice,
    () => "system" as ThemeChoice,
  );

  // Keeps <html> in step with the store. Mostly a no-op — the boot script
  // and the click below have already set it — but it is the path that carries
  // a change made in another tab, which arrives as a store update and nothing
  // else.
  //
  // And "system" is a standing subscription, not a one-off reading: macOS
  // flips at sunset, and the app should flip with it rather than waiting for
  // a reload to notice.
  useEffect(() => {
    applyTheme(resolveTheme(choice));
    if (choice !== "system") return;
    const query = window.matchMedia(DARK_QUERY);
    const sync = () => applyTheme(query.matches ? "dark" : "light");
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [choice]);

  const pick = (next: ThemeChoice) => {
    // Storage first: the write is what the control reads back from, and what
    // tells any other open tab to follow.
    storeThemeChoice(next);
    applyTheme(resolveTheme(next));
  };

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-full border border-line bg-card p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = choice === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => pick(value)}
            aria-pressed={active}
            title={label}
            className={cn(
              "grid size-[26px] place-items-center rounded-full transition-colors",
              active
                ? "bg-royal-tint text-royal-deep"
                : "text-ink/50 hover:bg-canvas-sunk hover:text-ink/80",
            )}
          >
            {/* Icon-only: three labels spelled out would take more of the bar
                than the account beside them. The name is still there for
                anyone not reading pictures, and in the tooltip. */}
            <Icon size={14} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
