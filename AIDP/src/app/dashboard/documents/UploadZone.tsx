"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, TriangleAlert, X } from "lucide-react";
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
 * Where the glow comes from says which group you are dropping into.
 *
 * Reference standards are the yardstick, so their light falls from above;
 * submissions are held up to be measured, so theirs rises from below. The hue
 * is the same royal accent in both — the palette carries one accent on purpose,
 * and a second colour would read as a status rather than a category.
 */
const FIELD: Record<Role, { wash: string; ring: string; ringActive: string }> = {
  reference: {
    wash: "radial-gradient(120% 130% at 50% -10%, rgba(124,58,237,0.30), rgba(109,40,217,0.10) 45%, transparent 72%)",
    ring: "linear-gradient(160deg, rgba(167,139,250,0.34), rgba(255,255,255,0.05) 44%, transparent 72%)",
    ringActive:
      "linear-gradient(160deg, rgba(196,181,253,0.95), rgba(139,92,246,0.55) 50%, rgba(167,139,250,0.35))",
  },
  assessed: {
    wash: "radial-gradient(120% 130% at 50% 110%, rgba(124,58,237,0.26), rgba(109,40,217,0.08) 45%, transparent 72%)",
    ring: "linear-gradient(20deg, rgba(167,139,250,0.32), rgba(255,255,255,0.05) 44%, transparent 72%)",
    ringActive:
      "linear-gradient(20deg, rgba(196,181,253,0.95), rgba(139,92,246,0.55) 50%, rgba(167,139,250,0.35))",
  },
};

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

  const pending = receipts.filter((r) => r.state === "uploading").length;
  const busy = pending > 0;
  const armed = dragging || busy;
  const field = FIELD[role];
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
        style={
          {
            "--ring": armed ? field.ringActive : field.ring,
          } as React.CSSProperties
        }
        className={cn(
          "ring-gradient group relative block w-full overflow-hidden rounded-xl",
          "bg-ink-950/40 px-4 py-7 text-center",
          "transition-[box-shadow,transform,background-color] duration-300",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
          armed
            ? "bg-royal/[0.07] shadow-[0_0_0_1px_rgba(139,92,246,0.10),0_26px_70px_-40px_rgba(139,92,246,0.85)]"
            : "hover:bg-white/[0.02] hover:shadow-[0_20px_60px_-46px_rgba(139,92,246,0.7)]",
        )}
      >
        {/* Light field. Drifts continuously but slowly, and lifts on contact —
            the panel should feel live before it is touched, not only after. */}
        <span
          aria-hidden="true"
          className={cn(
            "aurora pointer-events-none absolute inset-0 transition-opacity duration-500",
            armed ? "opacity-100" : "opacity-45 group-hover:opacity-75",
          )}
          style={{ backgroundImage: field.wash }}
        />

        {/* The beam. Only while something is genuinely in motion. */}
        {armed && (
          <span
            aria-hidden="true"
            className="beam pointer-events-none absolute inset-x-0 top-0 h-px"
          />
        )}

        {/* pointer-events-none matters: without it, dragging across the icon or
            the label fires dragleave on the button and the panel flickers. */}
        <span className="pointer-events-none relative flex flex-col items-center gap-3.5">
          <SheetStack armed={armed} />

          <span className="flex flex-col items-center gap-1">
            <span className="text-[13.5px] font-medium text-white/85">
              {dragging
                ? "Drop to upload"
                : busy
                  ? `Uploading ${pending} file${pending === 1 ? "" : "s"}`
                  : label}
            </span>
            <span className="text-[11.5px] text-white/35">
              {busy ? "Queued in order" : `PDF · up to ${formatSize(MAX_BYTES)}`}
            </span>
          </span>
        </span>
      </button>

      {receipts.length > 0 && (
        <ul aria-live="polite" className="mt-2 space-y-1.5">
          {receipts.map((r) => (
            <li
              key={r.id}
              className={cn(
                "ring-gradient relative overflow-hidden rounded-lg px-2.5 py-2 text-[12px]",
                r.state === "error"
                  ? "bg-amber-400/[0.06] [--ring:linear-gradient(120deg,rgba(251,191,36,0.5),rgba(251,191,36,0.12)_60%,transparent)]"
                  : "bg-white/[0.02]",
              )}
            >
              <span className="flex items-center gap-2">
                {r.state === "error" ? (
                  <TriangleAlert size={12} className="shrink-0 text-amber-400/85" />
                ) : (
                  <PageGlyph muted={r.state !== "uploading"} />
                )}
                <span className="min-w-0 flex-1 truncate text-white/70">{r.name}</span>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    r.state === "error" ? "text-amber-300/85" : "text-white/35",
                  )}
                >
                  {r.message ?? formatSize(r.size)}
                </span>
                <button
                  type="button"
                  onClick={() => setReceipts((p) => p.filter((x) => x.id !== r.id))}
                  aria-label={`Dismiss ${r.name}`}
                  className="shrink-0 rounded text-white/25 transition-colors hover:text-white/70"
                >
                  <X size={12} />
                </button>
              </span>

              {/* Indeterminate by design — one multipart request has no
                  meaningful percentage to report. */}
              {r.state === "uploading" && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 block h-px overflow-hidden bg-white/[0.06]"
                >
                  <span className="rail-slide block h-full w-1/4 bg-linear-to-r from-transparent via-royal-soft to-transparent" />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Three sheets, fanned. Drawn rather than borrowed from the icon set: every
 * other mark on this page is a 1.9-weight lucide outline, and the one thing the
 * page is actually for deserves to look like the artifact it accepts.
 */
function SheetStack({ armed }: { armed: boolean }) {
  const sheet =
    "absolute inset-0 rounded-[3px] border transition-[transform,border-color,background-color] duration-500 ease-out";

  return (
    <span
      aria-hidden="true"
      className="relative block h-10 w-8"
    >
      <span
        className={cn(
          sheet,
          "border-white/10 bg-white/[0.03]",
          armed ? "-translate-x-2.5 -rotate-12" : "-translate-x-1 -rotate-6 group-hover:-translate-x-2 group-hover:-rotate-[9deg]",
        )}
      />
      <span
        className={cn(
          sheet,
          "border-white/12 bg-white/[0.04]",
          armed ? "translate-x-2.5 rotate-12" : "translate-x-1 rotate-6 group-hover:translate-x-2 group-hover:rotate-[9deg]",
        )}
      />
      <span
        className={cn(
          sheet,
          "border-white/20 bg-linear-to-b from-white/[0.14] to-white/[0.04] backdrop-blur-sm",
          armed && "border-royal-soft/70 shadow-[0_0_22px_-4px_rgba(167,139,250,0.9)]",
        )}
      >
        {/* Ruled lines, so the sheet reads as a document rather than a card. */}
        <span className="absolute inset-x-1.5 top-2 h-px bg-white/25" />
        <span className="absolute inset-x-1.5 top-3.5 h-px bg-white/18" />
        <span className="absolute inset-x-1.5 top-5 h-px bg-white/12" />
      </span>
    </span>
  );
}

function PageGlyph({ muted }: { muted: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block size-3 shrink-0 rounded-[2px] border",
        muted
          ? "border-white/20 bg-white/[0.05]"
          : "border-royal-soft/60 bg-linear-to-b from-royal-soft/40 to-transparent",
      )}
    />
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
