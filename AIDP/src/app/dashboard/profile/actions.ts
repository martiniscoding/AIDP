"use server";

import { revalidatePath } from "next/cache";
import { NoAccess, requireOwner } from "@/lib/access/gate";
import { ProfileRefused, save, type ProfileInput } from "@/lib/access/profile";

/**
 * Server Actions accept direct POSTs, so `requireOwner` here is the access
 * control — not a repeat of the page's guard. An employee who found this
 * action's id could otherwise rename their own company.
 */

export type ProfileResult = { ok: boolean; message: string };

function read(form: FormData, field: keyof ProfileInput): string {
  return String(form.get(field) ?? "");
}

export async function saveProfile(form: FormData): Promise<ProfileResult> {
  try {
    const access = await requireOwner();
    await save(access.organisation.id, {
      name: read(form, "name"),
      primaryContact: read(form, "primaryContact"),
      contactEmail: read(form, "contactEmail"),
      contactPhone: read(form, "contactPhone"),
      country: read(form, "country"),
      industry: read(form, "industry"),
      notes: read(form, "notes"),
    });

    // The company name appears in the header on every page, so refresh the
    // layout too rather than only this route.
    revalidatePath("/dashboard", "layout");
    return { ok: true, message: "Saved." };
  } catch (error) {
    if (error instanceof ProfileRefused) return { ok: false, message: error.message };
    if (error instanceof NoAccess) {
      return { ok: false, message: "Only an administrator can edit the company details." };
    }
    return { ok: false, message: "Could not save those details." };
  }
}
