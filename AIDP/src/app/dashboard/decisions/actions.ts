"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { NotAMember } from "@/lib/ingest/org";
import { resolveActive } from "@/lib/ingest/org";
import {
  createDecision,
  embedPending,
  reinstate,
  retire,
  superseded,
} from "@/lib/ingest/decisions";
import { DECISION_EFFECTS, type DecisionEffect } from "@/lib/ingest/decision-effects";

export type DecisionActionResult = { ok: boolean; message: string };

/**
 * Server Actions accept direct POSTs, so the session check in each of these is
 * the access control — not a duplicate of the page's redirect.
 */
async function context() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new NotAMember();
  const user = session.user as typeof session.user & { company?: string };
  const organisation = await resolveActive(user);
  return { user, organisationId: organisation.id, name: user.name || user.email };
}

function readEffect(value: FormDataEntryValue | null): DecisionEffect {
  const raw = String(value ?? "context");
  return (DECISION_EFFECTS as readonly string[]).includes(raw)
    ? (raw as DecisionEffect)
    : "context";
}

/**
 * An end date is a date, not a timestamp — "valid until 31 March" means the
 * whole of 31 March, so it expires at the end of that day rather than at
 * midnight when nobody meant it to.
 */
function readExpiry(value: FormDataEntryValue | null): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(`${raw}T23:59:59`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readInput(form: FormData) {
  return {
    title: String(form.get("title") ?? "").trim(),
    statement: String(form.get("statement") ?? "").trim(),
    rationale: String(form.get("rationale") ?? "").trim(),
    effect: readEffect(form.get("effect")),
    clauseRef: String(form.get("clauseRef") ?? "").trim(),
    clauseTitle: String(form.get("clauseTitle") ?? "").trim(),
    expiresAt: readExpiry(form.get("expiresAt")),
  };
}

export async function recordDecision(form: FormData): Promise<DecisionActionResult> {
  try {
    const { user, organisationId, name } = await context();
    const input = readInput(form);

    if (!input.title) return { ok: false, message: "Give the decision a short name." };
    if (!input.statement) {
      return { ok: false, message: "Write the ruling itself — that is what the model reads." };
    }

    const { embedded } = await createDecision(user.id, organisationId, input, name);

    revalidatePath("/dashboard/decisions");
    return {
      ok: true,
      message: embedded
        ? "Decision recorded. It applies from the next assessment."
        : "Decision recorded, but it could not be indexed for matching — it will only match on its clause reference until you retry.",
    };
  } catch (error) {
    if (error instanceof NotAMember) return { ok: false, message: "You do not have access." };
    return { ok: false, message: "Could not record that decision." };
  }
}

export async function reviseDecision(
  decisionId: string,
  form: FormData,
): Promise<DecisionActionResult> {
  try {
    const { user, organisationId, name } = await context();
    const input = readInput(form);

    if (!input.title || !input.statement) {
      return { ok: false, message: "A decision needs a name and a ruling." };
    }

    await superseded(user.id, organisationId, decisionId, input, name);
    revalidatePath("/dashboard/decisions");
    return { ok: true, message: "Revised. The previous version is kept for past reports." };
  } catch (error) {
    if (error instanceof NotAMember) return { ok: false, message: "You do not have access." };
    return { ok: false, message: "Could not revise that decision." };
  }
}

export async function retireDecision(decisionId: string): Promise<DecisionActionResult> {
  try {
    const { user, organisationId } = await context();
    await retire(user.id, organisationId, decisionId);
    revalidatePath("/dashboard/decisions");
    return { ok: true, message: "Retired. It will not be applied again." };
  } catch (error) {
    if (error instanceof NotAMember) return { ok: false, message: "You do not have access." };
    return { ok: false, message: "Could not retire that decision." };
  }
}

export async function reinstateDecision(decisionId: string): Promise<DecisionActionResult> {
  try {
    const { user, organisationId } = await context();
    await reinstate(user.id, organisationId, decisionId);
    revalidatePath("/dashboard/decisions");
    return { ok: true, message: "Back in force." };
  } catch (error) {
    if (error instanceof NotAMember) return { ok: false, message: "You do not have access." };
    return { ok: false, message: "Could not reinstate that decision." };
  }
}

export async function retryIndexing(): Promise<DecisionActionResult> {
  try {
    const { user, organisationId } = await context();
    const { done, failed } = await embedPending(user.id, organisationId);
    revalidatePath("/dashboard/decisions");
    if (done === 0 && failed === 0) return { ok: true, message: "Everything is already indexed." };
    return {
      ok: failed === 0,
      message:
        failed === 0
          ? `Indexed ${done} decision${done === 1 ? "" : "s"}.`
          : `Indexed ${done}, ${failed} still failing — check the embedding key and quota.`,
    };
  } catch (error) {
    if (error instanceof NotAMember) return { ok: false, message: "You do not have access." };
    return { ok: false, message: "Could not index those decisions." };
  }
}
