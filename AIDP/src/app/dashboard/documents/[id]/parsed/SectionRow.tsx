"use client";

import { useState } from "react";
import { ChevronRight, ImageIcon, Table2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SectionContent } from "@/lib/ingest/documents";

/** The outline row's own data, which the page already has. */
export type SectionSummary = {
  id: string;
  depth: number;
  numberText: string | null;
  title: string;
  pageStart: number | null;
  isEmpty: boolean;
  clauses: number;
  tables: number;
  figures: number;
};

/**
 * One line of the outline, openable.
 *
 * The outline said how many clauses, tables and figures a section produced.
 * How many is not what, and a count cannot tell a good parse from a bad one —
 * "2 clauses" reads the same whether the parser found two rules or cut one in
 * half. Opening a row shows the text behind the number: the lines as they were
 * read off the page, the clauses with their parts kept apart, and the tables as
 * tables.
 *
 * Fetched on the first open and kept, so a second look is free and a document
 * with six thousand lines does not send them to draw an outline.
 */
export function SectionRow({
  documentId,
  section,
}: {
  documentId: string;
  section: SectionSummary;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<SectionContent | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  const child = section.depth > 1;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || content || state === "loading") return;

    setState("loading");
    try {
      const res = await fetch(
        `/api/documents/${documentId}/sections/${section.id}`,
        { headers: { accept: "application/json" } },
      );
      if (!res.ok) throw new Error(String(res.status));
      setContent((await res.json()) as SectionContent);
      setState("idle");
    } catch {
      setState("failed");
    }
  };

  return (
    <li>
      <div
        style={{ paddingLeft: `${Math.min(section.depth - 1, 3) * 22}px` }}
        className={cn("border-b border-line-soft", section.isEmpty && "bg-warn-tint")}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            "flex w-full items-baseline gap-2.5 py-2 text-left",
            "transition-colors hover:bg-canvas-sunk/50",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-royal-mid",
            child && "border-l border-line pl-3",
          )}
        >
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={cn(
              "mt-0.5 shrink-0 text-ink/40 transition-transform duration-200",
              open && "rotate-90",
            )}
          />

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
              child ? "text-[13px] text-ink/74" : "text-[13.5px] font-medium text-ink/92",
            )}
          >
            {section.title}
          </span>

          <span className="flex shrink-0 items-center gap-3 text-[11.5px] text-ink/62">
            {section.clauses > 0 && (
              <span className="text-ink/66">
                {section.clauses} {section.clauses === 1 ? "clause" : "clauses"}
              </span>
            )}
            {section.tables > 0 && (
              <span className="inline-flex items-center gap-1">
                <Table2 size={11} />
                {section.tables}
              </span>
            )}
            {section.figures > 0 && (
              <span className="inline-flex items-center gap-1">
                <ImageIcon size={11} />
                {section.figures}
              </span>
            )}
            {section.isEmpty && <span className="text-warn">empty in source</span>}
            {section.pageStart != null && (
              <span className="w-7 text-right tabular-nums text-ink/62">p{section.pageStart}</span>
            )}
          </span>
        </button>

        {open && (
          <div
            className={cn(
              "mb-2.5 rounded-lg border border-line bg-canvas-sunk/60 px-3 py-2.5",
              child && "ml-3",
            )}
          >
            {state === "loading" && (
              <p className="text-[12px] text-ink/58">Reading what this section yielded…</p>
            )}
            {state === "failed" && (
              <p className="text-[12px] text-warn">
                Could not load this section.{" "}
                <button type="button" onClick={toggle} className="underline underline-offset-2">
                  Try again
                </button>
              </p>
            )}
            {content && <Extraction content={content} />}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * What came out of the section, with the payload first.
 *
 * A standard is its clauses, so those lead and the lines are the record behind
 * them. A design has no clauses — what was extracted *is* the lines, so they
 * lead there. Both end with the tables, which are the part most often parsed
 * wrong and the hardest to check from a count.
 */
function Extraction({ content }: { content: SectionContent }) {
  const standard = content.role !== "assessed";
  const nothing =
    content.lines.length === 0 && content.clauses.length === 0 && content.tables.length === 0;

  if (nothing) {
    return (
      <p className="text-[12px] text-ink/58">
        Nothing was extracted here. A section can be a heading with no body, or the
        document may have been processed before its page text was stored — reprocess it
        to see the lines.
      </p>
    );
  }

  return (
    <div className="space-y-3.5">
      {standard ? (
        <>
          <Clauses content={content} />
          <Tables content={content} />
          <Lines content={content} collapsedByDefault />
        </>
      ) : (
        <>
          <Lines content={content} />
          <Tables content={content} />
          <Clauses content={content} />
        </>
      )}
    </div>
  );
}

function Part({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5">
      <span className="text-[10.5px] uppercase tracking-[0.09em] text-ink/50">{label}</span>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink/82">{children}</div>
    </div>
  );
}

/** The line refs a clause's part was built from, when a model read it. */
function refsFor(sourceRefs: unknown, part: string): string[] {
  if (!sourceRefs || typeof sourceRefs !== "object") return [];
  const value = (sourceRefs as Record<string, unknown>)[part];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      // requirements: [{ refs: [...], strength }]
      if (entry && typeof entry === "object" && Array.isArray((entry as { refs?: unknown }).refs)) {
        return ((entry as { refs: unknown[] }).refs ?? []).filter(
          (r): r is string => typeof r === "string",
        );
      }
      return [];
    });
  }
  return typeof value === "string" ? [value] : [];
}

