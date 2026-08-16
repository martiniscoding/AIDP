import { prisma } from "@/lib/prisma";
import { OWNER, MEMBER, isOwner, toRole, type OrgRole } from "./roles";
import { grantsAccess, type RosterStatus } from "./roster-status";
import { provisionAccount } from "./provision";
import type { ParsedPerson } from "./spreadsheet";

/**
 * Managing who is in a customer's workspace.
 *
 * Every write here belongs to the customer's own administrator, and every one
 * of them takes the acting `Access` rather than an organisation id, so there is
 * no signature in this module that can be called without having proved who is
 * asking.
 *
 * Two rules are enforced rather than left to the UI, because the UI is not the
 * only caller of a Server Action:
 *
 *   - an organisation always keeps at least one administrator. Removing the
 *     last one leaves a workspace nobody can administer and no way back in.
 *   - nobody revokes themselves. It is never what was meant, and it is
 *     irreversible from the acting account.
 */

export class RosterRefused extends Error {}

export type Person = {
  id: string;
  email: string;
  name: string;
  jobTitle: string;
  department: string;
  status: RosterStatus;
  role: OrgRole;
  source: string;
  hasAccount: boolean;
  userId: string | null;
  allowedAt: Date | null;
  allowedByName: string;
  revokedAt: Date | null;
  revokedByName: string;
  createdAt: Date;
  /** Model spend attributed to this person, all time. */
  totalTokens: number;
  lastActiveAt: Date | null;
};

type Actor = {
  user: { id: string; name: string; email: string };
  organisation: { id: string };
  isOwner: boolean;
};

function assertOwner(actor: Actor): void {
  if (!actor.isOwner) {
    throw new RosterRefused("Only an administrator of this workspace can manage its people.");
  }
}

/** The roster, with each person's spend alongside. */
export async function list(organisationId: string): Promise<Person[]> {
  const [entries, spend, lastSeen] = await Promise.all([
    prisma.rosterEntry.findMany({
      where: { organisationId },
      orderBy: [{ createdAt: "asc" }],
      include: { user: { select: { id: true, name: true } } },
    }),
    prisma.tokenUsage.groupBy({
      by: ["userId"],
      where: { organisationId },
      _sum: { totalTokens: true },
    }),
    prisma.tokenUsage.groupBy({
      by: ["userId"],
      where: { organisationId },
      _max: { createdAt: true },
    }),
  ]);

  const tokensBy = new Map(spend.map((row) => [row.userId ?? "", row._sum.totalTokens ?? 0]));
  const seenBy = new Map(lastSeen.map((row) => [row.userId ?? "", row._max.createdAt]));

  return entries.map((entry) => ({
    id: entry.id,
    email: entry.email,
    // The account name wins once there is one: a person is the authority on
    // their own name, not whatever the HR export said.
    name: entry.user?.name || entry.name,
    jobTitle: entry.jobTitle,
    department: entry.department,
    status: entry.status as RosterStatus,
    role: toRole(entry.role),
    source: entry.source,
    hasAccount: entry.userId !== null,
    userId: entry.userId,
    allowedAt: entry.allowedAt,
    allowedByName: entry.allowedByName,
    revokedAt: entry.revokedAt,
    revokedByName: entry.revokedByName,
    createdAt: entry.createdAt,
    totalTokens: tokensBy.get(entry.userId ?? "") ?? 0,
    lastActiveAt: seenBy.get(entry.userId ?? "") ?? null,
  }));
}

/**
 * Bring a roster row's membership into line with its status.
 *
 * The single place a status becomes access. Called after every write that could
 * change one, so there is no path where the two disagree — which is the failure
 * that would matter, since `Membership` is what the rest of the codebase checks
 * through `requireMembership`.
 *
 * Revocation deletes the person's sessions as well as their membership.
 * Without that, someone already signed in keeps working until their cookie
 * expires, and "revoked" would mean "revoked tomorrow".
 */
async function syncMembership(entry: {
  organisationId: string;
  userId: string | null;
  status: string;
  role: string;
}): Promise<void> {
  if (!entry.userId) return;
  const { userId, organisationId } = entry;

  if (grantsAccess(entry.status)) {
    await prisma.membership.upsert({
      where: { userId_organisationId: { userId, organisationId } },
      create: { userId, organisationId, role: toRole(entry.role) },
      update: { role: toRole(entry.role) },
    });
    return;
  }

  await prisma.membership.deleteMany({ where: { userId, organisationId } });

  // Only sign them out if this was their last way in. A consultant revoked from
  // one customer should stay signed in to the other.
  const elsewhere = await prisma.membership.count({ where: { userId } });
  if (elsewhere === 0) {
    await prisma.session.deleteMany({ where: { userId } });
  }
}

