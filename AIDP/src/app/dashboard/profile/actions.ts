"use server";

import { revalidatePath } from "next/cache";
import { NoAccess, requireOwner } from "@/lib/access/gate";
import { canManageCredentials } from "@/lib/access/roles";
import {
  CredentialRefused,
  remove as removeCredential,
  save as saveCredential,
  setEnabled as setCredentialEnabled,
} from "@/lib/access/credentials";
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

/**
 * The company's own model key.
 *
 * Same reasoning as above on the guard, with more at stake: this one decides
 * which vendor sees the company's documents and whose account pays for every
 * assessment. `canManageCredentials` rather than `access.isOwner` so the policy
 * lives in one file — see src/lib/access/roles.ts.
 */
export async function saveModelKey(form: FormData): Promise<ProfileResult> {
  try {
    const access = await requireOwner();
    if (!canManageCredentials(access.role)) {
      return { ok: false, message: "Only an administrator can set the model key." };
    }

    const hosts = String(form.get("openrouterProviders") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    const view = await saveCredential(
      access.organisation.id,
      {
        provider: String(form.get("provider") ?? ""),
        apiKey: String(form.get("apiKey") ?? ""),
        model: String(form.get("model") ?? ""),
        fastModel: String(form.get("fastModel") ?? ""),
        openrouterProviders: hosts,
        zdr: form.get("zdr") === "on",
      },
      access.user.id,
    );

    revalidatePath("/dashboard/profile");
    // A key that failed its handshake is saved and switched off, so the message
    // has to say both things — "Saved" alone would read as "working".
    if (!view.active) {
      return {
        ok: false,
        message:
          "Saved, but switched off: " +
          (view.probe?.notes[0] ?? "the key could not be verified") +
          ". Assessments keep using the platform's key until this is fixed.",
      };
    }
    return {
      ok: true,
      message: view.probe?.visionOk
        ? "Key verified and in use. New assessments will run on it."
        : "Key verified and in use, though it cannot read images — figures will go undescribed.",
    };
  } catch (error) {
    if (error instanceof CredentialRefused) return { ok: false, message: error.message };
    if (error instanceof NoAccess) {
      return { ok: false, message: "Only an administrator can set the model key." };
    }
    console.error("[profile] saving the model key failed", error);
    return { ok: false, message: "The key could not be saved." };
  }
}

/**
 * Switch between the company's own key and the platform's, keeping both.
 *
 * The reversible form of `removeModelKey`, and the one anybody trying a
 * provider actually wants: going back used to mean deleting the key, so going
 * back again meant finding it and pasting it a second time.
 */
export async function setModelKeyEnabled(enabled: boolean): Promise<ProfileResult> {
  try {
    const access = await requireOwner();
    if (!canManageCredentials(access.role)) {
      return { ok: false, message: "Only an administrator can change the model key." };
    }
    if (typeof enabled !== "boolean") {
      return { ok: false, message: "Could not read which key to use." };
    }

    const view = await setCredentialEnabled(access.organisation.id, enabled);
    revalidatePath("/dashboard/profile");

    if (!enabled) {
      return {
        ok: true,
        message: "Switched to the platform's key. Yours is kept — switch back whenever you like.",
      };
    }
    // Saying so here rather than letting a run discover it: a key the probe
    // rejected is still skipped by every worker, switched on or not.
    return {
      ok: true,
      message: view.active
        ? "Switched back to your own key. New assessments use it."
        : "Switched on, but this key did not pass its check, so assessments stay on the platform's. Replace it to fix that.",
    };
  } catch (error) {
    if (error instanceof CredentialRefused) return { ok: false, message: error.message };
    if (error instanceof NoAccess) {
      return { ok: false, message: "Only an administrator can change the model key." };
    }
    console.error("[profile] switching the model key failed", error);
    return { ok: false, message: "The key could not be switched." };
  }
}

export async function removeModelKey(): Promise<ProfileResult> {
  try {
    const access = await requireOwner();
    if (!canManageCredentials(access.role)) {
      return { ok: false, message: "Only an administrator can remove the model key." };
    }
    await removeCredential(access.organisation.id);
    revalidatePath("/dashboard/profile");
    return { ok: true, message: "Removed. Assessments run on the platform's own key again." };
  } catch (error) {
    if (error instanceof NoAccess) {
      return { ok: false, message: "Only an administrator can remove the model key." };
    }
    return { ok: false, message: "The key could not be removed." };
  }
}
