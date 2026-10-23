"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Send } from "lucide-react";
import { cn } from "@/lib/cn";
import { saveRequest, submit } from "../actions";
import type { UpdateInput } from "@/lib/ingest/requests";

/**
 * The intake form, as four steps rather than one page.
 *
 * The brief asks for "a short, logical wizard rather than one long page", and
 * the reason is in the field list: twenty-four answers, most of them yes/no,
 * grouped around four quite different questions. Asked all at once they read as
 * a tax return.
 *
 * **Every step saves on its way out.** A draft is a real row from the moment it
 * is opened, so a closed laptop costs nothing, and a step only ever sends its
 * own fields — a field it does not carry is left alone rather than blanked.
 * That rule is enforced in `updateRequest` and tested in
 * scripts/verify-request-intake.mts; this component relies on it rather than
 * restating it.
 *
 * **Nothing here decides whether the request is complete.** `whatIsMissing` on
 * the server is the authority; the page prints what it says, above this, and
 * all this does with it is disable the submit button. A second opinion in the
 * browser would eventually disagree with the one that refuses the submission,
 * and it would be the browser's that people saw first.
 */

export type Draft = {
  id: string;
  reference: string;
  title: string;
  summary: string;
  team: string;
  plannedStart: string;
  problemStatement: string;
  solutionOverview: string;
  technologies: string[];
  newTechnologyComponent: boolean;
  newTechnologyComponentName: string;
  replacesTechnologyComponent: boolean;
  replacedTechnologyComponentName: string;
  integrationPoints: string;
  authMechanism: string;
  dataStores: string;
  dataClassification: string;
  newOrDuplicatedStorage: boolean;
  hostingEnvironment: string;
  estimatedCost: string;
  newLicenceRequired: boolean;
  newLicenceVendor: string;
  linesOfBusiness: string[];
  newBusinessCapability: boolean;
  regulatoryImpact: boolean;
  regulatoryImpactDetail: string;
  securityDomainChange: boolean;
  securityDomainChangeDetail: string;
  applicationDecommissioned: boolean;
  applicationDecommissionedName: string;
  applicationCriticality: string;
  newApplicationStandard: boolean;
  dataGovernanceEscalation: boolean;
  standardsChangeProposed: boolean;
  standardsChangeDetail: string;
};

const STEPS = [
  { label: "Request", blurb: "Who is asking, and when it starts." },
  { label: "Solution", blurb: "The problem, and what is being built." },
  { label: "Architecture", blurb: "What it runs on, and what it talks to." },
  { label: "Impact", blurb: "What it costs, and what it changes." },
] as const;

/** Which fields each step owns. The step sends exactly these and nothing else,
 *  which is what makes a per-step save safe. */
const FIELDS: readonly (readonly (keyof Draft)[])[] = [
  ["title", "summary", "team", "plannedStart"],
  ["problemStatement", "solutionOverview"],
  [
    "technologies",
    "newTechnologyComponent",
    "newTechnologyComponentName",
    "replacesTechnologyComponent",
    "replacedTechnologyComponentName",
    "integrationPoints",
    "authMechanism",
    "dataStores",
    "dataClassification",
    "newOrDuplicatedStorage",
    "hostingEnvironment",
  ],
  [
    "estimatedCost",
    "newLicenceRequired",
    "newLicenceVendor",
    "linesOfBusiness",
    "newBusinessCapability",
    "regulatoryImpact",
    "regulatoryImpactDetail",
    "securityDomainChange",
    "securityDomainChangeDetail",
    "applicationDecommissioned",
    "applicationDecommissionedName",
    "applicationCriticality",
    "newApplicationStandard",
    "dataGovernanceEscalation",
    "standardsChangeProposed",
    "standardsChangeDetail",
  ],
];

const CRITICALITY = [
  { value: "standard", label: "Standard" },
  { value: "business_critical", label: "Business-Critical" },
  { value: "mission_critical", label: "Mission-Critical" },
];

const input = cn(
  "w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink",
  "placeholder:text-ink/40",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid",
);

