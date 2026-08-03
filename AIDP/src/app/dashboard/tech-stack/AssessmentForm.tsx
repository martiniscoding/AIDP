"use client";

import { useActionState, useEffect, useMemo, useRef, useState, startTransition } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { OptionGrid } from "@/components/tech-stack/OptionGrid";
import { PlatformMatrix } from "@/components/tech-stack/PlatformMatrix";
import { cn } from "@/lib/cn";
import {
  BI_REPORTING,
  DATA_SOURCES,
  DATA_WAREHOUSING,
  PRIMARY_CLOUD,
  WORKLOADS,
} from "@/lib/tech-stack/catalog";
import { sectionProgress, type AssessmentInput } from "@/lib/tech-stack/schema";
import { saveAssessment } from "./actions";

const SECTIONS = [
  { id: "client", n: "01", title: "Client information" },
  { id: "infrastructure", n: "02", title: "Current data infrastructure" },
  { id: "workloads", n: "03", title: "Workload requirements" },
  { id: "platforms", n: "04", title: "Platform preferences" },
  { id: "notes", n: "05", title: "Additional references" },
] as const;

export function AssessmentForm({
  initial,
  initialSavedAt,
}: {
  initial: AssessmentInput;
  initialSavedAt: string | null;
}) {
  const [form, setForm] = useState<AssessmentInput>(initial);
  const [state, runSave, pending] = useActionState(saveAssessment, null);
  const [activeSection, setActiveSection] = useState<string>("client");

  // Snapshot of what the server currently holds, so the bar can distinguish
  // "nothing to save" from "you have unsaved edits".
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(initial));
  const [savedAt, setSavedAt] = useState<string | null>(initialSavedAt);

  const dirty = JSON.stringify(form) !== savedSnapshot;

  // The exact payload that went to the server, kept so the snapshot records
  // what was *saved* rather than what is on screen when the response lands.
  // Typing during an in-flight save would otherwise be marked as saved and
  // silently lost on navigation.
  const inFlight = useRef<string | null>(null);
  const pendingRef = useRef(pending);

  useEffect(() => {
    if (pendingRef.current && !pending && state?.ok && inFlight.current) {
      setSavedSnapshot(inFlight.current);
      setSavedAt(state.savedAt);
      inFlight.current = null;
    }
    pendingRef.current = pending;
  }, [pending, state]);

  const progress = useMemo(
    () => sectionProgress(form),
    [form],
  );
  const doneCount = progress.filter((section) => section.done).length;

  // Scroll-spy for the rail. Observing a band across the upper half of the
  // viewport means the highlight changes as a section's heading passes the
  // reading line, not when its last pixel leaves the screen.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: "-12% 0px -60% 0px", threshold: 0 },
    );

    for (const section of SECTIONS) {
      const node = document.getElementById(section.id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, []);

  function set<K extends keyof AssessmentInput>(key: K, value: AssessmentInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(intent: "save" | "submit") {
    const payload = { ...form, intent };
    setForm(payload);
    inFlight.current = JSON.stringify(payload);
    startTransition(() => runSave(payload));
  }

  const errors = state?.ok === false ? state.errors : {};

  return (
    <div className="grid gap-10 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-14">
      {/* ---- Progress rail ------------------------------------------------ */}
      <aside className="lg:sticky lg:top-8 lg:self-start">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/35">
          {doneCount} of {progress.length} complete
        </p>

        <ol className="mt-4 space-y-0.5">
          {SECTIONS.map((section, index) => {
            const done = progress[index]?.done ?? false;
            const active = activeSection === section.id;
            const optional = index === SECTIONS.length - 1;

            return (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className={cn(
                    "group flex items-start gap-3 rounded-lg py-2 pl-1 pr-2 transition-colors duration-200",
                    active ? "bg-white/[0.05]" : "hover:bg-white/[0.03]",
                  )}
                >
                  {/* The connector is drawn per-item so the rail reads as one
                      continuous line without a separate absolutely-positioned
                      element to keep in sync. */}
                  <span className="relative flex flex-col items-center self-stretch">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "z-10 grid size-5 place-items-center rounded-full border text-[9px] font-semibold transition-colors duration-300",
                        done
                          ? "border-royal-mid bg-royal-mid text-white"
                          : active
                            ? "border-white/45 text-white/80"
                            : "border-white/15 text-white/35",
                      )}
                    >
                      {done ? <Check size={11} strokeWidth={3.5} /> : section.n}
                    </span>
                    {index < SECTIONS.length - 1 ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "w-px flex-1 transition-colors duration-300",
                          done ? "bg-royal-mid/45" : "bg-white/10",
                        )}
                      />
                    ) : null}
                  </span>

                  <span
                    className={cn(
                      "-mt-0.5 pb-3 text-[13px] leading-snug transition-colors duration-200",
                      active ? "text-white" : "text-white/50 group-hover:text-white/75",
                    )}
                  >
                    {section.title}
                    {optional ? (
                      <span className="block text-[11px] text-white/30">Optional</span>
                    ) : null}
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      </aside>

      {/* ---- Sections ----------------------------------------------------- */}
      <div className="min-w-0 space-y-14 pb-40">
        <Section
          id="client"
          n="01"
          title="Client information"
          blurb="Who this reference belongs to. We pre-filled what we already had from your account."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Company name"
              value={form.companyName}
              error={errors.companyName}
              onChange={(event) => set("companyName", event.target.value)}
              placeholder="Northwind Logistics"
            />
            <Field
              label="Primary contact"
              value={form.primaryContact}
              error={errors.primaryContact}
              onChange={(event) => set("primaryContact", event.target.value)}
              placeholder="Priya Raman"
            />
            <Field
              label="Role / title"
              value={form.roleTitle}
              onChange={(event) => set("roleTitle", event.target.value)}
              placeholder="Head of Data Platform"
            />
            <Field
              label="Date completed"
              type="date"
              value={form.dateCompleted}
              onChange={(event) => set("dateCompleted", event.target.value)}
            />
          </div>
        </Section>

        <Section
          id="infrastructure"
          n="02"
          title="Current data infrastructure"
          blurb="Pick everything that applies. If something is missing, add it — the list is a starting point, not a menu."
        >
          <div className="space-y-9">
            <OptionGrid
              label="Data sources"
              description="Systems that produce the data you work with."
              options={DATA_SOURCES}
              value={form.dataSources}
              onChange={(next) => set("dataSources", next)}
              addLabel="Add a source"
            />
            <OptionGrid
              label="Data warehousing"
              description="Where that data lands today."
              options={DATA_WAREHOUSING}
              value={form.dataWarehousing}
              onChange={(next) => set("dataWarehousing", next)}
              addLabel="Add a warehouse"
            />
            <OptionGrid
              label="Business intelligence & reporting"
              description="How people consume it."
              options={BI_REPORTING}
              value={form.biReporting}
              onChange={(next) => set("biReporting", next)}
              addLabel="Add a tool"
            />
            <OptionGrid
              label="Primary cloud ecosystem"
              options={PRIMARY_CLOUD}
              value={form.primaryCloud}
              onChange={(next) => set("primaryCloud", next)}
              addLabel="Add a provider"
            />
          </div>
        </Section>

        <Section
          id="workloads"
          n="03"
          title="Workload requirements"
          blurb="The work your team actually does. Select all that apply."
        >
          <OptionGrid
            label="Primary workloads"
            options={WORKLOADS}
            value={form.workloads}
            onChange={(next) => set("workloads", next)}
            addLabel="Add a workload"
          />
        </Section>

        <Section
          id="platforms"
          n="04"
          title="Platform preferences & references"
          blurb="Where you are today, and where you'd like to go. Leave a row blank if you have no view yet."
        >
          <PlatformMatrix
            value={form.platforms}
            onChange={(next) => set("platforms", next)}
          />
        </Section>

        <Section
          id="notes"
          n="05"
          title="Additional references & specific needs"
          blurb="Technical constraints, compliance requirements (HIPAA, GDPR), or existing vendor agreements we should design around."
        >
          <textarea
            value={form.additionalNotes}
            onChange={(event) => set("additionalNotes", event.target.value)}
            rows={7}
            maxLength={4000}
            placeholder="We're bound by GDPR and data residency in the EU. Existing three-year Snowflake agreement runs to 2028…"
            aria-label="Additional references and specific needs"
            className={cn(
              "w-full resize-y rounded-xl border border-white/12 bg-white/[0.03] px-3.5 py-3 text-[15px] leading-relaxed text-white",
              "placeholder:text-white/25 transition-[border-color,box-shadow,background-color] duration-200",
              "hover:border-white/20 focus:border-royal-mid/70 focus:bg-white/[0.05] focus:outline-none",
              "focus:shadow-[0_0_0_3px_rgba(124,58,237,0.25)]",
            )}
          />
          <p className="mt-2 text-right text-[11.5px] text-white/30">
            {form.additionalNotes.length} / 4000
          </p>
        </Section>
      </div>

      {/* ---- Save bar ------------------------------------------------------ */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 lg:col-span-2">
        <div className="mx-auto max-w-6xl px-6 pb-5">
          <div className="pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-white/12 bg-ink-800/85 px-4 py-3 backdrop-blur-xl">
            <StatusLine
              pending={pending}
              dirty={dirty}
              savedAt={savedAt}
              error={state?.ok === false ? state.message : null}
              submitted={form.intent === "submit" && state?.ok === true}
            />

            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pending || !dirty}
                onClick={() => submit("save")}
              >
                Save draft
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pending}
                onClick={() => submit("submit")}
              >
                {pending ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : null}
                Submit reference
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  id,
  n,
  title,
  blurb,
  children,
}: {
  id: string;
  n: string;
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8">
      <header className="mb-5 border-b border-white/[0.08] pb-4">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-[12px] font-medium tabular-nums text-royal-soft/70">
            {n}
          </span>
          <h2 className="font-display text-[22px] font-semibold tracking-tight text-white">
            {title}
          </h2>
        </div>
        <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-white/45">
          {blurb}
        </p>
      </header>
      {children}
    </section>
  );
}

function StatusLine({
  pending,
  dirty,
  savedAt,
  error,
  submitted,
}: {
  pending: boolean;
  dirty: boolean;
  savedAt: string | null;
  error: string | null;
  submitted: boolean;
}) {
  if (pending) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-white/60">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        Saving…
      </p>
    );
  }

  if (error) {
    return (
      <p role="alert" className="flex items-center gap-2 text-[13px] text-rose-300">
        <AlertCircle size={14} aria-hidden="true" />
        {error}
      </p>
    );
  }

  if (dirty) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-white/50">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-300/80" />
        Unsaved changes
      </p>
    );
  }

  if (submitted) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-emerald-300/90">
        <Check size={14} aria-hidden="true" />
        Reference submitted
      </p>
    );
  }

  return (
    <p className="flex items-center gap-2 text-[13px] text-white/40">
      <Check size={14} aria-hidden="true" className="text-emerald-300/70" />
      {savedAt ? `Saved ${formatSavedAt(savedAt)}` : "Nothing to save yet"}
    </p>
  );
}

function formatSavedAt(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
