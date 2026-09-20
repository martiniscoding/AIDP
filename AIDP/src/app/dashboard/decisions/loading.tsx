import { cn } from "@/lib/cn";
import {
  Bone,
  PageHeaderSkeleton,
  PillsSkeleton,
  SkeletonScreen,
} from "@/components/ui/Skeleton";

const DECISIONS = ["w-56", "w-72", "w-48"];

/** The decision register while it loads. */
export default function DecisionsLoading() {
  return (
    <SkeletonScreen label="Loading decisions">
      <PageHeaderSkeleton lede={["w-[36rem]", "w-80"]} />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <PillsSkeleton count={3} />
          <Bone className="ml-auto h-8 w-40" />
        </div>

        <div className="space-y-2.5">
          {DECISIONS.map((width, index) => (
            <div
              key={index}
              className="card-sheen rounded-xl border border-line bg-card p-4 shadow-card"
            >
              <div className="flex items-start gap-2.5">
                <Bone square className="h-6 w-20 shrink-0" />
                <div className="min-w-0 flex-1">
                  <Bone className={cn("mt-1 h-3.5", width)} />
                  <Bone className="mt-2 h-3 w-32" />
                </div>
              </div>
              <Bone className="mt-3.5 h-3 w-full" />
              <Bone className="mt-2 h-3 w-4/5" />
              <div className="mt-4 flex gap-3">
                <Bone className="h-2.5 w-24" />
                <Bone className="h-2.5 w-20" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </SkeletonScreen>
  );
}
