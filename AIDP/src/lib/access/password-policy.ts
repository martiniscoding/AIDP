/**
 * The one rule about passwords that both sides of the wire need to know.
 *
 * Its own module with no imports, because the People page is a Client
 * Component and needs to say "at least eight characters" before submitting.
 * Importing that number from provision.ts would pull Better Auth and Prisma
 * into the browser bundle, which the bundler refuses outright.
 *
 * Must stay in step with `emailAndPassword.minPasswordLength` in
 * src/lib/auth-options.ts. That setting guards Better Auth's own routes; this
 * one guards the administrator path that bypasses them.
 */
export const MIN_PASSWORD = 8;
