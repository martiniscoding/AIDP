"use server";

import { revalidatePath } from "next/cache";
import { NoAccess, requireAccess } from "@/lib/access/gate";
import {
  ACTIVE,
  ARCHIVED,
  ProjectRefused,
  createProject,
  setProjectStatus,
  updateProject,
} from "@/lib/ingest/projects";

/**
 * Server Actions accept direct POSTs, so `requireAccess` in each of these is
 * the access control. Any member may open a project — that is the work they are
 * here to do — but only an administrator or whoever opened one may change it,
 * and that check lives in the library beside the rule it enforces.
 */

export type ProjectResult = { ok: boolean; message: string; id?: string };

async function run(work: (access: Awaited<ReturnType<typeof requireAccess>>) => Promise<ProjectResult>) {
  try {
    const access = await requireAccess();
    const result = await work(access);
    revalidatePath("/dashboard/projects");
    return result;
  } catch (error) {
    if (error instanceof ProjectRefused) return { ok: false, message: error.message };
    if (error instanceof NoAccess) return { ok: false, message: error.message };
    return { ok: false, message: "That did not work. Try again." };
  }
}

export async function newProject(form: FormData): Promise<ProjectResult> {
  return run(async (access) => {
    const project = await createProject(access, {
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? ""),
    });
    return { ok: true, message: `Opened “${project.name}”.`, id: project.id };
  });
}

export async function renameProject(id: string, form: FormData): Promise<ProjectResult> {
  return run(async (access) => {
    await updateProject(access, id, {
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? ""),
    });
    revalidatePath(`/dashboard/projects/${id}`);
    return { ok: true, message: "Saved." };
  });
}

export async function archiveProject(id: string, archived: boolean): Promise<ProjectResult> {
  return run(async (access) => {
    await setProjectStatus(access, id, archived ? ARCHIVED : ACTIVE);
    revalidatePath(`/dashboard/projects/${id}`);
    return {
      ok: true,
      message: archived
        ? "Archived. Nothing is deleted — reopen it to add designs again."
        : "Reopened.",
    };
  });
}
