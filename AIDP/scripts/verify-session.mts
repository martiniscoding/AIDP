/**
 * Does a sign-in last an hour, and no longer?
 *
 * Runs the app's real auth options against Better Auth's in-memory adapter, so
 * the check is of the configuration that ships — not a copy of it — without
 * touching the database or anyone's account. What it proves: the session cookie
 * is set to expire in an hour, the session row ends an hour after sign-in, using
 * the session does not push that end back, and past it the session is refused.
 * A control run with refresh turned on shows that it is the setting, not luck,
 * that keeps the end still.
 *
 * Run with:  npx tsx scripts/verify-session.mts
 */
process.env.DATABASE_URL ??= "postgresql://nobody@127.0.0.1:1/none";
process.env.BETTER_AUTH_SECRET ??= "verify-session-secret-0123456789abcdef";
delete process.env.SESSION_SECONDS;

const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { authOptions, SESSION_SECONDS } = await import("../src/lib/auth-options");

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra: unknown = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`);
  }
};

type Row = Record<string, unknown>;
type SessionOptions = import("better-auth").BetterAuthOptions["session"];

function makeAuth(session: SessionOptions) {
  const db: Record<string, Row[]> = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    ...authOptions,
    session,
    database: memoryAdapter(db),
    baseURL: "http://localhost:3000",
  });
  return { auth, db };
}

const body = {
  email: "zz-session@example.com",
  password: "correct-horse-battery",
  name: "ZZ Session",
  company: "ZZ",
  country: "India",
  phone: "0000000000",
};

async function signIn(session: SessionOptions) {
  const { auth, db } = makeAuth(session);
  const started = Date.now();
  const response = await auth.api.signUpEmail({ body, asResponse: true });
  const setCookie = response.headers.get("set-cookie") ?? "";
  const at = setCookie.indexOf("better-auth.session_token=");
  const own = at === -1 ? "" : setCookie.slice(at).split(/,\s*(?=[\w.-]+=)/)[0];
  const token = /better-auth\.session_token=([^;]+)/.exec(own)?.[1] ?? "";
  const headers = new Headers({ cookie: `better-auth.session_token=${token}` });
  return { auth, db, response, own, token, headers, started };
}

const endOf = (db: Record<string, Row[]>) => new Date(db.session[0].expiresAt as Date).getTime();

console.log("\nThe setting");
ok("an hour by default", SESSION_SECONDS === 3600, SESSION_SECONDS);
ok("refresh is off", authOptions.session?.disableSessionRefresh === true);

console.log("\nSigning in");
const first = await signIn(authOptions.session);
ok("sign-in succeeds", first.response.ok, first.response.status);
ok("the session cookie is set", first.token.length > 0, first.own.slice(0, 80));
const maxAge = Number(/Max-Age=(\d+)/i.exec(first.own)?.[1]);
ok("the cookie itself expires in an hour", maxAge === 3600, first.own);
const end = endOf(first.db);
ok("the session ends an hour after sign-in", Math.abs(end - (first.started + 3600_000)) < 10_000,
  new Date(end).toISOString());

console.log("\nInside the hour");
const inside = await first.auth.api.getSession({ headers: first.headers });
ok("the session is honoured", inside?.user?.email === body.email, inside);
ok("and looking at it does not move the end", endOf(first.db) === end);

console.log("\nHalf an hour left, then used");
const halfLeft = new Date(Date.now() + 1800_000);
first.db.session[0].expiresAt = halfLeft;
await first.auth.api.getSession({ headers: first.headers });
ok("the end stays where it was — no refresh", endOf(first.db) === halfLeft.getTime(),
  new Date(endOf(first.db)).toISOString());

const control = await signIn({ expiresIn: 3600, updateAge: 0 });
control.db.session[0].expiresAt = new Date(Date.now() + 1800_000);
await control.auth.api.getSession({ headers: control.headers });
ok("control: with refresh on, the same use pushes the end back to a full hour",
  endOf(control.db) > Date.now() + 3500_000, new Date(endOf(control.db)).toISOString());

console.log("\nAfter the hour");
first.db.session[0].expiresAt = new Date(Date.now() - 1000);
const after = await first.auth.api.getSession({ headers: first.headers });
ok("the session is refused", after === null, after);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
