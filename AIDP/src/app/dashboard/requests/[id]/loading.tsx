import { Bone, PageHeaderSkeleton, SkeletonScreen } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <SkeletonScreen label="Loading this request">
      <PageHeaderSkeleton />
      <div className="rounded-xl border border-line bg-card">
        <div className="flex gap-2 border-b border-line px-3 py-2.5">
          {[0, 1, 2, 3].map((i) => (
            <Bone key={i} className="h-6 w-24 rounded-full" />
          ))}
        </div>
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Bone key={i} className="h-14" />
          ))}
        </div>
      </div>
    </SkeletonScreen>
  );
}
