import Link from "next/link";
import { AlertTriangle, ArrowRight, BookMarked, FileSearch } from "lucide-react";
import { cn } from "@/lib/cn";
import { listDocuments, PIPELINE, STATUS_LABEL, isTerminal } from "@/lib/ingest/documents";
import { requireWorkspace } from "@/lib/access/gate";
import { PipelineWatcher } from "./PipelineWatcher";
import { ReadyTick, UploadZone } from "./UploadZone";

export const dynamic = "force-dynamic";

type Doc = Awaited<ReturnType<typeof listDocuments>>[number];

export default async function DocumentsPage() {
  // `requireWorkspace` rather than a session lookup, and rather than the
  // throwing `requireAccess`: a page renders concurrently with its layout, so
  // two thrown refusals race each other. This one redirects instead, so the
  // outcome is the same every time.
  const { user, organisation } = await requireWorkspace();
  const documents = await listDocuments(user.id, organisation.id);

  const references = documents.filter((d) => d.role !== "assessed");
  const assessed = documents.filter((d) => d.role === "assessed");
  const inFlight = documents.some((d) => !isTerminal(d.status));

  return (
    <>
      <PipelineWatcher active={inFlight} />

      <header className="mb-9">
        <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.14em] text-royal-soft">
          {organisation.name}
        </p>
        <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-white">
          Standards library
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/50">
          The documents an assessment measures against, and the designs measured
          against them.
        </p>
      </header>

      {/*
        Two groups, not one list. Reference and assessed are the whole product —
        one is the yardstick, the other is the thing being measured — and a flat
        list reduced that to a small chip nobody reads. Splitting them also
        retires the role chooser: each group is its own drop target, so the role
        is implied by where you drop rather than set by a mode switch that fails
        silently when it is wrong.
      */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Group
          icon={<BookMarked size={15} strokeWidth={1.9} />}
          title="Reference standards"
          blurb="What an assessment measures against."
          documents={references}
          uploadLabel="Add reference standards"
          role="reference"
          empty="No standards yet. These define what good looks like."
        />
        <Group
          icon={<FileSearch size={15} strokeWidth={1.9} />}
          title="Designs to assess"
          blurb="Submissions checked against every clause."
          documents={assessed}
          uploadLabel="Add a design to assess"
          role="assessed"
          empty="No submissions yet. Upload a solution design to assess it."
        />
      </div>
    </>
  );
}

function Group({
  icon,
  title,
  blurb,
  documents,
  uploadLabel,
  role,
  empty,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
  documents: Doc[];
  uploadLabel: string;
  role: "reference" | "assessed";
  empty: string;
}) {
  const chunks = documents.reduce((n, d) => n + d._count.chunks, 0);
  const review = documents.reduce((n, d) => n + d.issues.high, 0);

  // Same light logic as the drop target below: the yardstick is lit from
  // above, the thing being measured from below. Held to a fraction of the
  // aperture's intensity — the panel is the room, not the event in it.
  const wash =
    role === "reference"
      ? "radial-gradient(90% 60% at 50% 0%, rgba(124,58,237,0.10), transparent 70%)"
      : "radial-gradient(90% 60% at 50% 100%, rgba(124,58,237,0.09), transparent 70%)";

  return (
    <section className="ring-gradient relative overflow-hidden rounded-2xl bg-white/[0.015] p-4 sm:p-5">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: wash }}
      />
      <header className="relative mb-3.5 flex items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-white/12 bg-white/[0.04] text-white/50">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[15.5px] font-semibold tracking-[-0.01em] text-white">
            {title}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-white/40">{blurb}</p>
        </div>
        {documents.length > 0 && (
          <span className="shrink-0 text-right text-[11.5px] leading-tight text-white/35">
            <span className="text-white/70">{documents.length}</span> doc
            {documents.length === 1 ? "" : "s"}
            <br />
            {chunks} chunks
          </span>
        )}
      </header>

      {documents.length === 0 ? (
        <p className="relative mb-3 rounded-lg border border-white/[0.07] bg-white/[0.015] px-3.5 py-5 text-center text-[12.5px] text-white/35">
          {empty}
        </p>
      ) : (
        <ul className="relative mb-3 space-y-1.5">
          {documents.map((doc) => (
            <li key={doc.id}>
              <Row doc={doc} />
            </li>
          ))}
        </ul>
      )}

      {review > 0 && (
        <p className="relative mb-3 inline-flex items-center gap-1.5 text-[12px] text-amber-300/80">
          <AlertTriangle size={12} />
          {review} document{review === 1 ? "" : "s"} to review
        </p>
      )}

      <div className="relative">
        <UploadZone role={role} label={uploadLabel} />
      </div>
    </section>
  );
}

function Row({ doc }: { doc: Doc }) {
  const meta = [
    doc.pageCount != null ? `${doc.pageCount}pp` : null,
    doc._count.chunks > 0 ? `${doc._count.chunks} chunks` : null,
    doc.sensitivity,
  ].filter(Boolean);

  return (
    <Link
      href={`/dashboard/documents/${doc.id}`}
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5",
        "transition-[border-color,background-color] duration-200",
        "hover:border-white/20 hover:bg-white/[0.045]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-white/90">
          {doc.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[11.5px] text-white/35">
          {meta.map((m) => (
            <span key={m as string}>{m}</span>
          ))}
          {doc.issues.high > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-300/75">
              <AlertTriangle size={10} />
              {doc.issues.high}
            </span>
          )}
        </span>
      </span>

      <Status doc={doc} />

      <ArrowRight
        size={14}
        className="shrink-0 text-white/15 transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:text-white/50"
      />
    </Link>
  );
}

/**
 * Progress while there is progress, and nothing once there isn't.
 *
 * The rail used to render for every document regardless of state, so a shelf of
 * finished documents each carried a four-segment bar that would never move
 * again — pure noise, and it read as though something were still happening.
 */
function Status({ doc }: { doc: Doc }) {
  if (doc.status === "failed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/[0.08] px-2 py-0.5 text-[11px] text-amber-300">
        <AlertTriangle size={10} />
        Failed
      </span>
    );
  }

  if (doc.status === "ready") return <ReadyTick />;

  const index = PIPELINE.indexOf(doc.status as (typeof PIPELINE)[number]);
  // One continuous rail rather than four separate pips. The stages are a real
  // sequence — parse, chunk, embed — so distance travelled is the honest
  // encoding, and the leading edge is where the work currently is.
  const travelled = Math.max(0, index) / (PIPELINE.length - 1);

  return (
    <span className="flex shrink-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className="relative hidden h-1 w-16 overflow-hidden rounded-full bg-white/[0.09] sm:block"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-linear-to-r from-royal to-royal-soft transition-[width] duration-700 ease-out"
          style={{ width: `${Math.max(travelled * 100, 6)}%` }}
        />
        {/* The head of the rail glows where the pipeline is working. */}
        <span
          className="absolute inset-y-0 w-2 rounded-full bg-white/80 blur-[2px] transition-[left] duration-700 ease-out"
          style={{ left: `calc(${Math.max(travelled * 100, 6)}% - 6px)` }}
        />
      </span>
      <span className="text-[11.5px] whitespace-nowrap text-white/50">
        {STATUS_LABEL[doc.status] ?? doc.status}
      </span>
    </span>
  );
}
