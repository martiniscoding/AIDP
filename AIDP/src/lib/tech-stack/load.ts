import { prisma } from "@/lib/prisma";
import { PLATFORMS } from "./catalog";
import type { AssessmentInput, PlatformInput } from "./schema";

/**
 * Read one client's assessment and shape it for the form.
 *
 * Server-only — it touches Prisma. Both the overview card and the form itself
 * go through here so they can never disagree about completion.
 */
export async function loadAssessment(user: {
  id: string;
  name?: string | null;
  company?: string | null;
}): Promise<{ input: AssessmentInput; savedAt: string | null; status: string }> {
  const record = await prisma.techAssessment.findUnique({
    where: { userId: user.id },
    include: { platforms: { orderBy: { sortOrder: "asc" } } },
  });

  return {
    input: {
      // Seed from the sign-up record on first open so the client isn't retyping
      // what we already know. Once saved, the stored value wins — they may be
      // completing this for a subsidiary under a different name.
      companyName: record?.companyName || user.company || "",
      primaryContact: record?.primaryContact || user.name || "",
      roleTitle: record?.roleTitle ?? "",
      dateCompleted: record?.dateCompleted ?? "",
      dataSources: record?.dataSources ?? [],
      dataWarehousing: record?.dataWarehousing ?? [],
      biReporting: record?.biReporting ?? [],
      primaryCloud: record?.primaryCloud ?? [],
      workloads: record?.workloads ?? [],
      platforms: mergePlatforms(record?.platforms ?? []),
      additionalNotes: record?.additionalNotes ?? "",
      intent: "save",
    },
    savedAt: record?.updatedAt.toISOString() ?? null,
    status: record?.status ?? "draft",
  };
}

/**
 * The four template platforms always render, in template order, whether or not
 * they have been answered — a blank row is a question the client still has to
 * answer, so dropping it would hide the ask. Write-ins follow, in the order
 * they were added.
 */
function mergePlatforms(
  saved: {
    platformKey: string;
    label: string;
    isCustom: boolean;
    currentUsage: string | null;
    interestLevel: string | null;
  }[],
): PlatformInput[] {
  const byKey = new Map(saved.map((row) => [row.platformKey, row]));

  const catalogRows: PlatformInput[] = PLATFORMS.map((platform) => {
    const row = byKey.get(platform.id);
    return {
      platformKey: platform.id,
      label: platform.label,
      isCustom: false,
      currentUsage: row?.currentUsage ?? null,
      interestLevel: row?.interestLevel ?? null,
    };
  });

  const customRows: PlatformInput[] = saved
    .filter((row) => !PLATFORMS.some((platform) => platform.id === row.platformKey))
    .map((row) => ({
      platformKey: row.platformKey,
      label: row.label,
      isCustom: true,
      currentUsage: row.currentUsage,
      interestLevel: row.interestLevel,
    }));

  return [...catalogRows, ...customRows];
}