/** How many administrators would remain if these rows stopped being ones. */
async function ownersRemaining(organisationId: string, excluding: string[]): Promise<number> {
  return prisma.rosterEntry.count({
    where: {
      organisationId,
      role: OWNER,
      status: { in: ["allowed", "active"] },
      id: { notIn: excluding },
    },
  });
}

async function loadOwned(actor: Actor, ids: string[]) {
  const entries = await prisma.rosterEntry.findMany({
    where: { id: { in: ids }, organisationId: actor.organisation.id },
  });
  // A row from another organisation is silently absent rather than an error —
  // the tenant filter above is what makes an id from a crafted POST inert.
  if (entries.length === 0) throw new RosterRefused("Those people are no longer on this list.");
  return entries;
}

/** Add one person by hand. */
export async function addPerson(
  actor: Actor,
  input: { email: string; name?: string; jobTitle?: string; department?: string; role?: string },
  options: { admit: boolean },
): Promise<Person> {
  assertOwner(actor);

  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new RosterRefused("That is not an email address.");

  const role = input.role === OWNER ? OWNER : MEMBER;
  const status: RosterStatus = options.admit ? "allowed" : "imported";
  const admitted = options.admit
    ? { allowedAt: new Date(), allowedById: actor.user.id, allowedByName: actor.user.name }
    : {};

  // Someone who already holds an account — an existing user being added to a
  // second organisation — is linked immediately, so they are "active" rather
  // than sitting on an invitation they have no reason to accept.
  const account = await prisma.user.findUnique({ where: { email }, select: { id: true } });

  const entry = await prisma.rosterEntry.upsert({
    where: { organisationId_email: { organisationId: actor.organisation.id, email } },
    create: {
      organisationId: actor.organisation.id,
      email,
      name: input.name?.trim() ?? "",
      jobTitle: input.jobTitle?.trim() ?? "",
      department: input.department?.trim() ?? "",
      role,
      source: "manual",
      status: options.admit && account ? "active" : status,
      userId: account?.id ?? null,
      ...admitted,
    },
    update: {
      name: input.name?.trim() || undefined,
      jobTitle: input.jobTitle?.trim() || undefined,
      department: input.department?.trim() || undefined,
      role,
      // Re-adding somebody who was revoked is a re-admission, and should not
      // silently leave them locked out.
      status: options.admit ? (account ? "active" : "allowed") : undefined,
      userId: account?.id ?? undefined,
      ...admitted,
    },
  });

  await syncMembership(entry);
  return (await list(actor.organisation.id)).find((person) => person.id === entry.id)!;
}

export type ImportResult = { added: number; updated: number; skipped: number };

/**
 * Load a parsed staff list.
 *
 * Everyone arrives as "imported" — present, with no access. Anyone already on
 * the roster keeps their status: re-importing last month's export must not
 * demote the people who have since been admitted, and must not resurrect the
 * ones who were revoked.
 */
export async function importPeople(actor: Actor, people: ParsedPerson[]): Promise<ImportResult> {
  assertOwner(actor);

  const existing = await prisma.rosterEntry.findMany({
    where: {
      organisationId: actor.organisation.id,
      email: { in: people.map((person) => person.email) },
    },
    select: { email: true },
  });
  const known = new Set(existing.map((entry) => entry.email));

  let added = 0;
  let updated = 0;

  // Sequential rather than one transaction: a two-hundred-row upload should
  // not be all-or-nothing, and the unique constraint makes each write safe on
  // its own.
  for (const person of people) {
    await prisma.rosterEntry.upsert({
      where: { organisationId_email: { organisationId: actor.organisation.id, email: person.email } },
      create: {
        organisationId: actor.organisation.id,
        email: person.email,
        name: person.name,
        jobTitle: person.jobTitle,
        department: person.department,
        status: "imported",
        role: MEMBER,
        source: "import",
      },
      // Details refresh, status does not.
      update: {
        name: person.name || undefined,
        jobTitle: person.jobTitle || undefined,
        department: person.department || undefined,
      },
    });
    if (known.has(person.email)) updated += 1;
    else added += 1;
  }

  return { added, updated, skipped: 0 };
}

