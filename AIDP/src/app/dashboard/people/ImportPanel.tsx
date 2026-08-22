"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, FileSpreadsheet, Upload, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ParsedSheet } from "@/lib/access/spreadsheet";
import { confirmImport, previewImport } from "./actions";

const ACCEPT = ".xlsx,.csv,.txt";
const MAX_MB = 5;

/**
 * Loading a staff list.
 *
 * Two steps, never one. The parser has to guess which column is which, and an
 * administrator about to add two hundred people to their workspace should see
 * that guess — and the rows it could not read — before anything is written.
 * A silent import that quietly dropped forty rows would be discovered weeks
 * later by the forty people who cannot sign in.
 *
 * The preview also states the thing that surprises people: importing grants
 * nothing. Everyone arrives with no access, and admitting them is a separate,
 * deliberate act.
 */
export function ImportPanel() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<{ sheet: ParsedSheet; filename: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const send = (file: File) => {
    setError(null);
    setDone(null);

    if (file.size > MAX_MB * 1024 * 1024) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_MB}MB.`);
      return;
    }

    const formData = new FormData();
    formData.set("file", file);
    startTransition(async () => {
      const result = await previewImport(formData);
      if (result.ok) setPreview({ sheet: result.preview, filename: result.filename });
      else setError(result.message);
    });
  };

  const commit = () => {
    if (!preview) return;
    startTransition(async () => {
      const result = await confirmImport(preview.sheet.people);
      if (result.ok) {
        setPreview(null);
        setDone(result.message);
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  };

  if (preview) {
    return (
      <Preview
        sheet={preview.sheet}
        filename={preview.filename}
        pending={pending}
        error={error}
        onCancel={() => {
          setPreview(null);
          setError(null);
        }}
        onConfirm={commit}
      />
    );
  }

  return (
    <section className="mb-2">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) send(file);
        }}
        className={cn(
          "relative overflow-hidden rounded-2xl border border-dashed p-6 transition-colors",
          dragging
            ? "border-royal-mid/60 bg-royal/[0.08]"
            : "border-line bg-card hover:border-line-strong",
        )}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-20 size-52 rounded-full bg-royal/8 blur-3xl"
        />

        <div className="relative flex flex-wrap items-center gap-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-royal-mid/30 bg-royal/10 text-royal">
            <FileSpreadsheet size={18} strokeWidth={1.9} />
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-ink/92">
              Load your staff list
            </p>
            <p className="mt-0.5 text-[12.5px] text-ink/66">
              Drop an Excel or CSV export here. We find the email column
              ourselves — no template needed. Nobody gets access until you admit
              them.
            </p>
          </div>

          <button
            type="button"
            disabled={pending}
            onClick={() => input.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-ink/80 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
          >
            <Upload size={13} />
            {pending ? "Reading…" : "Choose file"}
          </button>
        </div>

        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) send(file);
            event.target.value = "";
          }}
        />
      </div>

      {error && (
        <p role="alert" className="mt-2.5 text-[12.5px] text-warn">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="mt-2.5 text-[12.5px] text-ok">
          {done}
        </p>
      )}
    </section>
  );
}

function Preview({
  sheet,
  filename,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  sheet: ParsedSheet;
  filename: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [showRejects, setShowRejects] = useState(false);
  const sample = sheet.people.slice(0, 8);

  return (
    <section className="mb-2 rounded-2xl border border-line bg-card shadow-card p-5">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-ok-line bg-ok-tint text-ok">
          <FileSpreadsheet size={16} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-ink/92">
            Found {sheet.people.length} {sheet.people.length === 1 ? "person" : "people"} in{" "}
            {filename}
          </p>
          <p className="mt-0.5 text-[12.5px] text-ink/66">
            Sheet “{sheet.sheetName}”. Check the columns below are the ones you
            expect, then import.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Discard this file"
          className="rounded-md p-1 text-ink/62 transition-colors hover:bg-canvas-sunk hover:text-ink/78"
        >
          <X size={15} />
        </button>
      </div>

      {/* Which column we decided was which. Shown because getting it wrong is
          the most likely failure and the easiest for a human to spot. */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {Object.entries(sheet.columns).map(([field, header]) => (
          <span
            key={field}
            className="rounded-md border border-line bg-card px-2 py-1 text-[11.5px] text-ink/70"
          >
            <span className="text-ink/62">{LABEL[field] ?? field} ←</span> {header}
          </span>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full border-collapse text-left">
          <tbody>
            {sample.map((person) => (
              <tr key={person.email} className="border-b border-line-soft last:border-0">
                <td className="px-3 py-2 text-[12.5px] text-ink/84">{person.name}</td>
                <td className="px-3 py-2 text-[12.5px] text-ink/66">{person.email}</td>
                <td className="px-3 py-2 text-[12px] text-ink/62">
                  {[person.jobTitle, person.department].filter(Boolean).join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.people.length > sample.length && (
          <p className="border-t border-line-soft px-3 py-2 text-[11.5px] text-ink/62">
            and {sheet.people.length - sample.length} more
          </p>
        )}
      </div>

      {sheet.rejected.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowRejects((open) => !open)}
            aria-expanded={showRejects}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-warn transition-colors hover:text-danger"
          >
            <AlertTriangle size={13} />
            {sheet.rejected.length} row{sheet.rejected.length === 1 ? "" : "s"} could not be read
          </button>

          {showRejects && (
            <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto rounded-lg border border-line p-2.5">
              {sheet.rejected.map((rejection) => (
                <li key={`${rejection.row}-${rejection.value}`} className="text-[11.5px] text-ink/64">
                  <span className="text-ink/58">Row {rejection.row}:</span> {rejection.reason}
                  {rejection.value && (
                    <span className="text-ink/58"> — “{rejection.value.slice(0, 60)}”</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[12.5px] text-warn">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="rounded-full bg-royal px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
        >
          {pending ? "Importing…" : `Import ${sheet.people.length}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[12.5px] text-ink/62 transition-colors hover:text-ink/78"
        >
          cancel
        </button>
        <p className="text-[11.5px] text-ink/62">
          They arrive with no access. You choose who gets in afterwards.
        </p>
      </div>
    </section>
  );
}

const LABEL: Record<string, string> = {
  email: "Email",
  name: "Name",
  jobTitle: "Job title",
  department: "Team",
};
