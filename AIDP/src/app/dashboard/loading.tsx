/**
 * The dashboard reads the session, which means a round trip to Neon on every
 * request — it can never be prefetched in full. This fallback is what makes the
 * post-sign-in redirect land immediately instead of hanging on the auth screen
 * while the session query runs.
 */
export default function DashboardLoading() {
  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-4 px-6">
      <div aria-hidden="true" className="animate-pulse">
        <div className="h-7 w-40 rounded-full bg-canvas-sunk" />
        <div className="mt-4 h-4 w-64 rounded-full bg-card" />
        <div className="mt-3 h-4 w-80 max-w-full rounded-full bg-card" />
      </div>
      <p className="sr-only" role="status">
        Loading your dashboard
      </p>
    </main>
  );
}
