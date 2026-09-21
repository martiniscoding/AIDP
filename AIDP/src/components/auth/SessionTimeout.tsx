"use client";

import { useEffect } from "react";
import { authClient, signOut } from "@/lib/auth-client";

/**
 * Sends a signed-in screen to sign-in the moment its session ends.
 *
 * A session lasts an hour (see `session` in src/lib/auth-options.ts), but the
 * server only notices on the next request — a report left open on a desk would
 * keep showing customer findings long after the sign-in behind it had lapsed.
 * So the screen asks once when it loads how long it has, and signs itself out
 * when that runs out.
 *
 * Timers stop while a laptop sleeps, so the deadline is checked again whenever
 * the tab comes back into view: a machine opened after lunch goes straight to
 * sign-in rather than showing the page it was left on. Asking for the session
 * does not extend it — refresh is off — so this never keeps a session alive.
 */
export function SessionTimeout() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiresAt: number | null = null;
    let ended = false;

    const end = async () => {
      if (ended) return;
      ended = true;
      try {
        await signOut();
      } catch {
        // Already over on the server; sign-in is still where this goes.
      }
      window.location.assign("/sign-in");
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (expiresAt === null) return;
      const left = expiresAt - Date.now();
      if (left <= 0) {
        void end();
        return;
      }
      timer = setTimeout(() => void end(), left);
    };

    authClient
      .getSession()
      .then(({ data }) => {
        const at = data?.session?.expiresAt;
        if (!at) return; // No session: the next request is redirected anyway.
        expiresAt = new Date(at).getTime();
        schedule();
      })
      .catch(() => {
        // Could not ask; the server still ends the session on time.
      });

    const onVisible = () => {
      if (document.visibilityState === "visible") schedule();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
