"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { restore, setActive, setThreshold } from "./actions";

/**
 * The criteria, as an administrator reads and changes them.
 *
 * What can be changed here is deliberately narrow: a threshold, and whether a
 * category is checked at all. Those are the two things a customer's governance
 * policy actually differs on. Inventing conditions, naming fields or choosing
 * operators is not offered, because a rule built on a field the form does not
 * collect can never fire and would sit on this screen looking configured —
 * which is worse than not having it.
 *
 * Every row says what it checks in the brief's own words, so somebody deciding
 * whether to switch one off can see what they would stop checking.
 */

export type ConditionView = {
  text: string;
  field: string;
  operator: string;
  /** Present only for the operators that compare against a number. */
  threshold: number | null;
  /** Why this condition can never fire, when it cannot. */
  problem: string | null;
};

export type CriterionView = {
  id: string;
  category: string;
  label: string;
  description: string;
  active: boolean;
  conditions: ConditionView[];
};

export function CriteriaBoard({
  criteria,
  canEdit,
  placeholderThreshold,
}: {
  criteria: CriterionView[];
  canEdit: boolean;
  /** The seeded cost threshold. A category still carrying it has not been
   *  configured, which the brief's own assumptions require before go-live. */
  placeholderThreshold: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const act = (work: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const result = await work();
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) {
        setEditing(null);
        router.refresh();
      }
    });

  const unconfigured = criteria.filter((criterion) =>
    criterion.conditions.some((condition) => condition.threshold === placeholderThreshold),
  );
  const broken = criteria.filter((criterion) =>
    criterion.conditions.some((condition) => condition.problem),
  );
  const off = criteria.filter((criterion) => !criterion.active);

  return (
    <>
      {unconfigured.length > 0 && (
        <div className="mb-4 flex gap-2 rounded-xl border border-warn-line bg-warn-tint px-4 py-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <div>
            <p className="text-[13px] font-medium text-ink">
              {unconfigured.map((c) => c.label).join(", ")} is still on its placeholder
            </p>
            <p className="mt-0.5 text-[12.5px] text-ink/75">
              Nobody chose {placeholderThreshold.toLocaleString("en-GB")} — it was seeded so the
              category had a number at all. Set your own governance threshold before relying on
              this check.
            </p>
          </div>
        </div>
      )}

      {broken.length > 0 && (
        <div className="mb-4 flex gap-2 rounded-xl border border-warn-line bg-warn-tint px-4 py-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <div>
            <p className="text-[13px] font-medium text-ink">
              {broken.length === 1 ? "A category" : `${broken.length} categories`} can never be
              triggered
            </p>
            <ul className="mt-1 space-y-0.5">
              {broken.flatMap((criterion) =>
                criterion.conditions
                  .filter((condition) => condition.problem)
                  .map((condition, index) => (
                    <li key={`${criterion.id}-${index}`} className="text-[12.5px] text-ink/75">
                      <span className="font-medium">{criterion.label}</span> — {condition.problem}
                    </li>
                  )),
              )}
            </ul>
          </div>
        </div>
      )}

      <p className="mb-4 text-[12.5px] text-ink/60">
        {criteria.length - off.length} of {criteria.length} categories are checked on every
        submission. Any one of them triggering makes a request architecturally significant.
      </p>

      <ul className="grid gap-2">
        {criteria.map((criterion) => (
          <li
            key={criterion.id}
            className={cn(
              "rounded-xl border bg-card px-4 py-3",
              criterion.active ? "border-line" : "border-dashed border-line opacity-70",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-ink">{criterion.label}</p>
                <p className="mt-0.5 text-[12px] text-ink/60">{criterion.description}</p>
              </div>

              <button
                type="button"
                disabled={pending || !canEdit}
                onClick={() => act(() => setActive(criterion.id, !criterion.active))}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1 text-[11.5px] transition-colors",
                  canEdit ? "cursor-pointer" : "cursor-default",
                  "disabled:opacity-50",
                  criterion.active
                    ? "border-royal-mid/40 bg-royal/8 text-royal"
                    : "border-line text-ink/55",
                )}
              >
                {criterion.active ? "Checked" : "Not checked"}
              </button>
            </div>

            <ul className="mt-2 space-y-1 border-t border-line pt-2">
              {criterion.conditions.map((condition, index) => (
                <li key={index} className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "text-[12.5px]",
                      condition.problem ? "text-warn" : "text-ink/75",
                    )}
                  >
                    {condition.problem ?? condition.text}
                  </span>

                  {condition.threshold !== null && canEdit && (
                    editing === `${criterion.id}:${index}` ? (
                      <span className="inline-flex items-center gap-1">
                        <input
                          value={draft}
                          autoFocus
                          onChange={(event) => setDraft(event.target.value)}
                          className="w-36 rounded-lg border border-line bg-canvas-sunk px-2 py-0.5 text-[12.5px] text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
                        />
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => act(() => setThreshold(criterion.id, index, draft))}
                          className="rounded-full bg-royal px-3 py-0.5 text-[11.5px] font-medium text-white cursor-pointer disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(null)}
                          className="rounded-full px-2 py-0.5 text-[11.5px] text-ink/60 hover:text-ink cursor-pointer"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(`${criterion.id}:${index}`);
                          setDraft(String(condition.threshold));
                        }}
                        className="rounded-full border border-line px-2.5 py-0.5 text-[11.5px] text-ink/70 hover:text-ink cursor-pointer"
                      >
                        Change
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          {message && (
            <p
              role="status"
              className={cn("text-[12.5px]", message.ok ? "text-ok" : "text-warn")}
            >
              {message.text}
            </p>
          )}
        </div>
        {canEdit && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act(restore)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line px-4 py-1.5 text-[13px] text-ink/75 hover:text-ink cursor-pointer disabled:opacity-50"
          >
            <RotateCcw size={14} aria-hidden="true" />
            Restore the defaults
          </button>
        )}
      </div>
    </>
  );
}
