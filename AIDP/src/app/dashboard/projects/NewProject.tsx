"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FolderPlus } from "lucide-react";
import { cn } from "@/lib/cn";
import { newProject } from "./actions";

/**
 * Opening a piece of work.
 *
 * Collapsed until asked for: the list is what people come here to read, and a
 * form sitting permanently above it pushes the content down for the one time in
 * fifty that somebody is starting something new.
 */
export function NewProject() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!open) {
    return (
      <div className="mb-5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-ink/80 transition-colors hover:border-line-strong hover:text-ink"
        >
          <FolderPlus size={13} />
          New project
        </button>
        {message && (
          <p role="status" className={cn("mt-2 text-[12.5px]", message.ok ? "text-ok" : "text-warn")}>
            {message.text}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      action={(formData) =>
        startTransition(async () => {
          const result = await newProject(formData);
          setMessage({ ok: result.ok, text: result.message });
          if (result.ok) {
            setOpen(false);
            if (result.id) router.push(`/dashboard/projects/${result.id}`);
            else router.refresh();
          }
        })
      }
      className="mb-5 rounded-2xl border border-line bg-card p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-ink/58">
            Project name
          </span>
          <input
            name="name"
            required
            autoFocus
            placeholder="Customer Portal Modernisation"
            className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink/40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-ink/58">
            What is it? (optional)
          </span>
          <input
            name="description"
            placeholder="One line, for whoever opens this next"
            className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink/40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          />
        </label>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-royal px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
        >
          {pending ? "Opening…" : "Open project"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setMessage(null);
          }}
          className="text-[12.5px] text-ink/58 transition-colors hover:text-ink"
        >
          cancel
        </button>
        {message && !message.ok && (
          <p role="alert" className="text-[12.5px] text-warn">
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
