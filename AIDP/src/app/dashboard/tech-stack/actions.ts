"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveActive } from "@/lib/ingest/org";
import { parseAssessmentInput, type SaveResult } from "@/lib/tech-stack/schema";
import { renderTechSummary } from "@/lib/tech-stack/summary";

/**
 * Persist the Technology Stack & Architecture Reference for the signed-in user.
 *
 * Shaped for `useActionState`, so it takes the previous state first and returns
 * the next one rather than throwing on validation failure — the form needs to
 * keep the client's answers on screen while it shows what to fix.
 */
export async function saveAssessment(
  _previous: SaveResult | null,
  raw: unknown,
): Promise<SaveResult> {
  // Server Actions accept direct POSTs, so this check is the access control,
  // not a duplicate of the page's redirect.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return {
      ok: false,
      message: "Your session expired. Sign in again to save.",
      errors: {},
    };
  }

  const { value, errors } = parseAssessmentInput(raw);

  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      message: "Some required details are missing.",
      errors,
    };
  }

  const userId = session.user.id;
  const submitting = value.intent === "submit";

  // The reference belongs to the organisation, so the assessment pipeline can
  // reach it — a run has an organisation, never a user. `resolveActive` creates
  // one on first use, which is also what makes this row reachable at all.
  const organisation = await resolveActive(
    session.user as typeof session.user & { company?: string },
  );

  const scalars = {
    companyName: value.companyName,
    primaryContact: value.primaryContact,
    roleTitle: value.roleTitle,
    dateCompleted: value.dateCompleted,
    dataSources: value.dataSources,
    dataWarehousing: value.dataWarehousing,
    biReporting: value.biReporting,
    primaryCloud: value.primaryCloud,
    workloads: value.workloads,
    additionalNotes: value.additionalNotes,
    // Rendered here because only the app can resolve catalog ids to labels.
    summary: renderTechSummary(value),
  };

  try {
    const saved = await prisma.$transaction(async (tx) => {
      const assessment = await tx.techAssessment.upsert({
        where: { organisationId: organisation.id },
        create: {
          organisationId: organisation.id,
          userId,
          ...scalars,
          status: submitting ? "submitted" : "draft",
          submittedAt: submitting ? new Date() : null,
        },
        update: {
          // Attribution follows the last edit.
          userId,
          ...scalars,
          // Submitting is one-way: a client editing an already-submitted
          // reference should not silently drop it back to draft.
          ...(submitting
            ? { status: "submitted", submittedAt: new Date() }
            : {}),
        },
      });

      // Replace rather than diff. The matrix is at most a couple of dozen rows,
      // and a full replace inside the transaction makes a re-run — a double
      // submit, a retried request — land on exactly the same state.
      await tx.techPlatformPreference.deleteMany({
        where: { assessmentId: assessment.id },
      });

      if (value.platforms.length > 0) {
        await tx.techPlatformPreference.createMany({
          data: value.platforms.map((platform, index) => ({
            assessmentId: assessment.id,
            platformKey: platform.platformKey,
            label: platform.label,
            isCustom: platform.isCustom,
            currentUsage: platform.currentUsage,
            interestLevel: platform.interestLevel,
            sortOrder: index,
          })),
        });
      }

      return assessment;
    });

    revalidatePath("/dashboard");
    revalidatePath("/dashboard/tech-stack");

    return {
      ok: true,
      status: saved.status,
      savedAt: saved.updatedAt.toISOString(),
    };
  } catch (error) {
    console.error("[tech-stack] save failed", error);
    return {
      ok: false,
      message: "Could not reach the database. Your answers are still here — try again.",
      errors: {},
    };
  }
}