function Label({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <span className="mb-1 block">
      <span className="block text-[12.5px] font-medium text-ink">{children}</span>
      {hint && <span className="block text-[11.5px] text-ink/55">{hint}</span>}
    </span>
  );
}

function Text({
  label,
  hint,
  value,
  onChange,
  placeholder,
  rows,
  type,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  type?: string;
}) {
  return (
    <label className="block">
      <Label hint={hint}>{label}</Label>
      {rows ? (
        <textarea
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={cn(input, "resize-y leading-relaxed")}
        />
      ) : (
        <input
          type={type ?? "text"}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={input}
        />
      )}
    </label>
  );
}

/**
 * A yes/no answer, with the follow-up it opens.
 *
 * The follow-up is shown only on "yes", because that is the only case it is
 * asked in — and it is *kept* when the answer goes back to no, so a mis-click
 * does not throw away what somebody typed. Submitting ignores it: `answer()` in
 * render-request.ts writes the detail only alongside a yes.
 */
function YesNo({
  label,
  hint,
  value,
  onChange,
  detail,
  detailLabel,
  onDetail,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  detail?: string;
  detailLabel?: string;
  onDetail?: (next: string) => void;
}) {
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <div className="flex gap-2">
        {[
          { label: "No", on: false },
          { label: "Yes", on: true },
        ].map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => onChange(option.on)}
            aria-pressed={value === option.on}
            className={cn(
              "rounded-full border px-4 py-1 text-[12.5px] transition-colors cursor-pointer",
              value === option.on
                ? "border-royal-mid bg-royal/10 text-royal font-medium"
                : "border-line text-ink/70 hover:text-ink",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {value && onDetail && (
        <div className="mt-2">
          <input
            value={detail ?? ""}
            placeholder={detailLabel}
            onChange={(event) => onDetail(event.target.value)}
            className={input}
          />
        </div>
      )}
    </div>
  );
}

export function IntakeWizard({
  draft,
  missing,
  canEdit,
}: {
  draft: Draft;
  /** How many answers the server says are still outstanding. Only the count is
   *  needed here — the list itself is printed by the page, which is where it
   *  belongs and where somebody can read it from any step. */
  missing: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Draft>(draft);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  /** Only this step's fields, which is what makes saving one step safe. */
  function slice(index: number): UpdateInput {
    const out: Record<string, unknown> = {};
    for (const field of FIELDS[index]!) out[field] = form[field];
    return out as UpdateInput;
  }

  function save(index: number, then?: () => void) {
    startTransition(async () => {
      const result = await saveRequest(form.id, slice(index));
      if (result.ok) {
        setMessage(null);
        then?.();
        router.refresh();
      } else {
        setMessage({ ok: false, text: result.message });
      }
    });
  }

  function send() {
    startTransition(async () => {
      // This step's answers first: somebody who types into the last field and
      // presses Submit expects that field to be in what they submitted.
      const saved = await saveRequest(form.id, slice(step));
      if (!saved.ok) {
        setMessage({ ok: false, text: saved.message });
        return;
      }
      const result = await submit(form.id);
      setMessage({ ok: result.ok, text: result.message });
      router.refresh();
    });
  }

  const last = step === STEPS.length - 1;

  return (
    <div className="rounded-xl border border-line bg-card">
      {/* Steps, and where this one sits. A bar rather than a list: four is few
          enough to show them all, and a person filling one in wants to know how
          much is left. */}
      <ol className="flex flex-wrap gap-1 border-b border-line px-3 py-2.5">
        {STEPS.map((entry, index) => (
          <li key={entry.label}>
            <button
              type="button"
              disabled={pending}
              onClick={() => save(step, () => setStep(index))}
              className={cn(
                "rounded-full px-3 py-1 text-[12.5px] transition-colors cursor-pointer",
                index === step
                  ? "bg-royal text-white font-medium"
                  : "text-ink/65 hover:text-ink hover:bg-canvas-sunk",
              )}
            >
              <span className="tabular-nums opacity-70">{index + 1}</span> {entry.label}
            </button>
          </li>
        ))}
      </ol>

      <div className="px-4 py-4">
        <p className="mb-4 text-[12.5px] text-ink/60">{STEPS[step]!.blurb}</p>

        {step === 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Text
              label="Request title"
              value={form.title}
              onChange={(v) => set("title", v)}
              placeholder="Customer Portal Upgrade"
            />
            <Text
              label="Your team"
              value={form.team}
              onChange={(v) => set("team", v)}
              placeholder="Digital Channels"
            />
            <div className="sm:col-span-2">
              <Text
                label="Short description"
                hint="One line, for whoever opens this next."
                value={form.summary}
                onChange={(v) => set("summary", v)}
              />
            </div>
            <Text
              label="Planned implementation start"
              hint="Read by the Time Impact criterion."
              type="date"
              value={form.plannedStart}
              onChange={(v) => set("plannedStart", v)}
            />
          </div>
        )}

        {step === 1 && (
          <div className="grid gap-4">
            <Text
              label="Problem statement"
              hint="Why this is being done, and what it is for."
              rows={4}
              value={form.problemStatement}
              onChange={(v) => set("problemStatement", v)}
            />
            <Text
              label="Solution overview"
              hint="The components and how they interact. This is the text the compliance check runs against, so the more it says the more the review can find."
              rows={10}
              value={form.solutionOverview}
              onChange={(v) => set("solutionOverview", v)}
            />
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Text
                label="Technologies and platforms"
                hint="Separated by commas."
                value={form.technologies.join(", ")}
                onChange={(v) => set("technologies", v.split(",").map((t) => t.trim()))}
                placeholder="React, Node.js, PostgreSQL 16, Kubernetes"
              />
            </div>
            <YesNo
              label="Is a new technology component introduced?"
              value={form.newTechnologyComponent}
              onChange={(v) => set("newTechnologyComponent", v)}
              detail={form.newTechnologyComponentName}
              detailLabel="Which one?"
              onDetail={(v) => set("newTechnologyComponentName", v)}
            />
            <YesNo
              label="Is an existing component being replaced?"
              value={form.replacesTechnologyComponent}
              onChange={(v) => set("replacesTechnologyComponent", v)}
              detail={form.replacedTechnologyComponentName}
              detailLabel="Which one?"
              onDetail={(v) => set("replacedTechnologyComponentName", v)}
            />
            <div className="sm:col-span-2">
              <Text
                label="Integration points and external systems"
                rows={3}
                value={form.integrationPoints}
                onChange={(v) => set("integrationPoints", v)}
              />
            </div>
            <div className="sm:col-span-2">
              <Text
                label="Authentication and authorisation"
                hint="How people and services sign in, and what they are allowed to do."
                rows={3}
                value={form.authMechanism}
                onChange={(v) => set("authMechanism", v)}
              />
            </div>
            <div className="sm:col-span-2">
              <Text
                label="Data stores used"
                rows={3}
                value={form.dataStores}
                onChange={(v) => set("dataStores", v)}
              />
            </div>
            <Text
              label="Data classification"
              value={form.dataClassification}
              onChange={(v) => set("dataClassification", v)}
              placeholder="Confidential"
            />
            <YesNo
              label="Is new or duplicated data storage introduced?"
              value={form.newOrDuplicatedStorage}
              onChange={(v) => set("newOrDuplicatedStorage", v)}
            />
            <div className="sm:col-span-2">
              <Text
                label="Hosting and deployment environment"
                rows={2}
                value={form.hostingEnvironment}
                onChange={(v) => set("hostingEnvironment", v)}
              />
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Text
              label="Estimated cost"
              hint="Compared against your organisation's governance threshold."
              value={form.estimatedCost}
              onChange={(v) => set("estimatedCost", v)}
              placeholder="7,500,000"
            />
            <YesNo
              label="Is a new software licence required?"
              value={form.newLicenceRequired}
              onChange={(v) => set("newLicenceRequired", v)}
              detail={form.newLicenceVendor}
              detailLabel="Which vendor?"
              onDetail={(v) => set("newLicenceVendor", v)}
            />
            <div className="sm:col-span-2">
              <Text
                label="Lines of business affected"
                hint="Separated by commas."
                value={form.linesOfBusiness.join(", ")}
                onChange={(v) => set("linesOfBusiness", v.split(",").map((t) => t.trim()))}
                placeholder="Retail, Wholesale"
              />
            </div>
            <YesNo
              label="Is a new business capability introduced?"
              value={form.newBusinessCapability}
              onChange={(v) => set("newBusinessCapability", v)}
            />
            <YesNo
              label="Is there a regulatory impact?"
              value={form.regulatoryImpact}
              onChange={(v) => set("regulatoryImpact", v)}
              detail={form.regulatoryImpactDetail}
              detailLabel="What is it?"
              onDetail={(v) => set("regulatoryImpactDetail", v)}
            />
            <YesNo
              label="Is there a major change in the security domain?"
              hint="One that would need a higher-tier approval or risk assessment."
              value={form.securityDomainChange}
              onChange={(v) => set("securityDomainChange", v)}
              detail={form.securityDomainChangeDetail}
              detailLabel="What changes?"
              onDetail={(v) => set("securityDomainChangeDetail", v)}
            />
            <YesNo
              label="Is an application decommissioned or replaced?"
              value={form.applicationDecommissioned}
              onChange={(v) => set("applicationDecommissioned", v)}
              detail={form.applicationDecommissionedName}
              detailLabel="Which one?"
              onDetail={(v) => set("applicationDecommissionedName", v)}
            />
            <label className="block">
              <Label>Criticality of the affected application</Label>
              <select
                value={form.applicationCriticality}
                onChange={(event) => set("applicationCriticality", event.target.value)}
                className={cn(input, "cursor-pointer")}
              >
                {CRITICALITY.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <YesNo
              label="Is a new application standard required?"
              value={form.newApplicationStandard}
              onChange={(v) => set("newApplicationStandard", v)}
            />
            <YesNo
              label="Does this follow an escalation from Data & Information Governance?"
              value={form.dataGovernanceEscalation}
              onChange={(v) => set("dataGovernanceEscalation", v)}
            />
            <div className="sm:col-span-2">
              <YesNo
                label="Is a change to an existing principle or standard proposed?"
                value={form.standardsChangeProposed}
                onChange={(v) => set("standardsChangeProposed", v)}
                detail={form.standardsChangeDetail}
                detailLabel="Which one, and what changes?"
                onDetail={(v) => set("standardsChangeDetail", v)}
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
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

        <div className="flex shrink-0 items-center gap-2">
          {step > 0 && (
            <button
              type="button"
              disabled={pending}
              onClick={() => save(step, () => setStep(step - 1))}
              className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px] text-ink/70 hover:text-ink hover:bg-canvas-sunk cursor-pointer disabled:opacity-50"
            >
              <ChevronLeft size={14} aria-hidden="true" />
              Back
            </button>
          )}

          {!last ? (
            <button
              type="button"
              disabled={pending || !canEdit}
              onClick={() => save(step, () => setStep(step + 1))}
              className="inline-flex items-center gap-1.5 rounded-full bg-royal px-4 py-1.5 text-[13px] font-medium text-white cursor-pointer disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save and continue"}
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={pending || !canEdit}
                onClick={() => save(step)}
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-1.5 text-[13px] text-ink/80 hover:text-ink cursor-pointer disabled:opacity-50"
              >
                <Check size={14} aria-hidden="true" />
                Save draft
              </button>
              <button
                type="button"
                disabled={pending || !canEdit || missing > 0}
                onClick={send}
                title={missing > 0 ? "Some answers are still needed." : undefined}
                className="inline-flex items-center gap-1.5 rounded-full bg-royal px-4 py-1.5 text-[13px] font-medium text-white cursor-pointer disabled:opacity-50"
              >
                <Send size={14} aria-hidden="true" />
                {pending ? "Submitting…" : "Submit for review"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
