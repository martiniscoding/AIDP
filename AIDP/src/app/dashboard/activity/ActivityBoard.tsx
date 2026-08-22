"use client";

import { useMemo, useState } from "react";
import { FileText, Gavel, ScanSearch, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatTokens, formatWhen } from "@/lib/access/format";
import type { OrganisationActivity, PersonWork, Tone, WorkEvent } from "@/lib/access/activity";

/**
 * Who did what, as one board.
 *
 * Two views of the same data, and deliberately on one page: the table answers
 * "how much has each person put through", the feed answers "what happened
 * most recently". An administrator investigating a late submission arrives
 * with the second question and leaves with the first, and making them navigate
 * between the two loses the person they were looking at.
 *
 * Selecting a person filters the feed rather than opening a new page, so the
 * comparison against everyone else stays on screen.
 */

const TONE: Record<Tone, string> = {
  good: "border-ok-line bg-ok-tint text-ok",
  bad: "border-danger-line bg-danger-tint text-danger",
  working: "border-sky-300 bg-sky-600/[0.08] text-sky-700",
  waiting: "border-warn-line bg-warn-tint text-warn",
  neutral: "border-line bg-card text-ink/68",
};

const KIND_ICON = {
  upload: FileText,
  run: ScanSearch,
  decision: Gavel,
} as const;

const KIND_FILTERS: { id: "all" | WorkEvent["kind"]; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "upload", label: "Documents" },
  { id: "run", label: "Assessments" },
  { id: "decision", label: "Decisions" },
];

export function ActivityBoard({ activity }: { activity: OrganisationActivity }) {
  const [selected, setSelected] = useState<string | null | "everyone">("everyone");
  const [kind, setKind] = useState<"all" | WorkEvent["kind"]>("all");
  const [term, setTerm] = useState("");

  const events = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return activity.events.filter((event) => {
      if (selected !== "everyone" && event.userId !== selected) return false;
      if (kind !== "all" && event.kind !== kind) return false;
      if (!needle) return true;
      return (
        event.title.toLowerCase().includes(needle) ||
        event.personName.toLowerCase().includes(needle)
      );
    });
  }, [activity.events, selected, kind, term]);

  const focused =
    selected === "everyone"
      ? null
      : activity.people.find((person) => person.userId === selected) ?? null;

  return (
    <>
      <section>
        <div className="mb-4 flex flex-wrap items-baseline gap-3">
          <h2 className="mr-auto font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
            By person
            <span className="ml-2 text-[13px] font-normal text-ink/62">
              {activity.people.length === 1 ? "1 contributor" : `${activity.people.length} contributors`}
            </span>
          </h2>
          {selected !== "everyone" && (
            <button
              type="button"
              onClick={() => setSelected("everyone")}
              className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-ink/78 transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
            >
              Clear selection
            </button>
          )}
        </div>

        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-ink/62">
                <th className="px-4 py-3 font-medium">Person</th>
                <th className="px-4 py-3 text-right font-medium">Standards</th>
                <th className="px-4 py-3 text-right font-medium">Submissions</th>
                <th className="px-4 py-3 text-right font-medium">Assessments</th>
                <th className="px-4 py-3 text-right font-medium">Decisions</th>
                <th className="px-4 py-3 text-right font-medium">Tokens</th>
                <th className="px-4 py-3 text-right font-medium">Last active</th>
              </tr>
            </thead>
            <tbody>
              {activity.people.map((person) => (
                <PersonRow
                  key={person.userId ?? "unattributed"}
                  person={person}
                  selected={selected === person.userId}
                  onSelect={() =>
                    setSelected(selected === person.userId ? "everyone" : person.userId)
                  }
                />
              ))}
              {activity.people.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-[13.5px] text-ink/64">
                    Nobody has put anything through yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {activity.hasUnattributed && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink/64">
            <span className="text-ink/72">Unattributed</span> is work that cannot be traced to an
            account — documents filed before this was recorded, or by someone since removed. It is
            counted here so these totals match the People page.
          </p>
        )}
      </section>

      <section className="mt-10">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="mr-auto font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
            Recent activity
            {focused && (
              <span className="ml-2 text-[13px] font-normal text-ink/66">{focused.name}</span>
            )}
          </h2>

          <label className="relative">
            <span className="sr-only">Search activity</span>
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/62"
            />
            <input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Document or person"
              className="w-60 rounded-lg border border-line bg-card py-1.5 pl-8 pr-3 text-[12.5px] text-ink/88 placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
            />
          </label>
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5">
          {KIND_FILTERS.map((filter) => {
            const count =
              filter.id === "all"
                ? activity.events.length
                : activity.events.filter((event) => event.kind === filter.id).length;
            return (
              <button
                key={filter.id}
                type="button"
                onClick={() => setKind(filter.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid",
                  kind === filter.id
                    ? "border-line-strong bg-canvas-sunk text-ink"
                    : "border-line text-ink/68 hover:border-line-strong hover:text-ink/84",
                )}
              >
                {filter.label}
                <span className="ml-1.5 tabular-nums opacity-55">{count}</span>
              </button>
            );
          })}
        </div>

        <ol className="rounded-xl border border-line">
          {events.map((event, index) => {
            const Icon = KIND_ICON[event.kind];
            return (
              <li
                key={event.id}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3",
                  index > 0 && "border-t border-line",
                )}
              >
                <Icon size={15} strokeWidth={1.9} className="shrink-0 text-ink/62" />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink/88">
                  {event.title}
                </span>
                <span className="text-[12.5px] text-ink/64">{event.detail}</span>
                <span
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-[11.5px] whitespace-nowrap",
                    TONE[event.tone],
                  )}
                >
                  {event.state}
                </span>
                <button
                  type="button"
                  onClick={() => setSelected(event.userId)}
                  className="text-[12.5px] text-ink/70 underline-offset-2 transition-colors hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
                >
                  {event.personName}
                </button>
                <time
                  dateTime={new Date(event.at).toISOString()}
                  className="w-28 shrink-0 text-right text-[12.5px] tabular-nums text-ink/62"
                >
                  {formatWhen(event.at)}
                </time>
              </li>
            );
          })}
          {events.length === 0 && (
            <li className="px-4 py-10 text-center text-[13.5px] text-ink/64">
              Nothing matches that.
            </li>
          )}
        </ol>
      </section>
    </>
  );
}

