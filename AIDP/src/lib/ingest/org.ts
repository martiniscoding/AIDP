import { prisma } from "@/lib/prisma";

/**
 * Organisation resolution and the tenant boundary.
 *
 * An organisation is a customer of the consultancy. It is the wall: one
 * customer's Internal-Use standards must never surface in another's work, which
 * is what their own Data Standards §8.2 requires of us as a vendor holding
 * their material.
 *
 * Every read of document or chunk data goes through `requireMembership` first.
 * Nothing in this codebase should query those tables with an organisation id it
 * has not checked, and no helper here will hand one back without checking.
 */

export class NotAMember extends Error {
  constructor() {
    super("You do not have access to this organisation.");
    this.name = "NotAMember";
  }
}

export type OrganisationSummary = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "organisation";
}

/** Organisations this user can see, most recently created first. */
export async function listForUser(userId: string): Promise<OrganisationSummary[]> {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { organisation: true },
    orderBy: { createdAt: "desc" },
  });
  return memberships.map((m) => ({
    id: m.organisation.id,
    name: m.organisation.name,
    slug: m.organisation.slug,
    role: m.role,
  }));
}

/**
 * Throws unless the user is a member. Returns the organisation so callers have
 * no reason to fetch it separately and skip the check.
 */
export async function requireMembership(
  userId: string,
  organisationId: string,
): Promise<OrganisationSummary> {
  const membership = await prisma.membership.findUnique({
    where: { userId_organisationId: { userId, organisationId } },
    include: { organisation: true },
  });
  if (!membership) throw new NotAMember();
  return {
    id: membership.organisation.id,
    name: membership.organisation.name,
    slug: membership.organisation.slug,
    role: membership.role,
  };
}

/**
 * The organisation to work in, creating one on first use.
 *
 * Seeded from the company on the sign-up record, which is a stopgap: the real
 * shape is a consultant who belongs to several customer organisations and picks
 * one. That needs an organisation switcher and an invite flow, and it is
 * blocked on the open question of whether customer-side users get direct access
 * or everything is mediated by the consultancy. See docs/product.md.
 *
 * What matters now is that `organisationId` is threaded through every table and
 * every query from the first migration, so adding the switcher later is a UI
 * change rather than a retrofit of the tenant boundary.
 */
export async function resolveActive(user: {
  id: string;
  name?: string | null;
  company?: string | null;
}): Promise<OrganisationSummary> {
  const existing = await listForUser(user.id);
  if (existing.length > 0) return existing[0]!;

  // A platform operator must never have a workspace conjured for them. The gate
  // refuses this in `admit` before ever calling here, but the check is repeated
  // at the point of creation because that is the only place it cannot be
  // routed around — and getting it wrong is not recoverable by the next
  // request. It has already happened once: a stale build served an older
  // `admit`, and the operator's first visit to a dashboard put an organisation
  // named after them into the customer list, indistinguishable from a real one.
  const operator = await prisma.user.findUnique({
    where: { id: user.id },
    select: { isPlatformAdmin: true },
  });
  if (operator?.isPlatformAdmin) {
    throw new NotAMember();
  }

  const name = (user.company || user.name || "My organisation").trim();
  let slug = slugify(name);

  // Slugs are globally unique; two customers may legitimately share a name.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clash = await prisma.organisation.findUnique({ where: { slug } });
    if (!clash) break;
    slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const organisation = await prisma.organisation.create({
    data: {
      name,
      slug,
      memberships: { create: { userId: user.id, role: "owner" } },
    },
  });

  return {
    id: organisation.id,
    name: organisation.name,
    slug: organisation.slug,
    role: "owner",
  };
}
