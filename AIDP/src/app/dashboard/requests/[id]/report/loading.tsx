import { Bone, PageHeaderSkeleton, SkeletonScreen } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <SkeletonScreen label="Loading the review report">
      <PageHeaderSkeleton />
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Bone className="h-28 rounded-xl" />
        <Bone className="h-28 rounded-xl" />
      </div>
      <Bone className="mb-4 h-14 rounded-xl" />
      <Bone className="h-64 rounded-xl" />
    </SkeletonScreen>
  );
}
