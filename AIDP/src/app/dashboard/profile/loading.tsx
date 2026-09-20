import { cn } from "@/lib/cn";
import { Bone, SkeletonScreen, TitleSkeleton } from "@/components/ui/Skeleton";

const LABELS = ["w-24", "w-16", "w-28", "w-24", "w-24", "w-16"];

/** The company profile form while it loads. */
export default function ProfileLoading() {
  return (
    <SkeletonScreen label="Loading company profile">
      <TitleSkeleton lede={["w-80"]} />

      <div className="rounded-2xl border border-line bg-card p-5 shadow-card sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {LABELS.map((width, index) => (
            <div key={index}>
              <Bone className={cn("mb-2 h-2.5", width)} />
              <div className="h-[34px] rounded-lg border border-line" />
            </div>
          ))}
        </div>
        <Bone className="mt-4 mb-2 h-2.5 w-14" />
        <div className="h-20 rounded-lg border border-line" />
        <Bone className="mt-5 h-8 w-32" />
      </div>

      <Bone className="mt-4 h-3 w-80" />
    </SkeletonScreen>
  );
}
