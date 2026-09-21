import { cn } from "@/lib/cn";
import { Bone, PageHeaderSkeleton, SkeletonScreen } from "@/components/ui/Skeleton";

const PROJECTS = ["w-56", "w-44", "w-64"];

/**
 * The workspace home while its projects load.
 *
 * The dashboard reads the session, which means a round trip to Neon on every
 * request — it can never be prefetched in full. This fallback is what makes the
 * post-sign-in redirect land immediately instead of hanging on the auth screen
 * while the session query runs. Shaped like the project list it gives way to.
 */
export default function DashboardLoading() {
  return (
    <SkeletonScreen label="Loading your projects">
      <PageHeaderSkeleton />

      <div className="mx-auto mb-6 h-11 w-40 rounded-full bg-royal/40" />

      <div className="space-y-2.5">
        {PROJECTS.map((width, index) => (
          <div
            key={index}
            className="card-sheen rounded-2xl border border-line bg-card p-5 shadow-card"
          >
            <div className="flex items-start gap-4">
              <Bone square className="size-9 shrink-0" />
              <div className="min-w-0 flex-1">
                <Bone className={cn("mt-0.5 h-4", width)} />
                <Bone className="mt-2.5 h-3 w-80" />
                <div className="mt-4 flex gap-5">
                  <Bone className="h-3 w-20" />
                  <Bone className="h-3 w-28" />
                </div>
              </div>
              <div className="hidden flex-col items-end sm:flex">
                <Bone className="h-3 w-32" />
                <Bone className="mt-2 h-3 w-20" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </SkeletonScreen>
  );
}
