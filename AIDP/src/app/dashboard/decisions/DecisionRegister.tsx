"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Ban, Check, Clock, Plus, RotateCcw, Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  DECISION_EFFECTS,
  EFFECT_META,
  STATUS_META,
  type DecisionEffect,
  type DecisionStatus,
} from "@/lib/ingest/decision-effects";
import type { DecisionView } from "@/lib/ingest/decisions";
import {
  recordDecision,
  reinstateDecision,
  retireDecision,
  retryIndexing,
  reviseDecision,
} from "./actions";

const TONE: Record<"good" | "bad" | "neutral", string> = {
  good: "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-300",
  bad: "border-rose-400/30 bg-rose-400/[0.08] text-rose-300",
  neutral: "border-white/15 bg-white/[0.05] text-white/60",
};

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function DecisionRegister({
  decisions,
  unindexed,
}: {
  decisions: DecisionView[];
  unindexed: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [revising, setRevising] = useState<string | null>(null);
  const [filter, setFilter] = useState<DecisionStatus | null>("active");

  const shown = filter ? decisions.filter((d) => d.status === filter) : decisions;
  const counts = {
    active: decisions.filter((d) => d.status === "active").length,
    superseded: decisions.filter((d) => d.status === "superseded").length,
    expired: decisions.filter((d) => d.status === "expired").length,
  };

  const run = (work: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const result = await work();
      setMessage(result.message);
      setComposing(false);
      setRevising(null);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      {unindexed > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3">
          <AlertTriangle size={15} className="shrink-0 text-amber-400/85" />
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-amber-100/80">
            {unindexed} decision{unindexed === 1 ? "" : "s"} could not be indexed for
            matching. {unindexed === 1 ? "It" : "They"} will only be applied to the exact
            clause referenced, not to related ones.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => retryIndexing())}
            className="shrink-0 rounded-full border border-amber-400/40 px-3 py-1 text-[12px] text-amber-200 transition-colors hover:bg-amber-400/10 disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(["active", "superseded", "expired"] as const).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setFilter(filter === status ? null : status)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-[12.5px] transition-colors",
              filter === status
                ? "border-white/30 bg-white/[0.09] text-white"
                : "border-white/10 text-white/45 hover:border-white/22 hover:text-white/80",
            )}
          >
            {STATUS_META[status].label}
            <span className="ml-1.5 tabular-nums text-white/35">{counts[status]}</span>
          </button>
        ))}

        <button
          type="button"
          onClick={() => {
            setComposing((v) => !v);
            setRevising(null);
          }}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-royal px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-royal-mid"
        >
          <Plus size={13} />
          Record a decision
        </button>
      </div>

      {message && (
        <p role="status" className="text-[12.5px] text-white/55">
          {message}
        </p>
      )}

      {composing && (
        <DecisionForm
          pending={pending}
          onCancel={() => setComposing(false)}
          onSubmit={(form) => run(() => recordDecision(form))}
        />
      )}

      {shown.length === 0 && !composing ? (
        <p className="rounded-xl border border-white/[0.07] bg-white/[0.015] px-4 py-8 text-center text-[13px] text-white/35">
          {filter ? `No ${STATUS_META[filter].label.toLowerCase()} decisions.` : "Nothing here yet."}
        </p>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((decision) =>
            revising === decision.id ? (
              <li key={decision.id}>
                <DecisionForm
                  initial={decision}
                  pending={pending}
                  onCancel={() => setRevising(null)}
                  onSubmit={(form) => run(() => reviseDecision(decision.id, form))}
                />
              </li>
            ) : (
              <li key={decision.id}>
                <DecisionCard
                  decision={decision}
                  pending={pending}
                  onRevise={() => {
                    setRevising(decision.id);
                    setComposing(false);
                  }}
                  onRetire={() => run(() => retireDecision(decision.id))}
                  onReinstate={() => run(() => reinstateDecision(decision.id))}
                />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function DecisionCard({
  decision,
  pending,
  onRevise,
  onRetire,
  onReinstate,
}: {
  decision: DecisionView;
  pending: boolean;
  onRevise: () => void;
  onRetire: () => void;
  onReinstate: () => void;
}) {
  const meta = EFFECT_META[decision.effect];
  const inForce = decision.status === "active";

  return (
    <article
      className={cn(
        "rounded-xl border border-white/[0.09] bg-white/[0.02] p-4",
        !inForce && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-start gap-2.5">
        <span
          className={cn(
            "shrink-0 rounded-md border px-2 py-1 text-[11px]",
            TONE[meta.tone],
          )}
        >
          {meta.label}
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-medium text-white/90">{decision.title}</h3>
          {decision.clauseRef && (
            <p className="mt-0.5 font-mono text-[11.5px] text-white/35">
              {decision.clauseRef}
              {decision.clauseTitle ? ` · ${decision.clauseTitle}` : ""}
            </p>
          )}
        </div>

        {!inForce && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-white/40">
            {STATUS_META[decision.status as DecisionStatus]?.label ?? decision.status}
          </span>
        )}
      </div>

      <p className="mt-2.5 text-[13px] leading-relaxed text-white/70">{decision.statement}</p>

      {decision.rationale && decision.rationale !== decision.statement && (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/40">
          {decision.rationale}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-white/35">
        <span>{decision.decidedByName || "Unattributed"}</span>
        <span>·</span>
        <span>{formatDate(decision.effectiveFrom)}</span>
        {decision.expiresAt && (
          <>
            <span>·</span>
            <span className="inline-flex items-center gap-1 text-amber-300/70">
              <Clock size={11} />
              until {formatDate(decision.expiresAt)}
            </span>
          </>
        )}
        {decision.sourceDocumentId && (
          <>
            <span>·</span>
            <a
              href={`/dashboard/documents/${decision.sourceDocumentId}`}
              className="underline decoration-white/20 underline-offset-2 transition-colors hover:text-white/70"
            >
              from a review
            </a>
          </>
        )}
        {!decision.hasVector && inForce && (
          <>
            <span>·</span>
            <span className="text-amber-300/70">clause match only</span>
          </>
        )}

        <span className="ml-auto flex items-center gap-2">
          {inForce ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={onRevise}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-white/80 disabled:opacity-50"
              >
                <RotateCcw size={11} />
                Revise
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={onRetire}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-amber-300 disabled:opacity-50"
              >
                <Ban size={11} />
                Retire
              </button>
            </>
          ) : decision.status === "expired" ? (
            <button
              type="button"
              disabled={pending}
              onClick={onReinstate}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-white/80 disabled:opacity-50"
            >
              <Undo2 size={11} />
              Reinstate
            </button>
          ) : null}
        </span>
      </div>
    </article>
  );
}

/**
 * One form for both authoring and revising.
 *
 * Revising submits a *new* decision and retires the old one — the fields are
 * prefilled, but nothing is edited in place, so a report that cited the
 * previous wording still resolves to what was actually applied.
 */
function DecisionForm({
  initial,
  pending,
  onCancel,
  onSubmit,
}: {
  initial?: DecisionView;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (form: FormData) => void;
}) {
  const [effect, setEffect] = useState<DecisionEffect>(initial?.effect ?? "context");

  return (
    <form
      action={onSubmit}
      className="space-y-3.5 rounded-xl border border-royal-mid/25 bg-royal/[0.05] p-4"
    >
      <input type="hidden" name="effect" value={effect} />

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Name" hint="How it appears in this register.">
          <input
            name="title"
            required
            defaultValue={initial?.title}
            placeholder="Encryption at rest via KMS"
            className={INPUT}
          />
        </Field>
        <Field label="In force until" hint="Optional.">
          <input
            name="expiresAt"
            type="date"
            defaultValue={
              initial?.expiresAt
                ? new Date(initial.expiresAt).toISOString().slice(0, 10)
                : undefined
            }
            className={cn(INPUT, "sm:w-40")}
          />
        </Field>
      </div>

      <Field label="The ruling" hint="Written for the model as much as for a colleague.">
        <textarea
          name="statement"
          required
          rows={3}
          defaultValue={initial?.statement}
          placeholder="KMS-managed keys in eu-west-1 satisfy encryption at rest. Customer-managed key rotation is not required for internal-use data."
          className={cn(INPUT, "resize-y")}
        />
      </Field>

      <div>
        <span className="mb-1.5 block text-[11.5px] text-white/40">
          How should an assessment treat it?
        </span>
        <div className="flex flex-wrap gap-1.5">
          {DECISION_EFFECTS.map((option) => {
            const meta = EFFECT_META[option];
            return (
              <button
                key={option}
                type="button"
                aria-pressed={effect === option}
                onClick={() => setEffect(option)}
                className={cn(
                  "rounded-lg border px-2.5 py-1.5 text-left text-[11.5px] transition-[box-shadow,opacity]",
                  TONE[meta.tone],
                  effect === option ? "ring-2 ring-white/50" : "opacity-60 hover:opacity-90",
                )}
              >
                <span className="block font-medium">{meta.label}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/35">
          {EFFECT_META[effect].blurb}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Clause reference" hint="Optional. Anchors it to one clause.">
          <input
            name="clauseRef"
            defaultValue={initial?.clauseRef}
            placeholder="§3.2"
            className={INPUT}
          />
        </Field>
        <Field label="Clause title" hint="Optional.">
          <input
            name="clauseTitle"
            defaultValue={initial?.clauseTitle}
            placeholder="Encryption at rest"
            className={INPUT}
          />
        </Field>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-full bg-royal px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-50"
        >
          <Check size={13} />
          {initial ? "Save as a new version" : "Record decision"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[12.5px] text-white/35 transition-colors hover:text-white/70"
        >
          cancel
        </button>
      </div>
    </form>
  );
}

const INPUT =
  "w-full rounded-lg border border-white/12 bg-ink-950/50 px-2.5 py-2 text-[13px] text-white/85 placeholder:text-white/25 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] text-white/40">
        {label}
        {hint ? <span className="ml-1.5 text-white/25">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}
