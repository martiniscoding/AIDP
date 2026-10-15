import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * The outer door: a request with no session never reaches a private route.
 *
 * Every private surface was already gated on the server — `requireWorkspace`
 * in src/app/dashboard/layout.tsx, `currentUser` in src/app/admin/layout.tsx,
 * and `requireAccess` in each Server Action and Route Handler. Those checks
 * remain the real authority and none of them are removed: they read the
 * database, so they are the only thing that can tell a revoked employee from a
 * current one. A cookie cannot.
 *
 * This runs in front of them because a layout runs *inside* the render. An
 * unauthenticated request otherwise costs a session lookup and a database round
 * trip before the redirect settles, and a route added under /dashboard is
 * private only if its author remembered the gate. Turning those requests away
 * at the edge of the app makes the guarantee structural instead.
 *
 * Why this is the file conventions call it proxy, not middleware
 * -------------------------------------------------------------
 * Next 16 deprecated the `middleware` filename and renamed it to `proxy`, and
 * the exported function with it (see
 * node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md). A file
 * named `middleware.ts` exporting `middleware` is dead code on this version —
 * it is not an error, which is worse, because the routes simply stay open. The
 * runtime here is `nodejs` and cannot be configured.
 *
 * What this checks, and what it deliberately does not
 * ---------------------------------------------------
 * The presence of a session cookie, and nothing else. `getSessionCookie` does
 * not verify the signature and does not reach the database. That is Better
 * Auth's guidance for this layer and Next's own: proxy runs on every request,
 * including prefetches, so a database check here would put a query on every
 * hover (see the authentication guide's "Optimistic checks with Proxy").
 *
 * So this is an optimisation and a backstop, never the decision. A forged or
 * expired cookie gets past this line and is refused milliseconds later by the
 * server-side gate. The security property comes from that gate; what this adds
 * is that a request with no session at all never gets far enough to need it.
 *
 * Session length is unaffected: reading a cookie does not extend a session, and
 * `disableSessionRefresh` keeps the hour in src/lib/auth-options.ts absolute.
 */

/** Private route prefixes: a path equal to one of these, or beneath it, needs a session. */
const PRIVATE = ["/dashboard", "/projects", "/documents", "/admin"] as const;

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Exact match or a true child: "/documents" and "/documents/42" are private;
  // a route that merely starts with those letters — "/documentation" — is not.
  const isPrivate = PRIVATE.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!isPrivate) return NextResponse.next();

  // Presence only — see the note above on why this cannot be the real check.
  if (getSessionCookie(request)) return NextResponse.next();

  // `/sign-in`, not `/login`: that is the route this app serves
  // (src/app/(auth)/sign-in). `next` is a breadcrumb for the person and for
  // logs — the sign-in form does not read it yet, and nothing downstream
  // trusts it.
  const url = new URL("/sign-in", request.nextUrl);
  url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  /**
   * Everything except Next's own assets, the auth endpoints and the worker
   * callbacks.
   *
   * `/api/auth` is excluded because signing in has to be reachable while signed
   * out. `/api/internal` is excluded because the workers authenticate with
   * `WORKER_SHARED_SECRET` and carry no cookie — see
   * src/app/api/internal/credentials/route.ts; a cookie check in front of them
   * would break every job. Both do their own authorisation.
   *
   * The remaining /api routes are matched but are not under a PRIVATE prefix,
   * so they pass through and are refused by their own `requireAccess`. That is
   * right: an API answers 401, it does not redirect a fetch to an HTML page.
   */
  matcher: [
    "/((?!_next/static|_next/image|api/auth|api/internal|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?)$).*)",
  ],
};
