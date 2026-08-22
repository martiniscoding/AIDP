import { prisma } from "@/lib/prisma";

/**
 * The company's own details.
 *
 * Held on the organisation rather than on whoever registered it: the person who
 * signed up may leave, and the company's contact details should not leave with
 * them.
 *
 * Only an administrator edits this. Not because the fields are sensitive — an
 * employee can see their own company's name on every page — but because these
 * are the workspace's identity, and one of them decides what everybody types at
 * sign-in.
 */

export type CompanyProfile = {
  id: string;
  name: string;
  slug: string;
  primaryContact: string;
  contactEmail: string;
  contactPhone: string;
  country: string;
  industry: string;
  notes: string;
  createdAt: Date;
};

const SELECT = {
  id: true,
  name: true,
  slug: true,
  primaryContact: true,
  contactEmail: true,
  contactPhone: true,
  country: true,
  industry: true,
  notes: true,
  createdAt: true,
} as const;

export class ProfileRefused extends Error {}

export async function load(organisationId: string): Promise<CompanyProfile> {
  return prisma.organisation.findUniqueOrThrow({
    where: { id: organisationId },
    select: SELECT,
  });
}

export type ProfileInput = {
  name: string;
  primaryContact: string;
  contactEmail: string;
  contactPhone: string;
  country: string;
  industry: string;
  notes: string;
};

/** Good enough to catch a typo, deliberately not RFC 5322 — the same rule the
 *  staff-list importer uses, so the two never disagree about an address. */
const EMAIL = /^[^\s@,;]+@[^\s@,;.]+\.[^\s@,;]{2,}$/;

const LIMITS: Record<keyof ProfileInput, number> = {
  name: 200,
  primaryContact: 200,
  contactEmail: 320,
  contactPhone: 60,
  country: 100,
  industry: 120,
  notes: 2000,
};

/**
 * Save the company's details.
 *
 * The slug is deliberately untouched. It is issued once and appears in paths,
 * and renaming a company is a routine thing that should not break a link
 * somebody bookmarked.
 *
 * Everything except the name may be blank: an organisation exists from the
 * moment somebody registers, long before anyone has filled this in, and
 * demanding a value would mean inventing one.
 */
export async function save(
  organisationId: string,
  input: ProfileInput,
): Promise<CompanyProfile> {
  const trimmed = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, String(value ?? "").trim()]),
  ) as ProfileInput;

  if (!trimmed.name) {
    throw new ProfileRefused("The company needs a name.");
  }
  if (trimmed.contactEmail && !EMAIL.test(trimmed.contactEmail)) {
    throw new ProfileRefused("That contact email does not look like an email address.");
  }
  for (const [field, limit] of Object.entries(LIMITS) as [keyof ProfileInput, number][]) {
    if (trimmed[field].length > limit) {
      throw new ProfileRefused(`That ${field === "notes" ? "note" : "value"} is too long.`);
    }
  }

  return prisma.organisation.update({
    where: { id: organisationId },
    data: trimmed,
    select: SELECT,
  });
}
