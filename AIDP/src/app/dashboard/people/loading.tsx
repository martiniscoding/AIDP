import {
  Bone,
  PillsSkeleton,
  SkeletonScreen,
  StatSkeleton,
  TableSkeleton,
  TitleSkeleton,
} from "@/components/ui/Skeleton";

/** The roster and spend while they load. */
export default function PeopleLoading() {
  return (
    <SkeletonScreen label="Loading people">
      <TitleSkeleton lede={["w-[38rem]", "w-64"]} />

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <StatSkeleton key={index} raised />
        ))}
      </div>

      <div className="mb-2 flex items-center gap-4 rounded-2xl border border-dashed border-line bg-card p-6">
        <Bone square className="size-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <Bone className="h-3.5 w-40" />
          <div className="max-w-md">
            <Bone className="mt-2.5 h-3 w-full" />
          </div>
        </div>
        <div className="hidden h-8 w-28 rounded-full border border-line sm:block" />
      </div>

      <div className="mt-8">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Bone className="mr-auto h-4 w-32" />
          <div className="h-8 w-60 rounded-lg border border-line bg-card" />
          <div className="h-8 w-32 rounded-lg border border-line" />
        </div>
        <PillsSkeleton count={5} className="mb-3" />
        <TableSkeleton columns={4} rows={5} />
      </div>
    </SkeletonScreen>
  );
}
