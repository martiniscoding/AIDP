import { cn } from "@/lib/cn";
import { Bone, SkeletonScreen } from "@/components/ui/Skeleton";

const META = ["w-16", "w-24", "w-14", "w-20"];
const FINDINGS = ["w-56", "w-44", "w-64"];
// Depth, then title width: the outline's tree, drawn the way the page draws it.
const OUTLINE: [0 | 1, string][] = [
  [0, "w-48"],
  [1, "w-56"],
  [1, "w-40"],
  [0, "w-52"],
  [1, "w-44"],
  [1, "w-60"],
  [0, "w-36"],
];

/**
 * A document while it loads.
 *
 * The same route serves a standard and a design, and only a design has an
 * assessment — so the block under the figures is a plain heading and rows,
 * which stands in for the assessment and for the review notes alike.
 */
export default function DocumentLoading() {
  return (
    <SkeletonScreen label="Loading document">
      <Bone className="mb-6 h-3.5 w-28" />

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Bone className="my-1 h-7 w-[26rem]" />
          <div className="mt-3.5 flex flex-wrap gap-x-3.5 gap-y-2">
            {META.map((width, index) => (
              <Bone key={index} className={cn("h-3", width)} />
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <div className="h-8 w-20 rounded-full border border-line" />
          <div className="h-8 w-20 rounded-full border border-line" />
        </div>
      </div>

      <div className="mb-7 rounded-xl border border-line bg-card p-4">
        <Bone className="h-4 w-44" />
        <div className="max-w-3xl">
          <Bone className="mt-3.5 h-3 w-full" />
          <Bone className="mt-2.5 h-3 w-[85%]" />
          <Bone className="mt-2.5 h-3 w-1/2" />
        </div>
      </div>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="rounded-xl border border-line bg-card px-4 py-3">
            <Bone className="h-2.5 w-16" />
            <Bone square className="mt-3 h-6 w-10" />
          </div>
        ))}
      </div>

      <div className="mb-10">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <Bone className="h-4 w-28" />
            <Bone className="mt-2.5 h-3 w-64" />
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="h-8 w-36 rounded-full border border-line" />
            <div className="h-8 w-32 rounded-full border border-line" />
          </div>
        </div>
        <div className="space-y-2">
          {FINDINGS.map((width, index) => (
            <div
              key={index}
              className="flex items-start gap-3 rounded-xl border border-line bg-card px-4 py-3"
            >
              <Bone square className="h-5 w-20 shrink-0" />
              <div className="min-w-0 flex-1">
                <Bone className={cn("h-3.5", width)} />
                <div className="max-w-lg">
                  <Bone className="mt-2 h-3 w-full" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Bone className="mb-4 h-4 w-24" />
      <div className="border-t border-line">
        {OUTLINE.map(([depth, width], index) => (
          <div
            key={index}
            className={cn("border-b border-line-soft", depth === 1 && "pl-[22px]")}
          >
            <div
              className={cn(
                "flex items-center gap-3 py-2.5",
                depth === 1 && "border-l border-line pl-3",
              )}
            >
              <Bone className="h-2.5 w-6 shrink-0" />
              <div className="min-w-0 flex-1">
                <Bone className={cn("h-3", width)} />
              </div>
              <Bone className="h-2.5 w-14 shrink-0" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonScreen>
  );
}
