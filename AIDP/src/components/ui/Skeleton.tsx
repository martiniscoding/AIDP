import { cn } from "@/lib/cn";

/**
 * Loading placeholders, shaped like the screens they stand in for.
 *
 * Each route's loading.tsx composes these into the outline of its own page —
 * the same panels, widths and rhythm — so the real content resolves into place
 * instead of replacing something that looked nothing like it.
 *
 * Bones are ink at low alpha rather than a fixed grey, so one shape reads on a
 * white card and on the dark app shell alike. `cn` does not merge conflicting
 * classes, so variations are props here rather than overriding classNames.
 */

/** One placeholder bar, or a block with `square`. Size comes from `className`. */
export function Bone({ className, square = false }: { className?: string; square?: boolean }) {
  return (
    <div className={cn("max-w-full bg-ink/8", square ? "rounded-lg" : "rounded-full", className)} />
  );
}

/**
 * The frame every loading screen shares. The shapes pulse together — or hold
 * still for anyone who has asked for less motion — and are hidden from
 * assistive tech, which hears one status line instead.
 */
export function SkeletonScreen({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div aria-hidden="true" className="motion-safe:animate-pulse">
        {children}
      </div>
      <p role="status" className="sr-only">
        {label}
      </p>
    </>
  );
}

/** PageHeader's panel: eyebrow, title, and one lede bar per width given. */
export function PageHeaderSkeleton({ lede = ["w-[34rem]"] }: { lede?: string[] }) {
  return (
    <div className="card-sheen relative mb-5 overflow-hidden rounded-2xl border border-line bg-card px-7 py-7 shadow-card">
      <div className="header-bloom absolute inset-0" />
      <div className="relative">
        <Bone className="h-3 w-28" />
        <Bone className="mt-4 h-8 w-72" />
        {lede.map((width, index) => (
          <Bone key={index} className={cn("h-3.5", index === 0 ? "mt-5" : "mt-3", width)} />
        ))}
      </div>
    </div>
  );
}

/** The plain title-and-lede header the console pages open with. */
export function TitleSkeleton({ lede = ["w-[36rem]"] }: { lede?: string[] }) {
  return (
    <div className="mb-8">
      <Bone className="my-2 h-7 w-44" />
      {lede.map((width, index) => (
        <Bone key={index} className={cn("h-3.5", index === 0 ? "mt-4" : "mt-2", width)} />
      ))}
    </div>
  );
}

/** A figure tile: icon and label, the number, and a hint beneath. */
export function StatSkeleton({ raised = false }: { raised?: boolean }) {
  return (
    <div
      className={cn(
        "border border-line bg-card",
        raised ? "rounded-2xl p-5 shadow-card" : "rounded-xl p-4",
      )}
    >
      <div className="flex items-center gap-2">
        <Bone square className="size-4" />
        <Bone className="h-3 w-24" />
      </div>
      <Bone square className={cn("h-7 w-16", raised ? "mt-3.5" : "mt-3")} />
      <Bone className="mt-2 h-3 w-32" />
    </div>
  );
}

const CELL = ["w-36", "w-28", "w-44", "w-32", "w-40"];

/** A bordered table: a header band, then rows led by a name-and-detail cell. */
export function TableSkeleton({
  columns,
  rows = 5,
  rounded = "2xl",
}: {
  columns: number;
  rows?: number;
  rounded?: "xl" | "2xl";
}) {
  const rest = Array.from({ length: columns - 1 }, (_, index) => index);

  return (
    <div
      className={cn(
        "overflow-hidden border border-line",
        rounded === "xl" ? "rounded-xl" : "rounded-2xl",
      )}
    >
      <div className="flex items-center gap-6 border-b border-line bg-card px-4 py-3">
        <div className="min-w-0 flex-[2]">
          <Bone className="h-2.5 w-16" />
        </div>
        {rest.map((index) => (
          <div key={index} className="flex min-w-0 flex-1 justify-end">
            <Bone className="h-2.5 w-14" />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="flex items-center gap-6 border-b border-line-soft px-4 py-3 last:border-0"
        >
          <div className="min-w-0 flex-[2]">
            <Bone className={cn("h-3.5", CELL[row % CELL.length])} />
            <Bone className="mt-2 h-3 w-48" />
          </div>
          {rest.map((index) => (
            <div key={index} className="flex min-w-0 flex-1 justify-end">
              <Bone className="h-3 w-12" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const PILL = ["w-24", "w-20", "w-28", "w-[4.5rem]", "w-24"];

/** A row of outlined filter pills. `className` is for spacing around the row. */
export function PillsSkeleton({ count, className }: { count: number; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className={cn("h-7 rounded-full border border-line", PILL[index % PILL.length])}
        />
      ))}
    </div>
  );
}

/** UploadZone's drop target, at rest: centred, with the button it leads with. */
export function DropZoneSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3.5 rounded-2xl border border-line bg-canvas-sunk px-4 py-10">
      <Bone square className="h-12 w-16" />
      <div className="flex flex-col items-center gap-2.5">
        <div className="h-10 w-52 rounded-full bg-royal/40" />
        <Bone className="h-3 w-56" />
      </div>
    </div>
  );
}
