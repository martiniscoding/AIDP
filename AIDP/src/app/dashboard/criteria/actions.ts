"use server";

import { revalidatePath } from "next/cache";
import { NoAccess, requireAccess } from "@/lib/access/gate";
import { canManageStandards } from "@/lib/access/roles";
import {
  CriteriaRefused,
  restoreDefaults,
  updateCriterion,
} from "@/lib/significance/record";

/**
 * Who may change what a review board looks at.
 *
 * The same rule as the standards library, and for the same reason: whoever
 * controls these decides which submissions a person ever reads, so an employee
 * must not be able to rule their own work out of a review. `requireAccess` and
 * the role check are both here because a Server Action takes a direct POST and
 * the layout's guard does not run in front of one.
 */

export type CriteriaResult = { ok: boolean; message: string };

async function run(
  work: (access: Awaited<ReturnType<typeof requireAccess>>) => Promise<CriteriaResult>,
): Promise<CriteriaResult> {
  try {
    const access = await requireAccess();
    if (!canManageStandards(access.organisation.role)) {
      return {
        ok: false,
        message: "Only an administrator can change the significance criteria.",
      };
    }
    const result = await work(access);
    revalidatePath("/dashboard/criteria");
    return result;
  } catch (error) {
    if (error instanceof CriteriaRefused) return { ok: false, message: error.message };
    if (error instanceof NoAccess) return { ok: false, message: error.message };
    return { ok: false, message: "That did not work. Try again." };
  }
}

export async function setActive(id: string, active: boolean): Promise<CriteriaResult> {
  return run(async (access) => {
    await updateCriterion(access.organisation.id, id, { active });
    return {
      ok: true,
      message: active
        ? "That category will be checked again from the next submission."
        : "That category will not be checked from the next submission. Classifications already recorded are unchanged.",
    };
  });
}

export async function setThreshold(id: string, index: number, value: string): Promise<CriteriaResult> {
  return run(async (access) => {
    const criterion = await import("@/lib/prisma").then(({ prisma }) =>
      prisma.significanceCriterion.findFirst({
        where: { id, organisationId: access.organisation.id },
        select: { conditions: true },
      }),
    );
    if (!criterion) return { ok: false, message: "That category no longer exists." };

    const conditions = Array.isArray(criterion.conditions) ? [...criterion.conditions] : [];
    const condition = conditions[index] as { operator?: string; value?: unknown; text?: string } | undefined;
    if (!condition) return { ok: false, message: "That condition no longer exists." };

    const cleaned = value.replace(/[\s,_]/g, "");
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { ok: false, message: "Give the threshold as a number." };
    }

    // The words follow the number. A condition reading "at least 5,000,000"
    // beside a threshold of one million is the kind of thing that survives for
    // a year because everyone reads the sentence and nobody reads the field.
    const previous = condition.value;
    conditions[index] = {
      ...condition,
      value: parsed,
      text:
        typeof condition.text === "string" && previous !== undefined
          ? condition.text.replace(
              Number(previous).toLocaleString("en-GB"),
              parsed.toLocaleString("en-GB"),
            )
          : condition.text,
    };

    await updateCriterion(access.organisation.id, id, { conditions });
    return { ok: true, message: `Updated to ${parsed.toLocaleString("en-GB")}.` };
  });
}

export async function setLabel(id: string, label: string): Promise<CriteriaResult> {
  return run(async (access) => {
    await updateCriterion(access.organisation.id, id, { label });
    return { ok: true, message: "Renamed." };
  });
}

export async function restore(): Promise<CriteriaResult> {
  return run(async (access) => {
    const count = await restoreDefaults(access.organisation.id);
    return {
      ok: true,
      message: `All ${count} categories are back to their defaults. Set your cost threshold before relying on them.`,
    };
  });
}
