import { cn } from "@/lib/cn";
import { Bone, DropZoneSkeleton, SkeletonScreen } from "@/components/ui/Skeleton";

const DESIGNS = ["w-60", "w-48"];
const CHIPS = ["w-28", "w-20", "w-[4.5rem]", "w-28", "w-24"];

/** One project while its designs and their results load. */
export default function ProjectLoading() {
  return (
    <SkeletonScreen label="Loading project">
      <Bone className="mb-5 h-3.5 w-24" />

      <div className="mb-7">
        <Bone className="my-1.5 h-7 w-72" />
        <Bone className="mt-3.5 h-3.5 w-[30rem]" />
        <Bone className="mt-3 h-3 w-60" />
      </div>

      <div className="mt-7">
        <div className="mb-3.5 flex items-center gap-2">
          <Bone className="h-4 w-20" />
          <Bone className="h-3 w-4" />
        </div>

        <div className="mb-4 space-y-3">
          {DESIGNS.map((width, index) => (
            <div key={index} className="overflow-hidden rounded-xl border border-line bg-card">
              <div className="flex items-start gap-3 p-4">
                <Bone square className="mt-0.5 size-8 shrink-0" />
                <div className="min-w-0 flex-1">
                  <Bone className={cn("h-3.5", width)} />
                  <Bone className="mt-2 h-3 w-32" />
                </div>
                <Bone className="h-3 w-20" />
              </div>

              <div className="border-t border-line bg-canvas/40 px-4 pt-3.5 pb-4">
                <div className="flex items-center justify-between gap-3">
                  <Bone className="h-3.5 w-32" />
                  <Bone className="hidden h-3 w-48 sm:block" />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {CHIPS.map((chip, chipIndex) => (
                    <div key={chipIndex} className={cn("h-8 rounded-lg border border-line", chip)} />
                  ))}
                </div>
                <Bone className="mt-3.5 h-3 w-32" />
              </div>
            </div>
          ))}
        </div>

        <DropZoneSkeleton />
      </div>
    </SkeletonScreen>
  );
}
