# Dexter — landing page & authentication

Marketing site and auth flow for **Dexter**, an AI-native enterprise architecture
governance platform.

This build covers the public landing page and the four auth screens only. The
dashboard, submission portal, KB manager, report viewer, and analytics screens
are out of scope; `/dashboard` exists solely as an unstyled placeholder that
proves the post-auth redirect and session guard work.

## Running it

```bash
npm install
npm run dev            # writes .env.local, then tell it about your database
# paste your Neon pooled connection string into DATABASE_URL
npm run db:migrate     # creates the four auth tables
```

There is one thing to configure: the database. `predev` writes `.env.local`
with a generated dev secret and an empty `DATABASE_URL`, and the app refuses to
serve a request until that has a [Neon](https://neon.tech) Postgres connection
string in it — pooled, the host with `-pooler` in it. `.env.example` says where
to find it. If the project is linked to Vercel, `vercel env pull .env.local`
fetches it instead. Then open http://localhost:3000.

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server (bootstraps `.env.local`, runs `prisma generate`) |
| `npm run build` / `npm start` | Production build and serve |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run db:migrate` | Create + apply a migration from schema changes (dev) |
| `npm run db:deploy` | Apply existing migrations (CI / production) |
| `npm run db:generate` | Regenerate the Prisma client into `generated/` |
| `npm run db:studio` | Prisma Studio against the same database |

## Routes

| Route | Notes |
| --- | --- |
| `/` | Landing page |
| `/sign-up`, `/sign-in` | Email + password |
| `/forgot-password`, `/reset-password` | Token-based reset |
| `/dashboard` | Placeholder; redirects to `/sign-in` without a session |
| `/api/auth/[...all]` | Better Auth handler |

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · Framer Motion ·
Better Auth on Neon Postgres via Prisma 7 · `lucide-react` · Geist + Inter via
`next/font`.

## Theme

Monochrome: near-black grounds, white and grey for structure and body copy.
Royal purple is the only accent and is spent deliberately — display emphasis,
the primary CTA, the stats figures, active states, and the "live" parts of the
diagrams. Everything else, including the scroll path itself, is white.

The three purples in `globals.css` are a contrast ladder against `#08090c`, not
a palette. `royal` carries white text on solid fills; `royal-mid` is safe for
large display text; `royal-soft` is the one to use for small text and icons —
`royal` at 14px would fail contrast.

## How the landing page is put together

Sections live in `src/components/landing/`, and every visual is hand-drawn SVG
in `src/components/visuals/` — no stock illustration.

### The connecting path

`ScrollPath.tsx` is the centrepiece: one continuous line that threads down the
page with a glowing node riding it at the current scroll position.

It measures the page rather than hard-coding a shape. Any element tagged
`data-path-anchor` is a point the line must pass through; the component reads
those elements' real pixel centres (re-measuring on resize and after webfonts
load) and joins them with cubic béziers whose control handles are offset only
vertically — which produces the weave and guarantees the line never travels
back upward. The rendered path is then sampled into a lookup table so a scroll
position maps to a point by **binary search on y**, not on arc length; that
keeps the node exactly level with the section it belongs to instead of drifting
on the curved stretches. The same lookup drives the stroke dash offset, so the
drawn end of the line and the node are always the same point.

To attach a new section to the line, put `data-path-anchor` on the element it
should pass through. Add `data-path-step` to an ancestor to have that section
light up as the node goes by (see the `[data-path-active]` rules in
`globals.css` — the highlight is plain CSS, so scrolling costs no re-renders).

On narrow viewports the horizontal excursion is clamped so the line stays a
gentle centre spine instead of clipping off-screen.

### Motion and `prefers-reduced-motion`

The hero gradient tracks the cursor with a lerped `requestAnimationFrame` loop,
falls back to a slow ambient drift on touch devices, and pauses entirely when
scrolled out of view.

Reduced motion is honoured throughout: the path renders fully drawn instead of
animating in, travel distances collapse to zero, and `MotionProvider` sets
Framer's `reducedMotion="user"` globally.

One trap worth knowing if you extend this: `useReducedMotion` cannot report the
real value until after mount without breaking hydration, so components must not
*structurally* branch on it. Framer writes `opacity: 0` on the first render, and
if the branch then removes the props that would animate it back, the content
stays invisible forever. Vary the transition instead of the element — see the
comments in `Reveal.tsx` and `Hero.tsx`.

## Authentication

Configured in `src/lib/auth.ts` (server) and `src/lib/auth-client.ts` (browser).

**Database.** Neon Postgres via Prisma, and nothing else — there is no local
file database and no fallback. Put your Neon *pooled* connection string in
`DATABASE_URL` (see `.env.example`), then `npm run db:migrate` to apply
`prisma/migrations`. `src/lib/prisma.ts` holds the client — Prisma 7 runs
without the Rust query engine, so it connects through the `@prisma/adapter-neon`
driver adapter over Neon's WebSocket protocol rather than a plain connection
string. WebSockets rather than HTTP because Better Auth writes a user and their
credential row in one interactive transaction, which the HTTP driver can't hold
open.

**Pooled vs direct.** The app uses the pooled host; the migration CLI uses
`DIRECT_DATABASE_URL` when it is set, because Neon's pooler is PgBouncer in
transaction mode and can't hold the session-level advisory lock
`prisma migrate` takes. That preference lives in `prisma.config.ts`.

**Schema.** `prisma/schema.prisma` owns the four Better Auth tables (`user`,
`session`, `account`, `verification`). The column names are not arbitrary —
Better Auth addresses them directly, so they have to match `getAuthTables()` in
`@better-auth/core`. Better Auth does not create or alter tables here; Prisma
migrations are the only thing that touches the schema.

**Sign-up fields.** Beyond name, email, and password, sign-up collects company,
country, and phone. These are declared twice on purpose: as
`user.additionalFields` in `src/lib/auth-options.ts`, which is what lets the
client send them and Better Auth accept them, and as columns on `User` in
`prisma/schema.prisma`. Change one and you must change the other, then run
`npm run db:migrate`. On the client, `inferAdditionalFields` gives
`signUp.email` and `useSession` the matching types.

**Password reset.** No email provider is wired up. In development the reset link
is printed to the terminal running `npm run dev` — copy it out to complete the
flow. `sendResetPassword` in `src/lib/auth-options.ts` is where a real sender
(Resend or similar) plugs in; it throws in production rather than silently
failing.

**Secrets.** `BETTER_AUTH_SECRET` is generated into `.env.local` on first run for
convenience. Set it through the real environment before deploying — rotating it
invalidates every session.

## Notes on the content

Copy is written from the product brief. The only quantitative claim made is the
6–8 week → 3–5 day review timeline; the other figures on the stats strip describe
how the system is built (six pipeline stages, findings cited to a principle)
rather than asserting unverified adoption or accuracy numbers. There is no
customer logo strip, because inventing one would imply social proof that does
not exist.
