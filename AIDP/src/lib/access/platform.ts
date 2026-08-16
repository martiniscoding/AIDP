import { prisma } from "@/lib/prisma";

/**
 * The operator's view of the platform.
 *
 * A platform administrator runs the product. They see which companies exist,
 * who administers each one, who has been admitted, and what everyone is
 * spending on models.
 *
 * They do not see documents. Not the titles, not the contents, not the
 * findings — and that is enforced here rather than left to whoever writes the
 * next page, because "don't select that column" is not a security control. Read
 * `summarise` below: every query in this file returns counts and identities,
 * and the only thing said about a customer's documents is how many there are.
 *
 * The reason is contractual as much as ethical. These are enterprise standards
 * documents, routinely marked Internal Use or Confidential, held by us as a
 * vendor. A support login that could read them would be a finding in the
 * customer's own audit of us.
 */

/** Emails that become administrators on sign-in. Bootstrap only — the database
 *  column is the authority once set, so removing an email here does not demote
 *  anybody. Do that in the console. */
function bootstrapEmails(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Promote an account listed in the environment.
 *
 * Called on every request for a non-admin, which sounds expensive and is not:
 * the list is almost always empty, and the function returns before touching the
 * database. It only ever grants — never revokes — so a deploy that forgets the
 * variable cannot lock the operator out of their own console.
 */
export async function promoteFromEnvironment<T extends { id: string; email: string; isPlatformAdmin: boolean }>(
  user: T,
): Promise<T> {
  const emails = bootstrapEmails();
  if (emails.length === 0) return user;
  if (!emails.includes(user.email.toLowerCase())) return user;

  await prisma.user.update({
    where: { id: user.id },
    data: { isPlatformAdmin: true },
  });
  return { ...user, isPlatformAdmin: true };
}

export class NotPlatformAdmin extends Error {
  constructor() {
    super("This area is restricted to platform administrators.");
    this.name = "NotPlatformAdmin";
  }
}

export type PlatformOrganisation = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  owners: { id: string; name: string; email: string }[];
  memberCount: number;
  /** Admitted but not yet signed in. */
  invitedCount: number;
  /** On the roster with no access — imported and never granted. */
  pendingCount: number;
  revokedCount: number;
  /** How many documents exist. Deliberately the only fact about them. */
  documentCount: number;
  assessmentCount: number;
  totalTokens: number;
  lastActivityAt: Date | null;
};

/**
 * Every customer, with the numbers an operator needs and nothing else.
 *
 * Note what is selected from `document`: `_count`, and no other field. There is
 * no code path in the admin console that reads a document title, and adding one
 * would mean editing this comment first.
 */
export async function listOrganisations(): Promise<PlatformOrganisation[]> {
  const organisations = await prisma.organisation.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      _count: { select: { documents: true, runs: true } },
      memberships: {
        select: {
          role: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
      roster: { select: { status: true } },
    },
  });

  // Spend and recency in two grouped queries rather than per organisation.
  const [spend, latest] = await Promise.all([
    prisma.tokenUsage.groupBy({
      by: ["organisationId"],
      _sum: { totalTokens: true },
    }),
    prisma.tokenUsage.groupBy({
      by: ["organisationId"],
      _max: { createdAt: true },
    }),
  ]);

  const tokensBy = new Map(spend.map((row) => [row.organisationId, row._sum.totalTokens ?? 0]));
  const seenBy = new Map(latest.map((row) => [row.organisationId, row._max.createdAt]));

  return organisations.map((organisation) => {
    const counts = { imported: 0, allowed: 0, active: 0, revoked: 0 };
    for (const entry of organisation.roster) {
      if (entry.status in counts) counts[entry.status as keyof typeof counts] += 1;
    }
    return {
      id: organisation.id,
      name: organisation.name,
      slug: organisation.slug,
      createdAt: organisation.createdAt,
      owners: organisation.memberships
        .filter((membership) => membership.role === "owner")
        .map((membership) => membership.user),
      memberCount: organisation.memberships.length,
      invitedCount: counts.allowed,
      pendingCount: counts.imported,
      revokedCount: counts.revoked,
      documentCount: organisation._count.documents,
      assessmentCount: organisation._count.runs,
      totalTokens: tokensBy.get(organisation.id) ?? 0,
      lastActivityAt: seenBy.get(organisation.id) ?? null,
    };
  });
}

export type PlatformPerson = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  jobTitle: string;
  department: string;
  joinedAt: Date | null;
  isPlatformAdmin: boolean;
  totalTokens: number;
};

export type PlatformOrganisationDetail = PlatformOrganisation & {
  people: PlatformPerson[];
};

/** One customer in full — still people and spend only. */
export async function organisationDetail(
  organisationId: string,
): Promise<PlatformOrganisationDetail | null> {
  const all = await listOrganisations();
  const summary = all.find((organisation) => organisation.id === organisationId);
  if (!summary) return null;

  const [roster, memberships, spend] = await Promise.all([
    prisma.rosterEntry.findMany({
      where: { organisationId },
      orderBy: [{ status: "asc" }, { email: "asc" }],
      select: {
        email: true,
        name: true,
        role: true,
        status: true,
        jobTitle: true,
        department: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, isPlatformAdmin: true } },
      },
    }),
    prisma.membership.findMany({
      where: { organisationId },
      select: {
        role: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, isPlatformAdmin: true } },
      },
    }),
    prisma.tokenUsage.groupBy({
      by: ["userId"],
      where: { organisationId },
      _sum: { totalTokens: true },
    }),
  ]);

  const tokensBy = new Map(spend.map((row) => [row.userId ?? "", row._sum.totalTokens ?? 0]));

  const people = new Map<string, PlatformPerson>();
  for (const entry of roster) {
    people.set(entry.email, {
      id: entry.user?.id ?? entry.email,
      name: entry.user?.name || entry.name,
      email: entry.email,
      role: entry.role,
      status: entry.status,
      jobTitle: entry.jobTitle,
      department: entry.department,
      joinedAt: entry.createdAt,
      isPlatformAdmin: entry.user?.isPlatformAdmin ?? false,
      totalTokens: tokensBy.get(entry.user?.id ?? "") ?? 0,
    });
  }
  // A member with no roster row predates the roster. Show them rather than
  // letting the console imply the organisation has fewer people than it does.
  for (const membership of memberships) {
    const email = membership.user.email.toLowerCase();
    if (people.has(email)) continue;
    people.set(email, {
      id: membership.user.id,
      name: membership.user.name,
      email,
      role: membership.role,
      status: "active",
      jobTitle: "",
      department: "",
      joinedAt: membership.createdAt,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      totalTokens: tokensBy.get(membership.user.id) ?? 0,
    });
  }

  return { ...summary, people: [...people.values()] };
}
