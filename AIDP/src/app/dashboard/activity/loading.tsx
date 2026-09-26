import { cn } from "@/lib/cn";
import {
  Bone,
  PillsSkeleton,
  SkeletonScreen,
  StatSkeleton,
  TableSkeleton,
  TitleSkeleton,
} from "@/components/ui/Skeleton";

const EVENTS = ["w-64", "w-48", "w-72", "w-56", "w-44"];

/** The activity board while it loads. */
export default function ActivityLoading() {
  return (
    <SkeletonScreen label="Loading activity">
      <TitleSkeleton lede={["w-[38rem]", "w-72"]} />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <StatSkeleton key={index} />
        ))}
      </div>

      <div className="mb-4 flex items-center gap-2">
        <Bone className="h-4 w-24" />
        <Bone className="h-3 w-20" />
      </div>
      <TableSkeleton columns={7} rows={4} rounded="xl" />

      <div className="mt-10 mb-4 flex flex-wrap items-center gap-3">
        <Bone className="mr-auto h-4 w-32" />
        <div className="h-8 w-60 rounded-lg border border-line bg-card" />
      </div>
      <PillsSkeleton count={4} className="mb-3" />

      <div className="rounded-xl border border-line">
        {EVENTS.map((width, index) => (
          <div
            key={index}
            className={cn("flex items-center gap-3 px-4 py-3.5", index > 0 && "border-t border-line")}
          >
            <Bone square className="size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <Bone className={cn("h-3.5", width)} />
            </div>
            <Bone square className="hidden h-5 w-20 sm:block" />
            <Bone className="h-3 w-16" />
          </div>
        ))}
      </div>
    </SkeletonScreen>
  );
}
