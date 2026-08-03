"use client";

import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "./auth";

export const authClient = createAuthClient({
  // Same-origin in the browser; the env var is only needed if the API is
  // hosted separately from the app.
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,

  // Teaches the client about company / country / phone so `signUp.email`
  // accepts them and `useSession` returns them, both fully typed. The import
  // of `auth` is type-only, so no server code reaches the bundle.
  plugins: [inferAdditionalFields<typeof auth>()],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  requestPasswordReset,
  resetPassword,
} = authClient;

/** Where users land once they're authenticated. */
export const AFTER_AUTH_REDIRECT = "/dashboard";
