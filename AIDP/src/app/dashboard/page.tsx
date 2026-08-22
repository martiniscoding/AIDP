import Link from "next/link";
import { ArrowRight, BookMarked, FolderOpen, Gavel } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireWorkspace } from "@/lib/access/gate";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/ui/PageHeader";

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
      <PageHeader
        eyebrow={organisation.name}
        title={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        lede={next}
      />

      {/* The workspace in four figures. This is the page's deep block: it is
          the one element that is always present whatever state the workspace
          is in, so it is the one that can carry the weight. It also takes the
          counts off the cards below, which were repeating them in body text. */}
      <section
        aria-label="Workspace at a glance"
        className="relative mb-5 overflow-hidden rounded-2xl bg-deep px-7 py-6 shadow-pop"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(70% 140% at 12% 0%, rgba(139,92,246,0.42), rgba(124,58,237,0.10) 48%, transparent 72%)",
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-[8%] top-0 h-px bg-linear-to-r from-transparent via-white/30 to-transparent"
        />
        <dl className="relative grid grid-cols-2 gap-y-6 sm:grid-cols-4">
          <Stat label="Standards" value={standards} />
          <Stat label="Projects" value={projects} />
          <Stat label="Designs assessed" value={designs} accent />
          <Stat label="Decisions" value={decisions} />
        </dl>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card
          href="/dashboard/documents"
          icon={<BookMarked size={19} strokeWidth={1.9} />}
          title="Reference Library"
          blurb="The clauses every assessment is measured against."
          lead={standards === 0}
        />
        <Card
          href="/dashboard/projects"
          icon={<FolderOpen size={19} strokeWidth={1.9} />}
          title="My Projects"
          blurb="Pieces of work, and the designs being assessed inside them."
          lead={standards > 0 && projects === 0}
          note={runs > 0 ? `${runs} assessment${runs === 1 ? "" : "s"} run` : undefined}
        />
        <Card
          href="/dashboard/decisions"
          icon={<Gavel size={19} strokeWidth={1.9} />}
          title="Decisions"
          blurb="Rulings this organisation has settled, applied to future assessments."
        />
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  /** The figure that says whether the pipeline is actually running. */
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="order-2 text-[11.5px] font-medium uppercase tracking-[0.13em] text-white/55">
        {label}
      </dt>
      <dd
        className={cn(
          "order-1 font-display text-[2.1rem] font-medium leading-none tracking-[-0.04em] tabular-nums",
          value === 0 ? "text-white/40" : accent ? "text-royal-light" : "text-white",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Card({
  href,
  icon,
  title,
  blurb,
  lead,
  note,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  blurb: string;
  /** The one thing to do next, given the state of the workspace. */
  lead?: boolean;
  note?: string;
}) {
  return (
    // Which card leads is decided by the state of the workspace above, so the
    // emphasis always lands on the thing to do next rather than on a fixed
    // tile. It is an accent border and a heavier sheen rather than a deep
    // fill: the stat band above is already this page's dark block, and two
    // of them competing reads as decoration instead of hierarchy.
    <Link
      href={href}
      className={cn(
        "group card-sheen relative block overflow-hidden rounded-2xl border bg-card p-6",
        "transition-[border-color,transform,box-shadow] duration-300",
        "hover:-translate-y-0.5 hover:shadow-card-hover",
        lead
          ? "border-royal/45 shadow-card-hover"
          : "border-line shadow-card hover:border-line-strong",
      )}
    >
      <div className="relative flex items-start gap-4">
        <span
          className={cn(
            "grid size-11 shrink-0 place-items-center rounded-xl border transition-colors",
            lead
              ? "border-transparent bg-royal text-white"
              : "border-royal-mid/25 bg-royal/10 text-royal group-hover:bg-royal/15",
          )}
        >
          {icon}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">
              {title}
            </h2>
            {lead ? (
              <span className="rounded-full bg-royal-tint px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-royal-deep">
                Start here
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink/64">{blurb}</p>
          {note ? (
            <p className="mt-3 text-[12.5px] tabular-nums text-ink/62">{note}</p>
          ) : null}
        </div>

        <ArrowRight
          size={15}
          className="mt-1 shrink-0 text-ink/40 transition-transform duration-300 group-hover:translate-x-0.5"
        />
      </div>
    </Link>
  );
}