/** Admit people. Idempotent — admitting someone already admitted is a no-op. */
export async function grant(actor: Actor, ids: string[], role: string = MEMBER): Promise<number> {
  assertOwner(actor);
  const entries = await loadOwned(actor, ids);
  const wanted = role === OWNER ? OWNER : MEMBER;

  let changed = 0;
  for (const entry of entries) {
    const status: RosterStatus = entry.userId ? "active" : "allowed";
    const updated = await prisma.rosterEntry.update({
      where: { id: entry.id },
      data: {
        status,
        role: wanted,
        allowedAt: new Date(),
        allowedById: actor.user.id,
        allowedByName: actor.user.name,
        revokedAt: null,
        revokedById: null,
        revokedByName: "",
      },
    });
    await syncMembership(updated);
    changed += 1;
  }
  return changed;
}

/** Withdraw access. The row stays; the membership and sessions do not. */
export async function revoke(actor: Actor, ids: string[]): Promise<number> {
  assertOwner(actor);
  const entries = await loadOwned(actor, ids);

  if (entries.some((entry) => entry.userId === actor.user.id)) {
    throw new RosterRefused("You cannot revoke your own access.");
  }

  const owners = entries.filter((entry) => isOwner(entry.role) && grantsAccess(entry.status));
  if (owners.length > 0) {
    const remaining = await ownersRemaining(
      actor.organisation.id,
      owners.map((entry) => entry.id),
    );
    if (remaining === 0) {
      throw new RosterRefused(
        "That would leave the workspace with no administrator. Make someone else an administrator first.",
      );
    }
  }

  for (const entry of entries) {
    const updated = await prisma.rosterEntry.update({
      where: { id: entry.id },
      data: {
        status: "revoked",
        revokedAt: new Date(),
        revokedById: actor.user.id,
        revokedByName: actor.user.name,
      },
    });
    await syncMembership(updated);
  }
  return entries.length;
}

/** Promote to administrator, or demote to member. */
export async function setRole(actor: Actor, id: string, role: string): Promise<void> {
  assertOwner(actor);
  const [entry] = await loadOwned(actor, [id]);
  const wanted = role === OWNER ? OWNER : MEMBER;
  if (!entry || toRole(entry.role) === wanted) return;

  if (isOwner(entry.role) && wanted === MEMBER) {
    if (entry.userId === actor.user.id) {
      throw new RosterRefused(
        "You cannot remove your own administrator rights. Ask another administrator to do it.",
      );
    }
    const remaining = await ownersRemaining(actor.organisation.id, [entry.id]);
    if (remaining === 0) {
      throw new RosterRefused("That would leave the workspace with no administrator.");
    }
  }

  const updated = await prisma.rosterEntry.update({
    where: { id: entry.id },
    data: { role: wanted },
  });
  await syncMembership(updated);
}

/**
 * Issue credentials for someone on the roster.
 *
 * Admits them at the same time. An administrator setting a password has plainly
 * decided this person should be able to sign in, and leaving them with working
 * credentials and no access would be a trap: the password would be accepted and
 * the door still shut, which reads as a broken product rather than a policy.
 */
export async function setPassword(
  actor: Actor,
  id: string,
  password: string,
): Promise<{ created: boolean; email: string }> {
  assertOwner(actor);
  const [entry] = await loadOwned(actor, [id]);
  if (!entry) throw new RosterRefused("That person is no longer on this list.");

  const organisation = await prisma.organisation.findUnique({
    where: { id: actor.organisation.id },
    select: { name: true },
  });

  const { userId, created } = await provisionAccount({
    email: entry.email,
    name: entry.name,
    company: organisation?.name ?? "",
    password,
  });

  const updated = await prisma.rosterEntry.update({
    where: { id: entry.id },
    data: {
      userId,
      status: "active",
      allowedAt: entry.allowedAt ?? new Date(),
      allowedById: entry.allowedById ?? actor.user.id,
      allowedByName: entry.allowedByName || actor.user.name,
      revokedAt: null,
      revokedById: null,
      revokedByName: "",
    },
  });
  await syncMembership(updated);

  return { created, email: entry.email };
}

/**
 * Delete a row outright.
 *
 * Only for people who never had access. Someone who was admitted is revoked
 * instead, never deleted — "was admitted in March, revoked in June" is the
 * question an audit asks, and a deleted row cannot answer it.
 */
export async function removePerson(actor: Actor, id: string): Promise<void> {
  assertOwner(actor);
  const [entry] = await loadOwned(actor, [id]);
  if (!entry) return;

  if (entry.status !== "imported") {
    throw new RosterRefused(
      "This person has held access. Revoke them instead — the record has to stay.",
    );
  }
  await prisma.rosterEntry.delete({ where: { id: entry.id } });
}
