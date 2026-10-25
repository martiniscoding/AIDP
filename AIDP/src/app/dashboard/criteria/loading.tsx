import { Bone, PageHeaderSkeleton, SkeletonScreen } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <SkeletonScreen label="Loading the significance criteria">
      <PageHeaderSkeleton />
      <div className="grid gap-2">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <Bone key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    </SkeletonScreen>
  );
}
