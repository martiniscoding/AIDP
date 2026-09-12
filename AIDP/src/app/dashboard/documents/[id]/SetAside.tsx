"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, ListPlus, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SetAsideRange, SetAsideView } from "@/lib/ingest/rules";
import { LABEL_HINT, LABEL_ORDER, LABEL_WORDS } from "@/lib/ingest/rules-vocabulary";
import { restoreRule } from "../actions";

/**
 * Everything the model decided was not a rule, with its reason for each.
 *
 * The rules themselves are easy to review — they are on the page. A rule that
 * was wrongly set aside is not: it simply never appears, and nothing is ever
 * assessed against it. So the set-aside lines are shown in full, the ones that
 * read like obligations first, and each range can be made a rule in one step.
 */
export function SetAside({ view, editable }: { view: SetAsideView; editable: boolean }) {
  if (view.ranges.length === 0) return null;

  const flagged = view.ranges.filter((r) => r.obligation && !r.restoredAt).length;
  const groups = [...LABEL_ORDER, ...new Set(view.ranges.map((r) => r.label))]
    .filter((label, index, all) => all.indexOf(label) === index)
    .map((label) => ({ label, ranges: view.ranges.filter((r) => r.label === label) }))
    .filter((group) => group.ranges.length > 0)
    .sort(
      (a, b) =>
        Number(b.ranges.some((r) => r.obligation)) - Number(a.ranges.some((r) => r.obligation)),
    );

  return (
    <section className="mb-9">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
          Set aside by the model
        </h2>
        <p className={cn("text-[12.5px]", flagged > 0 ? "text-warn" : "text-ink/64")}>
          {flagged > 0
            ? `${flagged} range${flagged === 1 ? "" : "s"} below state${flagged === 1 ? "s" : ""} an obligation — check ${flagged === 1 ? "it" : "them"} first.`
            : "Nothing set aside reads like an obligation."}
        </p>
      </div>
      <p className="mb-3.5 max-w-3xl text-[13px] leading-relaxed text-ink/70">
        Every line of this standard was either read into a rule or set aside here, with
        the model&apos;s reason. If something below is a rule a design has to meet, make it
        one — otherwise no assessment will ever check it.
      </p>

      <div className="space-y-2">
        {groups.map((group) => (
          <Group
            key={group.label}
            label={group.label}
            ranges={group.ranges}
            editable={editable}
          />
        ))}
      </div>
    </section>
  );
}

function Group({
  label,
  ranges,
  editable,
}: {
  label: string;
  ranges: SetAsideRange[];
  editable: boolean;
}) {
  const lineCount = ranges.reduce((n, r) => n + r.lines.length, 0);
  const flagged = ranges.some((r) => r.obligation && !r.restoredAt);

  return (
    <details
      open={flagged}
      className={cn(
        "group rounded-xl border",
        flagged ? "border-warn-line bg-warn-tint" : "border-line bg-card",
      )}
    >
      <summary className="flex cursor-pointer list-none items-baseline gap-2.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={13}
          className="shrink-0 self-center text-ink/58 transition-transform group-open:rotate-90"
        />
        <span className="text-[13.5px] font-medium text-ink/90">
          {LABEL_WORDS[label] ?? label}
        </span>
        <span className="text-[12px] text-ink/62">
          {ranges.length} range{ranges.length === 1 ? "" : "s"} · {lineCount} line
          {lineCount === 1 ? "" : "s"}
        </span>
        {LABEL_HINT[label] && (
          <span className="hidden min-w-0 flex-1 truncate text-right text-[12px] text-ink/58 sm:block">
            {LABEL_HINT[label]}
          </span>
        )}
      </summary>
      <ul className="space-y-2 px-3 pb-3">
        {ranges.map((range) => (
          <li key={range.id}>
            <Range range={range} editable={editable} />
          </li>
        ))}
      </ul>
    </details>
  );
}

const PREVIEW_LINES = 6;

function Range({ range, editable }: { range: SetAsideRange; editable: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const first = range.lines[0];
  const last = range.lines[range.lines.length - 1];
  const shown = expanded ? range.lines : range.lines.slice(0, PREVIEW_LINES);
  const hidden = range.lines.length - shown.length;

  return (
    <div className="rounded-lg border border-line bg-card px-3.5 py-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-mono text-[11px] text-ink/64">
          {first.ref === last.ref ? first.ref : `${first.ref}–${last.ref}`}
          {first.page != null && ` · p${first.page}`}
        </span>
        {range.obligation && !range.restoredAt && (
          <span className="inline-flex items-center gap-1 rounded-md border border-warn-line bg-warn-tint px-1.5 py-0.5 text-[11px] text-warn">
            <TriangleAlert size={10} />
            States an obligation
          </span>
        )}
        {range.reason && (
          <span className="min-w-0 text-[12.5px] italic text-ink/70">
            &ldquo;{range.reason}&rdquo;
          </span>
        )}
      </div>

      <ol className="space-y-0.5 border-l border-line pl-3">
        {shown.map((line) => (
          <li key={line.ref} className="flex gap-2 text-[12.5px] leading-relaxed text-ink/80">
            <span className="w-11 shrink-0 font-mono text-[10.5px] leading-[1.9] text-ink/50">
              {line.ref}
            </span>
            <span className="min-w-0 break-words">{line.text}</span>
          </li>
        ))}
      </ol>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1.5 text-[12px] text-royal hover:underline"
        >
          Show {hidden} more line{hidden === 1 ? "" : "s"}
        </button>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        {range.restoredAt ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ok">
            <Check size={12} />
            Made a rule{range.restoredBy ? ` by ${range.restoredBy}` : ""}
          </span>
        ) : (
          editable && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await restoreRule(range.id);
                  setMessage(result.message);
                  router.refresh();
                })
              }
              className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[12px] text-ink/80 transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-55"
            >
              <ListPlus size={12} />
              {pending ? "Making it a rule…" : "Make this a rule"}
            </button>
          )
        )}
        {message && (
          <span role="status" className="text-[12px] text-ink/70">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
