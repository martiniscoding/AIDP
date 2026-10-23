"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { newRequest } from "../actions";

/**
 * Opening a request: the project it belongs to, and what to call it.
 *
 * Only two answers, and deliberately. Everything else is asked in the wizard,
 * which can only save into a row that exists — so this is the smallest thing
 * that creates one, and the reference is issued here.
 *
 * The project is chosen rather than created from the title. A project holds
 * several requests, and `Project` carries a unique name per organisation: two
 * requests called "Portal Upgrade" would collide on the second.
 */
export function NewRequest({ projects }: { projects: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (projects.length === 0) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-2 rounded-full bg-royal px-5 py-2.5",
          "text-[14px] font-medium text-white shadow-card cursor-pointer",
          "transition-[transform,box-shadow] duration-300",
          "hover:-translate-y-0.5 hover:shadow-card-hover",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
        )}
      >
        <FilePlus2 size={15} aria-hidden="true" />
        New request
      </button>
    );
  }

  const field = cn(
    "w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink",
    "placeholder:text-ink/40",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid",
  );

  return (
    <form
      action={(formData) =>
        startTransition(async () => {
          const result = await newRequest(formData);
          if (result.ok && result.id) {
            router.push(`/dashboard/requests/${result.id}`);
          } else {
            setError(result.message);
          }
        })
      }
      className="grid w-full max-w-md gap-2 rounded-xl border border-line bg-card p-3 sm:grid-cols-2"
    >
      <label className="block sm:col-span-2">
        <span className="mb-1 block text-[12.5px] font-medium text-ink">Project</span>
        <select name="projectId" required className={cn(field, "cursor-pointer")}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block sm:col-span-2">
        <span className="mb-1 block text-[12.5px] font-medium text-ink">Request title</span>
        <input
          name="title"
          required
          autoFocus
          placeholder="Customer Portal Upgrade"
          className={field}
        />
      </label>

      {error && (
        <p role="status" className="text-[12.5px] text-warn sm:col-span-2">
          {error}
        </p>
      )}

      <div className="flex gap-2 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-royal px-4 py-1.5 text-[13px] font-medium text-white cursor-pointer disabled:opacity-50"
        >
          {pending ? "Opening…" : "Open it"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full px-3 py-1.5 text-[13px] text-ink/70 hover:text-ink cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
