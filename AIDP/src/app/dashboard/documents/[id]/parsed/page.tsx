import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AlertTriangle, ArrowLeft, ImageIcon, Info, Table2 } from "lucide-react";
import { auth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { getDocument, isTerminal, STATUS_LABEL } from "@/lib/ingest/documents";
import { NotAMember, requireMembership } from "@/lib/ingest/org";
import { canManageStandards } from "@/lib/access/roles";
import { setAside } from "@/lib/ingest/rules";
import { Figures, type FigureView } from "../Figures";
import { SetAside } from "../SetAside";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Parsed content",
  description: "What the pipeline read out of a document: its structure, tables, figures and notes.",
};

/**
 * What the pipeline made of a document, on a page of its own.
 *
 * All of this used to sit under the report, where it pushed the findings down a
 * screen and answered a question nobody had asked yet. It is the evidence
 * *behind* the report rather than part of it: which sections were found, where
 * they were cut, what came out as a table or a figure, and what the parse itself
 * flagged. A reviewer wants it when a finding looks wrong, and never otherwise —
 * so the report links to it, in its own tab, and stays about the assessment.
 *
 * The same access check as the report. A document in someone else's
 * organisation is indistinguishable from one that does not exist.
 */
export default async function ParsedPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const { id } = await params;

  let document;
  try {
    document = await getDocument(session.user.id, id);
  } catch (error) {
    if (error instanceof NotAMember) notFound();
    throw error;
  }
  if (!document) notFound();

  const membership = await requireMembership(session.user.id, document.organisationId);
  const mayChange = document.role === "assessed" || canManageStandards(membership.role);

  const clauses = document.sections.reduce((n, s) => n + s.clauses.length, 0);
  const tables = document.sections.reduce((n, s) => n + s.tables.length, 0);
  const setAsideView =
    document.role === "reference" ? await setAside(session.user.id, document.id) : null;
  const figureViews: FigureView[] = document.sections
    .flatMap((s) =>
      s.figures.map((f) => ({
        id: f.id,
        page: f.page,
        caption: f.caption,
        description: f.description,
        correctedDescription: f.correctedDescription,
        reviewState: f.reviewState,
        complexity: f.complexity,
        headingPath: s.headingPath,
      })),
    )
    .sort(
      (a, b) =>
        Number(a.reviewState !== "pending") - Number(b.reviewState !== "pending") ||
        b.complexity - a.complexity,
    );
  const high = document.issues.filter((i) => i.severity === "high");
  const other = document.issues.filter((i) => i.severity !== "high");

  return (
    <>
      <Link
        href={`/dashboard/documents/${document.id}`}
        className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-ink/66 transition-colors hover:text-ink"
      >
        <ArrowLeft size={14} />
        {document.title}
      </Link>

      <header className="mb-8">
        <h1 className="font-display text-[27px] font-semibold leading-tight tracking-[-0.02em] text-ink">
          Parsed content
        </h1>
        <p className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-ink/64">
          <span className="text-ink/72">{document.title}</span>
          <span>{STATUS_LABEL[document.status] ?? document.status}</span>
          {document.pageCount != null && <span>{document.pageCount} pages</span>}
          {document.profile && <span>{document.profile}</span>}
        </p>
      </header>

      {!isTerminal(document.status) && (
        <p className="mb-6 rounded-xl border border-line bg-card px-4 py-3 text-[13px] text-ink/70">
          This document is still being read, so what follows is as far as the pipeline has got.
        </p>
      )}

      <dl className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sections" value={document.sections.length} />
        <Stat label="Clauses" value={clauses} />
        <Stat label="Tables" value={tables} />
        <Stat label="Chunks" value={document._count.chunks} />
      </dl>

      {/*
        Issues come before content on purpose. An empty section or a table that
        extracted at low confidence is the single most useful thing this page
        can tell a reviewer, and burying it under an outline is how a document
        with a hole in it gets treated as complete.
      */}
      {document.issues.length > 0 && (
        <section className="mb-9">
          <h2 className="mb-3 font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
            Review
          </h2>
          <ul className="space-y-2">
            {[...high, ...other].map((issue) => (
              <li
                key={issue.id}
                className={cn(
                  "flex gap-3 rounded-xl border px-4 py-3",
                  issue.severity === "high"
                    ? "border-warn-line bg-warn-tint"
                    : "border-line bg-card",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 shrink-0",
                    issue.severity === "high" ? "text-warn" : "text-ink/62",
                  )}
                >
                  {issue.severity === "high" ? <AlertTriangle size={15} /> : <Info size={15} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] leading-relaxed text-ink/84">
                    {issue.detail}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] text-ink/62">
                    {issue.kind.replace(/_/g, " ")}
                    {issue.page != null && ` · page ${issue.page}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* After the review notes, which point into it, and before the outline:
          a rule wrongly set aside is invisible everywhere else. */}
      {setAsideView && <SetAside view={setAsideView} editable={mayChange} />}

      <Figures figures={figureViews} />

      <section>
        <h2 className="mb-3 font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
          Structure
        </h2>

        {document.sections.length === 0 ? (
          <p className="rounded-xl border border-line bg-card px-5 py-8 text-center text-[13.5px] text-ink/64">
            {isTerminal(document.status)
              ? "No sections were detected in this document."
              : "Still reading the document…"}
          </p>
        ) : (
          /*
            A tree, not a stack of cards. Thirty sections rendered as identical
            full-width bars gives no sense of depth and no way to skim — the
            hierarchy is the most useful thing this outline carries, so it is
            drawn: parents sit at the margin with weight, children hang off a
            rule, and only the counts that exist are shown.
          */
          <ol className="border-t border-line">
            {document.sections.map((section) => {
              const child = section.depth > 1;
              return (
                <li key={section.id}>
                  <div
                    style={{ paddingLeft: `${Math.min(section.depth - 1, 3) * 22}px` }}
                    className={cn(
                      "border-b border-line-soft",
                      section.isEmpty && "bg-warn-tint",
                    )}
                  >
                    <div
                      className={cn(
                        "flex items-baseline gap-3 py-2",
                        child && "border-l border-line pl-3",
                      )}
                    >
                      {section.numberText && (
                        <span
                          className={cn(
                            "shrink-0 font-mono text-[11px] tabular-nums",
                            child ? "text-ink/58" : "text-ink/64",
                          )}
                        >
                          {section.numberText}
                        </span>
                      )}
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          child
                            ? "text-[13px] text-ink/74"
                            : "text-[13.5px] font-medium text-ink/92",
                        )}
                      >
                        {section.title}
                      </span>

                      <span className="flex shrink-0 items-center gap-3 text-[11.5px] text-ink/62">
                        {section.clauses.length > 0 && (
                          <span className="text-ink/66">
                            {section.clauses.length}{" "}
                            {section.clauses.length === 1 ? "clause" : "clauses"}
                          </span>
                        )}
                        {section.tables.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <Table2 size={11} />
                            {section.tables.length}
                          </span>
                        )}
                        {section.figures.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <ImageIcon size={11} />
                            {section.figures.length}
                          </span>
                        )}
                        {section.isEmpty && <span className="text-warn">empty in source</span>}
                        {section.pageStart != null && (
                          <span className="w-7 text-right tabular-nums text-ink/62">
                            p{section.pageStart}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3">
      <dt className="text-[11.5px] uppercase tracking-[0.1em] text-ink/62">{label}</dt>
      <dd className="mt-1 font-display text-[22px] font-semibold tracking-[-0.02em] text-ink">
        {value}
      </dd>
    </div>
  );
}
