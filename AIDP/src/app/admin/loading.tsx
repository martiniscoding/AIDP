import { cn } from "@/lib/cn";
import {
  Bone,
  SkeletonScreen,
  StatSkeleton,
  TitleSkeleton,
} from "@/components/ui/Skeleton";

const COMPANIES = ["w-48", "w-60", "w-40"];

/** The operator's company list while it loads. The layout's notice stays put above it. */
export default function AdminLoading() {
  return (
    <SkeletonScreen label="Loading companies">
      <TitleSkeleton lede={["w-64"]} />

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <StatSkeleton key={index} raised />
        ))}
      </div>

      <div className="space-y-2.5">
        {COMPANIES.map((width, index) => (
          <div key={index} className="rounded-2xl border border-line bg-card p-5 shadow-card">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <Bone className={cn("mt-0.5 h-4", width)} />
                <Bone className="mt-2.5 h-3 w-72" />
                <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
                  {[0, 1, 2, 3].map((pair) => (
                    <Bone key={pair} className="h-3 w-20" />
                  ))}
                </div>
              </div>
              <div className="hidden flex-col items-end sm:flex">
                <Bone className="h-3 w-24" />
                <Bone className="mt-2 h-3 w-20" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </SkeletonScreen>
  );
}