function PersonRow({
  person,
  selected,
  onSelect,
}: {
  person: PersonWork;
  selected: boolean;
  onSelect: () => void;
}) {
  const total = person.references + person.submissions + person.runs + person.decisions;
  return (
    <tr
      className={cn(
        "border-b border-line-soft transition-colors last:border-b-0",
        selected ? "bg-royal/[0.10]" : "hover:bg-card",
      )}
    >
      <td className="px-4 py-3">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
        >
          <span className={cn("block text-[13.5px]", person.userId ? "text-ink/92" : "text-ink/70")}>
            {person.name}
          </span>
          {person.email && (
            <span className="block text-[12px] text-ink/62">{person.email}</span>
          )}
          {total === 0 && (
            <span className="block text-[12px] text-ink/62">No activity yet</span>
          )}
        </button>
      </td>
      <Cell value={person.references} />
      <Cell value={person.submissions} />
      <Cell value={person.runs} />
      <Cell value={person.decisions} />
      <td className="px-4 py-3 text-right text-[13px] tabular-nums text-ink/72">
        {person.totalTokens > 0 ? formatTokens(person.totalTokens) : "—"}
      </td>
      <td className="px-4 py-3 text-right text-[12.5px] tabular-nums text-ink/64">
        {formatWhen(person.lastActiveAt)}
      </td>
    </tr>
  );
}

function Cell({ value }: { value: number }) {
  return (
    <td
      className={cn(
        "px-4 py-3 text-right text-[13px] tabular-nums",
        value > 0 ? "text-ink/88" : "text-ink/58",
      )}
    >
      {value > 0 ? value : "—"}
    </td>
  );
}
