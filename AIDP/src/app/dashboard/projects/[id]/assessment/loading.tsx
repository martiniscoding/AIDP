import { Bone, PillsSkeleton, SkeletonScreen, StatSkeleton } from "@/components/ui/Skeleton";

const FINDINGS = ["w-56", "w-44", "w-64"];

/** A project's report while its run and findings load. */
export default function ProjectAssessmentLoading() {
  return (
    <SkeletonScreen label="Loading the project assessment">
      <Bone className="mb-5 h-3.5 w-32" />

      <div className="mb-7">
        <Bone className="my-1.5 h-7 w-72" />
        <Bone className="mt-3 h-3.5 w-[26rem]" />
        {/* The designs in scope, as chips. */}
        <PillsSkeleton count={3} className="mt-3.5" />
      </div>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Bone className="h-4 w-28" />
          <Bone className="mt-2 h-3 w-64" />
        </div>
        <Bone className="h-8 w-28" />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <StatSkeleton key={index} raised />
        ))}
      </div>

      <div className="space-y-3">
        {FINDINGS.map((width, index) => (
          <div key={index} className="rounded-xl border border-line bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Bone className="h-3 w-20" />
                <Bone className={`mt-2 h-4 ${width}`} />
                <Bone className="mt-2.5 h-3 w-full" />
                <Bone className="mt-1.5 h-3 w-4/5" />
              </div>
              <Bone className="h-5 w-16 shrink-0" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonScreen>
  );
}
