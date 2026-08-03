import { prismaAdapter } from "better-auth/adapters/prisma";
import type { BetterAuthOptions } from "better-auth";
import { prisma } from "./prisma";

/**
 * Better Auth configuration, minus anything Next-specific.
 *
 * Split out from `auth.ts` so other entry points can import the same options
 * without dragging in `next/headers` via the nextCookies plugin, which can't
 * load outside a request.
 *
 * Database
 * --------
 * Neon Postgres through Prisma. The schema lives in `prisma/schema.prisma` and
 * is applied with `npm run db:migrate` — Better Auth no longer creates its own
 * tables, so that file is the single source of truth. Changing
 * `additionalFields` below means adding the matching columns there too.
 */
export const authOptions = {
  database: prismaAdapter(prisma, {
    provider: "postgresql",
    // Better Auth writes a user and their credential row together on sign-up;
    // Neon's WebSocket driver supports the interactive transaction that needs.
    transaction: true,
  }),

  // In development Better Auth falls back to a generated secret and warns.
  // Set BETTER_AUTH_SECRET before deploying — sessions are signed with it.
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",

  /**
   * Collected at sign-up. `input: true` lets the client send them on the
   * sign-up call; each one maps to a column on the `user` table, so changing
   * this list means updating `prisma/schema.prisma` and re-running
   * `npm run db:migrate`.
   */
  user: {
    additionalFields: {
      company: { type: "string", required: true, input: true },
      country: { type: "string", required: true, input: true },
      phone: { type: "string", required: true, input: true },
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,

    /**
     * Password-reset delivery.
     *
     * No email provider is wired up yet, so in development the reset link is
     * logged to the server console — copy it out of the terminal to complete
     * the flow. Replace the body of this function with a real send, e.g. Resend:
     *
     *   import { Resend } from "resend";
     *   const resend = new Resend(process.env.RESEND_API_KEY);
     *   await resend.emails.send({
     *     from: "Dexter <no-reply@yourdomain.com>",
     *     to: user.email,
     *     subject: "Reset your Dexter password",
     *     html: `<a href="${url}">Choose a new password</a>`,
     *   });
     */
    sendResetPassword: async ({ user, url }) => {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "No email provider configured — wire up sendResetPassword in src/lib/auth-options.ts before shipping.",
        );
      }
      console.info(
        `\n[Dexter] Password reset requested for ${user.email}\n[Dexter] Reset link: ${url}\n`,
      );
    },
  },
} satisfies BetterAuthOptions;
