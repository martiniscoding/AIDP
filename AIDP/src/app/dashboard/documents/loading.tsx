import { cn } from "@/lib/cn";
import {
  Bone,
  DropZoneSkeleton,
  PageHeaderSkeleton,
  SkeletonScreen,
} from "@/components/ui/Skeleton";

const DOCUMENTS = ["w-64", "w-52", "w-72"];

/** The Reference Library while its standards load. */
export default function DocumentsLoading() {
  return (
    <SkeletonScreen label="Loading the reference library">
      <PageHeaderSkeleton lede={["w-[36rem]", "w-72"]} />

      <div className="ring-gradient relative overflow-hidden rounded-2xl bg-card p-4 sm:p-5">
        <div className="mb-3.5 flex items-start gap-3">
          <Bone square className="mt-0.5 size-7 shrink-0" />
          <div className="min-w-0 flex-1">
            <Bone className="mt-0.5 h-4 w-44" />
            <Bone className="mt-2 h-3 w-56" />
          </div>
          <div className="flex flex-col items-end">
            <Bone className="h-3 w-12" />
            <Bone className="mt-1.5 h-3 w-16" />
          </div>
        </div>

        <div className="mb-3 space-y-1.5">
          {DOCUMENTS.map((width, index) => (
            <div
              key={index}
              className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <Bone className={cn("h-3.5", width)} />
                <Bone className="mt-2 h-2.5 w-36" />
              </div>
              <Bone className="size-5 shrink-0" />
            </div>
          ))}
        </div>

        <DropZoneSkeleton />
      </div>

      <div className="card-sheen mt-4 flex items-center gap-4 rounded-2xl border border-line bg-card p-5 shadow-card">
        <Bone square className="size-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <Bone className="h-3.5 w-44" />
          <Bone className="mt-2 h-3 w-64" />
        </div>
      </div>
    </SkeletonScreen>
  );
}
