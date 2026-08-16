"use server";

import { revalidatePath } from "next/cache";
import { NoAccess, requireOwner } from "@/lib/access/gate";
import { OWNER, MEMBER } from "@/lib/access/roles";
import * as roster from "@/lib/access/roster";
import { RosterRefused } from "@/lib/access/roster";
import { MIN_PASSWORD, ProvisionRefused } from "@/lib/access/provision";
import {
  SpreadsheetError,
  looksLikeEmail,
  parseSheet,
  type ParsedPerson,
  type ParsedSheet,
} from "@/lib/access/spreadsheet";

/**
 * Managing the people in a workspace.
 *
 * Every action starts with `requireOwner`. Server Actions accept direct POSTs,
 * so that call is the access control for this whole surface, not a repeat of
 * the layout's check — a member who knows the action's id could otherwise admit
 * themselves.
 *
 * Errors come back as values rather than thrown, so the page can state what
 * went wrong ("that would leave the workspace with no administrator") instead
 * of showing an error boundary. Anything unexpected is deliberately vague: an
 * internal message is not the caller's business.
 */

export type ActionResult = { ok: boolean; message: string };

const REFUSED = "You do not have permission to manage this workspace.";

async function run(work: (actor: Awaited<ReturnType<typeof requireOwner>>) => Promise<string>) {
  try {
    const actor = await requireOwner();
    const message = await work(actor);
    revalidatePath("/dashboard/people");
    return { ok: true, message };
  } catch (error) {
    if (error instanceof RosterRefused || error instanceof ProvisionRefused) {
      return { ok: false, message: error.message };
    }
    if (error instanceof NoAccess) return { ok: false, message: REFUSED };
    return { ok: false, message: "That did not work. Try again." };
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Add one person by hand, optionally admitting them at the same time. */
export async function addPerson(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const jobTitle = String(formData.get("jobTitle") ?? "").trim();
  const department = String(formData.get("department") ?? "").trim();
  const role = String(formData.get("role") ?? MEMBER);
  const admit = formData.get("admit") === "on" || formData.get("admit") === "true";

  if (!looksLikeEmail(email)) {
    return { ok: false, message: "That does not look like an email address." };
  }

  const password = String(formData.get("password") ?? "");

  return run(async (actor) => {
    const person = await roster.addPerson(
      actor,
      { email, name, jobTitle, department, role },
      { admit: admit || password.length > 0 },
    );

    // Setting a password is the enterprise onboarding path: the administrator
    // creates the account outright and hands the credentials over, rather than
    // sending their staff to a sign-up form.
    if (password) {
      const { created } = await roster.setPassword(actor, person.id, password);
      return created
        ? `Account created for ${email}. Give them the password — they sign in with it, their email, and your company name.`
        : `${email} already had an account; its password has been reset.`;
    }

    return admit
      ? `${email} can now sign in, once they register with this email address.`
      : `${email} added to the list. They have no access until you admit them.`;
  });
}

export async function grantAccess(ids: string[], role: string = MEMBER): Promise<ActionResult> {
  if (ids.length === 0) return { ok: false, message: "Nobody was selected." };
  return run(async (actor) => {
    const changed = await roster.grant(actor, ids, role);
    return `${plural(changed, "person")} can now sign in${
      role === OWNER ? " as an administrator" : ""
    }.`;
  });
}

export async function revokeAccess(ids: string[]): Promise<ActionResult> {
  if (ids.length === 0) return { ok: false, message: "Nobody was selected." };
  return run(async (actor) => {
    const changed = await roster.revoke(actor, ids);
    // Worth stating plainly: the effect is immediate, not at next sign-in.
    return `Access withdrawn for ${plural(changed, "person")}. They were signed out.`;
  });
}

/**
 * Issue or reset an employee's password.
 *
 * The administrator then passes it on out of band. Nothing here emails it —
 * there is no mail provider wired up yet (see `sendResetPassword` in
 * src/lib/auth-options.ts), and inventing one that silently does nothing would
 * be worse than the administrator knowing they have to hand it over.
 */
export async function setPassword(id: string, password: string): Promise<ActionResult> {
  if (password.length < MIN_PASSWORD) {
    return { ok: false, message: `A password needs at least ${MIN_PASSWORD} characters.` };
  }
  return run(async (actor) => {
    const { created, email } = await roster.setPassword(actor, id, password);
    return created
      ? `Account created for ${email}. Give them the password — they sign in with it, their email, and your company name.`
      : `Password reset for ${email}.`;
  });
}

export async function setRole(id: string, role: string): Promise<ActionResult> {
  return run(async (actor) => {
    await roster.setRole(actor, id, role);
    return role === OWNER ? "Made an administrator." : "Now a member.";
  });
}

export async function removePerson(id: string): Promise<ActionResult> {
  return run(async (actor) => {
    await roster.removePerson(actor, id);
    return "Removed from the list.";
  });
}

export type PreviewResult =
  | { ok: true; preview: ParsedSheet; filename: string }
  | { ok: false; message: string };

/**
 * Read an uploaded staff list and show what was found.
 *
 * Parsing and importing are two steps on purpose. The parser is guessing which
 * column is which, and an owner about to load two hundred people into their
 * workspace should see that guess — and the rows it could not read — before
 * anything is written.
 */
export async function previewImport(formData: FormData): Promise<PreviewResult> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, message: REFUSED };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "No file was attached." };
  }

  try {
    const preview = await parseSheet(Buffer.from(await file.arrayBuffer()), file.name);
    return { ok: true, preview, filename: file.name };
  } catch (error) {
    if (error instanceof SpreadsheetError) return { ok: false, message: error.message };
    return {
      ok: false,
      message: "That file could not be read. Upload a .xlsx or .csv export.",
    };
  }
}

/**
 * Commit a previewed list.
 *
 * The rows come back from the browser rather than being held server-side
 * between the two steps, so every address is re-validated here. The client is
 * not trusted to have sent back what the parser produced — though the worst it
 * could do is add addresses this person is entitled to add anyway, since
 * imported rows carry no access at all.
 */
export async function confirmImport(people: ParsedPerson[]): Promise<ActionResult> {
  const clean = people
    .filter((person) => looksLikeEmail(person.email))
    .map((person) => ({
      email: person.email.trim().toLowerCase(),
      name: String(person.name ?? "").slice(0, 200),
      jobTitle: String(person.jobTitle ?? "").slice(0, 200),
      department: String(person.department ?? "").slice(0, 200),
      row: person.row,
    }));

  if (clean.length === 0) return { ok: false, message: "Nothing valid to import." };

  return run(async (actor) => {
    const { added, updated } = await roster.importPeople(actor, clean);
    const parts = [];
    if (added) parts.push(`${plural(added, "person")} added`);
    if (updated) parts.push(`${plural(updated, "record")} updated`);
    return `${parts.join(", ")}. Nobody has access yet — select who should, then admit them.`;
  });
}
