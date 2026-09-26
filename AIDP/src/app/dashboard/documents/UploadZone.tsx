"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { uploadFiles } from "@/lib/uploadthing";

type Role = "reference" | "assessed";

type Receipt = {
  id: string;
  name: string;
  size: number;
  state: "uploading" | "duplicate" | "error";
  message?: string;
};

const MAX_BYTES = 64 * 1024 * 1024;
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / 1024 / 1024;
    return `${mb >= 10 || Number.isInteger(mb) ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Where the wash comes from says which group you are dropping into.
 *
 * Reference standards are the yardstick, so their field falls from above;
 * submissions are held up to be measured, so theirs rises from below. The hue
 * is the same royal accent in both — the palette carries one accent on purpose,
 * and a second colour would read as a status rather than a category.
 *
 * On paper these are pigment rather than light, so they run at roughly half
 * the alpha the dark build used and the lit edge is the *deep* violet: a pale
 * one had nothing to brighten against.
 */
const FIELD: Record<Role, { wash: string; ring: string; ringActive: string }> = {
  reference: {
    wash: "radial-gradient(120% 130% at 50% -10%, rgba(124,58,237,0.14), rgba(109,40,217,0.05) 45%, transparent 72%)",
    ring: "linear-gradient(160deg, rgba(124,58,237,0.34), rgba(26,20,48,0.06) 44%, transparent 72%)",
    ringActive:
      "linear-gradient(160deg, rgba(109,40,217,0.95), rgba(124,58,237,0.55) 50%, rgba(167,139,250,0.45))",
  },
  assessed: {
    wash: "radial-gradient(120% 130% at 50% 110%, rgba(124,58,237,0.12), rgba(109,40,217,0.04) 45%, transparent 72%)",
    ring: "linear-gradient(20deg, rgba(124,58,237,0.32), rgba(26,20,48,0.06) 44%, transparent 72%)",
    ringActive:
      "linear-gradient(20deg, rgba(109,40,217,0.95), rgba(124,58,237,0.55) 50%, rgba(167,139,250,0.45))",
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
export function UploadZone({
  role,
  label,
  projectId,
}: {
  role: Role;
  label: string;
  /** Required for a design: it belongs to a piece of work. Standards are
   *  organisation-wide and pass nothing. */
  projectId?: string;
}) {
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
        // A cheap first pass so an obvious mistake never costs an upload. The
        // server decides for real, from the bytes — a renamed file passes here
        // and is caught there.
        const name = file.name.toLowerCase();
        const supported =
          file.type === "application/pdf" ||
          file.type === PPTX_MIME ||
          file.type === XLSX_MIME ||
          file.type === DOCX_MIME ||
          name.endsWith(".pdf") ||
          name.endsWith(".docx") ||
          name.endsWith(".pptx") ||
          name.endsWith(".xlsx");
        if (!supported) {
          rejected.push({
            id,
            name: file.name,
            size: file.size,
            state: "error",
            message: "Not a PDF, Word, PowerPoint or Excel file",
          });
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

        const settle = (state: Receipt["state"], message?: string) =>
          setReceipts((prev) =>
            prev.map((r) => (r.id === receiptId ? { ...r, state, message } : r)),
          );
        // A successful upload drops its receipt — the row appears in the list a
        // moment later, and reporting the same file twice reads as accepting it
        // twice. Errors and duplicates stay; they say what the list cannot.
        const discard = () => setReceipts((prev) => prev.filter((r) => r.id !== receiptId));

        try {
          // Straight to object storage. The bytes do not pass through our own
          // server: a Vercel function's request body is capped at 4.5MB, which
          // is what used to reject an 8MB deck as "too large" while this panel
          // advertised 64MB. Role and project ride along as headers and are
          // re-checked server-side before a presigned URL is issued.
          const [uploaded] = await uploadFiles("document", {
            files: [file],
            headers: {
              "x-aidp-role": role,
              ...(projectId ? { "x-aidp-project": projectId } : {}),
            },
          });
          if (uploaded?.serverData?.duplicate) settle("duplicate", "Already on record");
          else discard();
        } catch (error) {
          // Refusals from the file route arrive as the message we wrote —
          // "Only an administrator can add standards documents", and so on.
          settle("error", error instanceof Error ? error.message : "Upload failed");
        }
      }

      startTransition(() => router.refresh());
    },
    [role, projectId, router],
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
        accept={`application/pdf,.pdf,${DOCX_MIME},.docx,${PPTX_MIME},.pptx,${XLSX_MIME},.xlsx`}
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
          // Narrower than the list it follows, and centred: at full width it
          // read as another row of the page rather than the thing to press.
          "ring-gradient group relative mx-auto block w-full max-w-xl overflow-hidden rounded-2xl",
          "bg-canvas-sunk px-4 py-10 text-center",
          "transition-[box-shadow,transform,background-color] duration-300",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
          armed
            ? "bg-royal/[0.07] shadow-[0_0_0_1px_rgba(124,58,237,0.18),0_18px_44px_-24px_rgba(109,40,217,0.40)]"
            : "hover:bg-card hover:shadow-[0_16px_40px_-26px_rgba(109,40,217,0.30)]",
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

          {/* The whole panel takes the click; this says so. A drop target alone
              is discoverable by people who already know they can drop, and by
              nobody else — so the action is stated as the button it is, and the
              drop stays the shortcut for those who know it. */}
          <span className="flex flex-col items-center gap-2.5">
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full bg-royal px-5 py-2.5",
                "text-[14px] font-medium text-white shadow-card",
                "transition-[transform,box-shadow] duration-300",
                armed
                  ? "-translate-y-0.5 shadow-card-hover"
                  : "group-hover:-translate-y-0.5 group-hover:shadow-card-hover",
              )}
            >
              <Plus size={15} aria-hidden="true" />
              {dragging
                ? "Drop to upload"
                : busy
                  ? `Uploading ${pending} file${pending === 1 ? "" : "s"}`
                  : label}
            </span>
            <span className="text-[11.5px] text-ink/62">
              {busy
                ? "Queued in order"
                : `or drop them here — PDF, PPTX or XLSX · up to ${formatSize(MAX_BYTES)}`}
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
                  ? "bg-warn-tint [--ring:linear-gradient(120deg,rgba(180,83,9,0.45),rgba(180,83,9,0.10)_60%,transparent)]"
                  : "bg-card",
              )}
            >
              <span className="flex items-center gap-2">
                {r.state === "error" ? (
                  <TriangleAlert size={12} className="shrink-0 text-warn" />
                ) : (
                  <PageGlyph muted={r.state !== "uploading"} />
                )}
                <span className="min-w-0 flex-1 truncate text-ink/78">{r.name}</span>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    r.state === "error" ? "text-warn" : "text-ink/62",
                  )}
                >
                  {r.message ?? formatSize(r.size)}
                </span>
                <button
                  type="button"
                  onClick={() => setReceipts((p) => p.filter((x) => x.id !== r.id))}
                  aria-label={`Dismiss ${r.name}`}
                  className="shrink-0 rounded text-ink/58 transition-colors hover:text-ink/78"
                >
                  <X size={12} />
                </button>
              </span>

              {/* Indeterminate by design — one multipart request has no
                  meaningful percentage to report. */}
              {r.state === "uploading" && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 block h-px overflow-hidden bg-canvas-sunk"
                >
                  <span className="rail-slide block h-full w-1/4 bg-linear-to-r from-transparent via-royal to-transparent" />
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
          "border-line bg-card",
          armed ? "-translate-x-2.5 -rotate-12" : "-translate-x-1 -rotate-6 group-hover:-translate-x-2 group-hover:-rotate-[9deg]",
        )}
      />
      <span
        className={cn(
          sheet,
          "border-line bg-card",
          armed ? "translate-x-2.5 rotate-12" : "translate-x-1 rotate-6 group-hover:translate-x-2 group-hover:rotate-[9deg]",
        )}
      />
      <span
        className={cn(
          sheet,
          "border-line bg-linear-to-b from-card to-canvas-sunk shadow-card",
          armed && "border-royal/70 shadow-[0_0_18px_-3px_rgba(109,40,217,0.45)]",
        )}
      >
        {/* Ruled lines, so the sheet reads as a document rather than a card. */}
        <span className="absolute inset-x-1.5 top-2 h-px bg-ink/25" />
        <span className="absolute inset-x-1.5 top-3.5 h-px bg-ink/18" />
        <span className="absolute inset-x-1.5 top-5 h-px bg-ink/12" />
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
          ? "border-line bg-card"
          : "border-royal/50 bg-linear-to-b from-royal-tint to-transparent",
      )}
    />
  );
}

/** Shown once a document has finished, in place of the progress rail. */
export function ReadyTick() {
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-royal">
      <Check size={11} />
      Indexed
    </span>
  );
}
