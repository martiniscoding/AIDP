import Link from "next/link";
import { ArrowRight, BookMarked, FolderOpen, Gavel } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireWorkspace } from "@/lib/access/gate";
import { cn } from "@/lib/cn";

/**
 * Where somebody lands, and what they should do next.
 *
 * Built around the pipeline the product actually runs — standards in, designs
 * measured against them, rulings recorded — rather than around a form to fill
 * in. The card that is *not* yet satisfied leads, because the useful thing to
 * tell someone is the next step, not a summary of the steps they have taken.
 */
export default async function DashboardPage() {
  // `requireWorkspace` rather than a session lookup, and rather than the
  // throwing `requireAccess`: a page renders concurrently with its layout, so
  // two thrown refusals race each other. This one redirects instead, so the
  // outcome is the same every time.
  const { user, organisation, isOwner } = await requireWorkspace();

  const [standards, designs, decisions, runs, projects] = await Promise.all([
    prisma.document.count({
      where: { organisationId: organisation.id, role: "reference" },
    }),
    prisma.document.count({
      where: { organisationId: organisation.id, role: "assessed" },
    }),
    prisma.decision.count({
      where: { organisationId: organisation.id, status: "active" },
    }),
    prisma.assessmentRun.count({ where: { organisationId: organisation.id } }),
    prisma.project.count({ where: { organisationId: organisation.id, status: "active" } }),
  ]);

  const firstName = (user.name || "").split(" ")[0];

  // Standards first: without them there is nothing to measure against, and a
  // member cannot fix that themselves — only an administrator can add one.
  const next =
    standards === 0
      ? isOwner
        ? "Start by adding the standards an assessment should measure against."
        : "No standards have been added yet. An administrator needs to add them before anything can be assessed."
      : projects === 0
        ? "Your standards are indexed. Open a project and submit the designs that belong to it."
        : "Open a project to submit a design, or pick up a report where you left off.";

  return (
    <>
      <header className="mb-9">
        <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.14em] text-royal">
          {organisation.name}
        </p>
        <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-ink">
          {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] text-ink/68">{next}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card
          href="/dashboard/documents"
          icon={<BookMarked size={19} strokeWidth={1.9} />}
          title="Standards library"
          blurb="The clauses every assessment is measured against."
          count={standards}
          unit="standard"
          lead={standards === 0}
        />
        <Card
          href="/dashboard/projects"
          icon={<FolderOpen size={19} strokeWidth={1.9} />}
          title="Projects"
          blurb="Pieces of work, and the designs being assessed inside them."
          count={projects}
          unit="project"
          lead={standards > 0 && projects === 0}
          note={
            designs > 0
              ? `${designs} design${designs === 1 ? "" : "s"}, ${runs} assessment${runs === 1 ? "" : "s"}`
              : undefined
          }
        />
        <Card
          href="/dashboard/decisions"
          icon={<Gavel size={19} strokeWidth={1.9} />}
          title="Decisions"
          blurb="Rulings this organisation has settled, applied to future assessments."
          count={decisions}
          unit="decision"
        />
      </div>
    </>
  );
}

function Card({
  href,
  icon,
  title,
  blurb,
  count,
  unit,
  lead,
  note,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  blurb: string;
  count: number;
  unit: string;
  /** The one thing to do next, given the state of the workspace. */
  lead?: boolean;
  note?: string;
}) {
  return (
    // The lead card is the deep one. Which card leads is decided by the state
    // of the workspace above, so the strongest surface on the page always
    // lands on the thing to do next rather than on a fixed tile.
    <Link
      href={href}
      className={cn(
        "group relative block overflow-hidden rounded-2xl border p-6",
        "transition-[border-color,transform,box-shadow] duration-300 hover:-translate-y-0.5",
        lead
          ? "border-transparent bg-deep shadow-pop"
          : "border-line bg-card shadow-card hover:border-line-strong hover:shadow-card-hover",
      )}
    >
      {lead && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(80% 120% at 100% 0%, rgba(139,92,246,0.45), transparent 62%)",
          }}
        />
      )}

      <div className="relative flex items-start gap-4">
        <span
          className={cn(
            "grid size-11 shrink-0 place-items-center rounded-xl border",
            lead
              ? "border-white/25 bg-white/10 text-royal-light"
              : "border-royal-mid/30 bg-royal/10 text-royal",
          )}
        >
          {icon}
        </span>

        <div className="min-w-0 flex-1">
          <h2
            className={cn(
              "font-display text-[17px] font-semibold tracking-tight",
              lead ? "text-white" : "text-ink",
            )}
          >
            {title}
          </h2>
          <p
            className={cn(
              "mt-1 text-[13px] leading-relaxed",
              lead ? "text-white/70" : "text-ink/64",
            )}
          >
            {blurb}
          </p>
          <p
            className={cn(
              "mt-3 text-[13px] tabular-nums",
              lead ? "text-white/85" : "text-ink/80",
            )}
          >
            {count} {unit}
            {count === 1 ? "" : "s"}
            {note ? (
              <span className={lead ? "text-white/55" : "text-ink/62"}>
                {" "}
                · {note}
              </span>
            ) : null}
          </p>
        </div>

        <ArrowRight
          size={15}
          className={cn(
            "mt-1 shrink-0 transition-transform duration-300 group-hover:translate-x-0.5",
            lead ? "text-white/60" : "text-ink/40",
          )}
        />
      </div>
    </Link>
  );
}
