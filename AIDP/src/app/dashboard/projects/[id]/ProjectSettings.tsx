"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, Pencil, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { archiveProject, renameProject } from "../actions";

/**
 * Rename and archive, for the administrator or whoever opened the project.
 *
 * Archiving is offered; deleting is not. A project holds submissions, findings
 * and the record of who accepted what, and tidying a list is not a good enough
 * reason to destroy that.
 */
export function ProjectSettings({
  project,
}: {
  project: { id: string; name: string; description: string; status: string };
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const archived = project.status !== "active";

  const act = (work: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const result = await work();
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) {
        setEditing(false);
        setConfirming(false);
        router.refresh();
      }
    });

  if (editing) {
    return (
      <form
        action={(formData) => act(() => renameProject(project.id, formData))}
        className="rounded-xl border border-line bg-card p-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            name="name"
            required
            defaultValue={project.name}
            className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          />
          <input
            name="description"
            defaultValue={project.description}
            placeholder="One line, for whoever opens this next"
            className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink/40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-royal px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
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

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink/70 transition-colors hover:border-line-strong hover:text-ink"
      >
        <Pencil size={12} />
        Rename
      </button>

      {archived ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => act(() => archiveProject(project.id, false))}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink/70 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
        >
          <RotateCcw size={12} />
          Reopen
        </button>
      ) : confirming ? (
        <span className="inline-flex items-center gap-2 rounded-lg border border-warn-line bg-warn-tint px-2.5 py-1 text-[12px] text-warn">
          Archive this project?
          <button
            type="button"
            disabled={pending}
            onClick={() => act(() => archiveProject(project.id, true))}
            className="font-medium underline underline-offset-2 disabled:opacity-40"
          >
            yes
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-ink/58 transition-colors hover:text-ink"
          >
            no
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink/70 transition-colors hover:border-line-strong hover:text-ink"
        >
          <Archive size={12} />
          Archive
        </button>
      )}

      {message && (
        <p
          role="status"
          className={cn("text-[12.5px]", message.ok ? "text-ok" : "text-warn")}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
