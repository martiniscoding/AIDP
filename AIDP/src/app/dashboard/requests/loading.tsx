import { Bone, PageHeaderSkeleton, SkeletonScreen } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <SkeletonScreen label="Loading architecture requests">
      <PageHeaderSkeleton />
      <div className="grid gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Bone key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    </SkeletonScreen>
  );
}
