import { Bone, SkeletonScreen, TableSkeleton } from "@/components/ui/Skeleton";

/** One company's people and usage while they load. */
export default function OrganisationLoading() {
  return (
    <SkeletonScreen label="Loading company">
      <Bone className="mb-5 h-3.5 w-28" />

      <div className="mb-8">
        <Bone className="my-1.5 h-7 w-64" />
        <Bone className="mt-3 h-3.5 w-[28rem]" />
      </div>

      <div className="mb-4 flex items-center gap-2">
        <Bone className="h-4 w-16" />
        <Bone className="h-3 w-5" />
      </div>
      <TableSkeleton columns={4} rows={5} />

      <Bone className="mt-9 mb-4 h-4 w-32" />
      <div className="grid gap-2 sm:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="flex items-center justify-between rounded-xl border border-line px-3.5 py-3"
          >
            <Bone className="h-3 w-20" />
            <Bone className="h-3 w-28" />
          </div>
        ))}
      </div>
    </SkeletonScreen>
  );
}
