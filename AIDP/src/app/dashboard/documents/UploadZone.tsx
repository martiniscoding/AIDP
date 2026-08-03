"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, FileText, Loader2, Plus, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Role = "reference" | "assessed";

type Receipt = {
  id: string;
  name: string;
  size: number;
  state: "uploading" | "duplicate" | "error";
  message?: string;
};

const MAX_BYTES = 64 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / 1024 / 1024;
    return `${mb >= 10 || Number.isInteger(mb) ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * A drop target that *is* its role.
 *
 * There used to be one dropzone with a reference/assessed chooser beside it.
 * That put a mode switch between the person and the thing they were doing, and
 * a mis-set chooser is silent — the document ingests perfectly and simply never
 * appears where they expect. Two zones, each labelled with what belongs in it,
 * removes the mode entirely: you drop into the group you mean.
 */
export function UploadZone({ role, label }: { role: Role; label: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [, startTransition] = useTransition();

  const upload = useCallback(
    async (files: File[]) => {
      const accepted: File[] = [];
      const rejected: Receipt[] = [];

      for (const file of files) {
        const id = `${file.name}-${file.size}-${Math.random()}`;
        const isPdf =
          file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        if (!isPdf) {
          rejected.push({ id, name: file.name, size: file.size, state: "error", message: "Not a PDF" });
        } else if (file.size > MAX_BYTES) {
          rejected.push({
            id,
            name: file.name,
            size: file.size,
            state: "error",
            message: `Over ${formatSize(MAX_BYTES)}`,
          });
        } else {
          accepted.push(file);
        }
      }

      const queued: Receipt[] = accepted.map((f) => ({
        id: `${f.name}-${f.size}-${Math.random()}`,
        name: f.name,
        size: f.size,
        state: "uploading",
      }));
      setReceipts((prev) => [...prev, ...queued, ...rejected]);

      // Sequential: each body is multi-megabyte, and the pipeline behind them is
      // a queue, so parallel requests would be serialised a moment later anyway.
      for (const [index, file] of accepted.entries()) {
        const receiptId = queued[index]!.id;
        const body = new FormData();
        body.append("file", file);
        body.append("role", role);

        const settle = (state: Receipt["state"], message?: string) =>
          setReceipts((prev) =>
            prev.map((r) => (r.id === receiptId ? { ...r, state, message } : r)),
          );
        // A successful upload drops its receipt — the row appears in the list a
        // moment later, and reporting the same file twice reads as accepting it
        // twice. Errors and duplicates stay; they say what the list cannot.
        const discard = () => setReceipts((prev) => prev.filter((r) => r.id !== receiptId));

        try {
          const res = await fetch("/api/documents/upload", { method: "POST", body });
          const json = (await res.json()) as { error?: string; duplicate?: boolean };
          if (!res.ok) settle("error", json.error ?? "Upload failed");
          else if (json.duplicate) settle("duplicate", "Already on record");
          else discard();
        } catch {
          settle("error", "Network error");
        }
      }

      startTransition(() => router.refresh());
    },
    [role, router],
  );

  const busy = receipts.some((r) => r.state === "uploading");
  const openPicker = () => inputRef.current?.click();

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="sr-only"
        onChange={(event) => {
          void upload(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      <button
        type="button"
        onClick={openPicker}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg border border-dashed px-3.5 py-2.5 text-left",
          "text-[13px] transition-colors duration-200",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
          dragging
            ? "border-royal-mid/60 bg-royal/[0.08] text-white"
            : "border-white/12 text-white/45 hover:border-white/28 hover:text-white/75",
        )}
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin text-royal-soft" />
        ) : (
          <Plus size={14} />
        )}
        {dragging ? "Drop to upload" : label}
        <span className="ml-auto text-[11.5px] text-white/25">PDF</span>
      </button>

      {receipts.length > 0 && (
        <ul aria-live="polite" className="mt-1.5 space-y-1">
          {receipts.map((r) => (
            <li
              key={r.id}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px]",
                r.state === "error"
                  ? "border-amber-400/25 bg-amber-400/[0.05]"
                  : "border-white/[0.08] bg-white/[0.02]",
              )}
            >
              {r.state === "uploading" ? (
                <Loader2 size={12} className="animate-spin text-white/35" />
              ) : r.state === "error" ? (
                <TriangleAlert size={12} className="text-amber-400/85" />
              ) : (
                <FileText size={12} className="text-white/40" />
              )}
              <span className="min-w-0 flex-1 truncate text-white/65">{r.name}</span>
              <span className={cn(r.state === "error" ? "text-amber-300/85" : "text-white/35")}>
                {r.message ?? "Uploading…"}
              </span>
              <button
                type="button"
                onClick={() => setReceipts((p) => p.filter((x) => x.id !== r.id))}
                aria-label={`Dismiss ${r.name}`}
                className="rounded text-white/25 transition-colors hover:text-white/70"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shown once a document has finished, in place of the progress rail. */
export function ReadyTick() {
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-royal-soft">
      <Check size={11} />
      Indexed
    </span>
  );
}
