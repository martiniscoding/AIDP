"use server";

import { revalidatePath } from "next/cache";
import { NoAccess, requireAccess } from "@/lib/access/gate";
import {
  RequestRefused,
  createRequest,
  submitRequest,
  updateRequest,
  type UpdateInput,
} from "@/lib/ingest/requests";
import { advanceSubmitted } from "@/lib/ingest/requests";

/**
 * Server Actions accept direct POSTs, so `requireAccess` in each of these is
 * the access control — the layout's check does not run in front of one.
 * Everything else about who may do what lives in the library beside the rule
 * it enforces, exactly as it does for projects.
 */

export type RequestResult = { ok: boolean; message: string; id?: string };

async function run(
  work: (access: Awaited<ReturnType<typeof requireAccess>>) => Promise<RequestResult>,
): Promise<RequestResult> {
  try {
    const access = await requireAccess();
    const result = await work(access);
    revalidatePath("/dashboard/requests");
    return result;
  } catch (error) {
    if (error instanceof RequestRefused) return { ok: false, message: error.message };
    if (error instanceof NoAccess) return { ok: false, message: error.message };
    return { ok: false, message: "That did not work. Try again." };
  }
}

export async function newRequest(form: FormData): Promise<RequestResult> {
  return run(async (access) => {
    const created = await createRequest(access, {
      projectId: String(form.get("projectId") ?? ""),
      title: String(form.get("title") ?? ""),
      summary: String(form.get("summary") ?? ""),
    });
    return {
      ok: true,
      id: created.id,
      message: `${created.reference} opened. Fill it in and submit it when it is ready.`,
    };
  });
}

/**
 * Save one step of the wizard.
 *
 * Takes the fields that step carries and nothing else. A field the step does
 * not mention is left alone rather than blanked — see `updateRequest`, which is
 * where that rule is enforced and tested.
 */
export async function saveRequest(id: string, input: UpdateInput): Promise<RequestResult> {
  return run(async (access) => {
    await updateRequest(access, id, input);
    revalidatePath(`/dashboard/requests/${id}`);
    return { ok: true, message: "Saved." };
  });
}

/**
 * Submit it: render the answers, take the document in, and let it index.
 *
 * The assessment is not started here and cannot be — the document has to finish
 * parsing, chunking and embedding first. The embed worker says when that has
 * happened and the app starts the run then; `advanceSubmitted` is called once
 * here anyway, for the case that matters to somebody watching this screen: a
 * resubmission whose document was already indexed by an earlier attempt, which
 * would otherwise sit still until the next sweep.
 */
export async function submit(id: string): Promise<RequestResult> {
  return run(async (access) => {
    const { reference } = await submitRequest(access, id);
    await advanceSubmitted({ organisationId: access.organisation.id });
    revalidatePath(`/dashboard/requests/${id}`);
    return {
      ok: true,
      message: `${reference} submitted. The review starts as soon as it has been read.`,
    };
  });
}