function Refs({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null;
  return (
    <span
      title="The source lines this was built from"
      className="ml-1.5 font-mono text-[10px] text-royal/80"
    >
      {refs.join(" ")}
    </span>
  );
}

function Clauses({ content }: { content: SectionContent }) {
  if (content.clauses.length === 0) return null;
  return (
    <section>
      <h4 className="text-[11px] font-medium uppercase tracking-[0.09em] text-ink/62">
        Clauses extracted ({content.clauses.length})
      </h4>
      <ol className="mt-1.5 space-y-2.5">
        {content.clauses.map((clause) => (
          <li key={clause.id} className="rounded-md border border-line bg-card px-2.5 py-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[12.5px] font-medium text-ink/92">
                {clause.title || `Clause ${clause.ordinal}`}
              </span>
              {/* How it was found. "model" means a model pointed at the lines
                  and code sliced the text, which is worth knowing when the
                  slice looks wrong. */}
              <span className="rounded border border-line px-1.5 py-px text-[10px] text-ink/62">
                {clause.origin}
              </span>
              {clause.pageStart != null && (
                <span className="text-[10.5px] tabular-nums text-ink/55">p{clause.pageStart}</span>
              )}
            </div>

            {clause.statement && (
              <Part label="Statement">
                {clause.statement}
                <Refs refs={refsFor(clause.sourceRefs, "statement")} />
              </Part>
            )}
            {clause.rationale && (
              <Part label="Rationale">
                {clause.rationale}
                <Refs refs={refsFor(clause.sourceRefs, "rationale")} />
              </Part>
            )}
            {clause.requirements.length > 0 && (
              <Part label={`Requirements (${clause.requirements.length})`}>
                <ul className="list-disc space-y-0.5 pl-4">
                  {clause.requirements.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
                <Refs refs={refsFor(clause.sourceRefs, "requirements")} />
              </Part>
            )}
            {clause.guidance.length > 0 && (
              <Part label={`Guidance (${clause.guidance.length})`}>
                <ul className="list-disc space-y-0.5 pl-4">
                  {clause.guidance.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </Part>
            )}
            {/* Said rather than left blank: a clause with no requirements is
                judged on its statement alone, and that is the difference
                between a rule that can be measured and one that cannot. */}
            {clause.requirements.length === 0 && (
              <p className="mt-1.5 text-[11.5px] text-warn">
                No requirements were extracted — this clause is judged on its statement
                alone.
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function cells(rows: unknown): string[][] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) =>
    Array.isArray(row)
      ? row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)))
      : [String(row)],
  );
}

function Tables({ content }: { content: SectionContent }) {
  if (content.tables.length === 0) return null;
  return (
    <section>
      <h4 className="text-[11px] font-medium uppercase tracking-[0.09em] text-ink/62">
        Tables extracted ({content.tables.length})
      </h4>
      <div className="mt-1.5 space-y-2.5">
        {content.tables.map((table) => {
          const body = cells(table.rows);
          return (
            <figure key={table.id} className="overflow-hidden rounded-md border border-line bg-card">
              <figcaption className="flex flex-wrap items-baseline gap-2 border-b border-line-soft px-2.5 py-1.5 text-[11.5px] text-ink/70">
                <span className="min-w-0 flex-1">{table.caption || `Table ${table.ordinal}`}</span>
                {/* Below 1 the parser was unsure of the shape — a merged cell,
                    a row that ran over a page break. Shown, because a table
                    silently reshaped is the worst kind of parse error. */}
                {table.confidence < 1 && (
                  <span className="text-warn">
                    shape uncertain · {Math.round(table.confidence * 100)}%
                  </span>
                )}
                {table.pageStart != null && (
                  <span className="tabular-nums text-ink/55">p{table.pageStart}</span>
                )}
              </figcaption>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[11.5px]">
                  {table.columns.length > 0 && (
                    <thead>
                      <tr>
                        {table.columns.map((column, index) => (
                          <th
                            key={index}
                            scope="col"
                            className="border-b border-line-soft px-2 py-1 text-left font-medium text-ink/72"
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {body.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className={cn(
                              "border-b border-line-soft px-2 py-1 align-top text-ink/78",
                              // A blank cell is content: Tier 4's RPO is blank
                              // on purpose and must not read as Tier 3's.
                              cell === "" && "bg-canvas-sunk/70",
                            )}
                          >
                            {cell === "" ? (
                              <span className="text-ink/40">—</span>
                            ) : (
                              cell
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {body.length === 0 && (
                <p className="px-2.5 py-2 text-[11.5px] text-warn">
                  Columns were found but no rows were extracted.
                </p>
              )}
            </figure>
          );
        })}
      </div>
    </section>
  );
}

const KIND_LABEL: Record<string, string> = {
  heading: "heading",
  text: "text",
  bullet: "bullet",
  table_row: "table row",
};

function Lines({
  content,
  collapsedByDefault = false,
}: {
  content: SectionContent;
  collapsedByDefault?: boolean;
}) {
  const [shown, setShown] = useState(!collapsedByDefault);
  if (content.lines.length === 0) {
    return (
      <p className="text-[11.5px] text-ink/55">
        No source lines are stored for this section.
      </p>
    );
  }

  return (
    <section>
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        className="text-[11px] font-medium uppercase tracking-[0.09em] text-ink/62 underline-offset-2 hover:text-ink/80 hover:underline"
      >
        Source lines ({content.lines.length}) {shown ? "−" : "+"}
      </button>

      {shown && (
        <ol className="mt-1.5 divide-y divide-line-soft overflow-hidden rounded-md border border-line bg-card">
          {content.lines.map((line) => (
            <li key={line.ordinal} className="flex items-baseline gap-2 px-2.5 py-1">
              {/* The parser's own handle, which clauses cite in sourceRefs —
                  so a clause's "L14" can be found in this list. */}
              <span className="w-10 shrink-0 font-mono text-[10px] text-royal/70">{line.ref}</span>
              <span className="w-[4.5rem] shrink-0 text-[10px] uppercase tracking-[0.06em] text-ink/45">
                {KIND_LABEL[line.kind] ?? line.kind}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 whitespace-pre-wrap text-[12px] leading-relaxed",
                  line.kind === "heading" ? "font-medium text-ink/92" : "text-ink/80",
                )}
              >
                {line.text}
              </span>
              {line.page != null && (
                <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-ink/50">
                  p{line.page}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
