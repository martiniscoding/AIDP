import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { authOptions } from "./auth-options";

/**
 * Server-side Better Auth instance.
 *
 * Everything except the Next.js integration lives in `auth-options.ts` so the
 * migration script can read the same schema. See that file for the database
 * setup and the Postgres swap.
 */
export const auth = betterAuth({
  ...authOptions,

  // Must stay last: lets server-side auth calls set cookies in App Router.
  plugins: [nextCookies()],
});
