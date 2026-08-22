/**
 * Instant fallback for every auth screen.
 *
 * Next wraps the page segment in a Suspense boundary when this file exists, so
 * a click on "Sign in" or "Create account" swaps the view immediately instead
 * of leaving the previous page on screen until the destination is ready. It
 * also lets the router *partially prefetch* these routes — the shell and this
 * fallback can be fetched ahead of the click.
 *
 * The shape deliberately mirrors AuthCard's geometry (same max width, radius,
 * padding and internal rhythm) so the real card resolves into place rather than
 * replacing something that looked nothing like it.
 */
function Bar({ className }: { className?: string }) {
  return <div className={`rounded-full bg-canvas-sunk ${className}`} />;
}

export default function AuthLoading() {
  return (
    <div className="w-full max-w-[440px]">
      {/* Decorative: the announcement below is what reaches assistive tech. */}
      <div aria-hidden="true" className="edge-light relative overflow-hidden rounded-2xl border border-line bg-card p-7 shadow-[0_1px_2px_-1px_rgba(60,50,40,0.10),0_18px_50px_-24px_rgba(60,50,40,0.20),0_40px_90px_-60px_rgba(124,58,237,0.35)] backdrop-blur-2xl sm:p-9">
        <div className="animate-pulse">
          {/* Tab switch */}
          <div className="mb-7 grid grid-cols-2 gap-1 rounded-full border border-line bg-canvas-sunk p-1">
            <div className="h-9 rounded-full bg-canvas-sunk" />
            <div className="h-9 rounded-full" />
          </div>

          {/* Title + subtitle */}
          <Bar className="h-6 w-1/2" />
          <Bar className="mt-3.5 h-3.5 w-4/5" />

          {/* Two fields and a submit */}
          <div className="mt-8 flex flex-col gap-4">
            <div>
              <Bar className="h-3 w-24" />
              <div className="mt-2 h-11 rounded-xl border border-line bg-card" />
            </div>
            <div>
              <Bar className="h-3 w-20" />
              <div className="mt-2 h-11 rounded-xl border border-line bg-card" />
            </div>
            <div className="mt-1 h-13 rounded-full bg-royal/40" />
          </div>
        </div>
      </div>

      <p className="sr-only" role="status">
        Loading
      </p>
    </div>
  );
}
