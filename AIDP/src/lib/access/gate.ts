import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveActive, type OrganisationSummary } from "@/lib/ingest/org";
import { grantsAccess } from "./roster-status";
import { OWNER, MEMBER, isOwner, toRole, type OrgRole } from "./roles";
import { promoteFromEnvironment } from "./platform";

/**
 * The door.
 *
 * Every authenticated surface goes through `requireAccess`. It answers three
 * questions at once — who is this, which organisation are they working in, and
 * are they still allowed in — because answering them separately is how a page
 * ends up checking the session and forgetting the roster.
 *
 * Admission is decided by `RosterEntry`, not by `Membership`. A membership is
 * the *consequence* of admission and this module is the only thing that creates
 * one; see the note on the model. That inversion is what makes revocation work:
 * the owner sets a status, and the next request through this gate finds no
 * membership and no roster grant, and stops.
 */

export type AccessDenied = {
  reason: "revoked" | "not-admitted" | "no-organisation";
  message: string;
};

export type Access = {
  user: {
    id: string;
    name: string;
    email: string;
    company: string;
    isPlatformAdmin: boolean;
  };
  organisation: OrganisationSummary;
  role: OrgRole;
  /** True for an owner of this organisation — the customer's own administrator. */
  isOwner: boolean;
};

export class NoAccess extends Error {
  constructor(readonly denial: AccessDenied) {
    super(denial.message);
    this.name = "NoAccess";
  }
}

/** The signed-in account, or null. Reads the database rather than trusting the
 *  session payload: `isPlatformAdmin` decides what the admin console shows, and
 *  a stale session should not be able to assert it. */
export async function currentUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      company: true,
      isPlatformAdmin: true,
    },
  });
  if (!user) return null;

  // Bootstrap: an operator listed in PLATFORM_ADMIN_EMAILS becomes one on their
  // next request. Only ever promotes, and only from a value that requires a
  // deploy to change.
  return user.isPlatformAdmin ? user : await promoteFromEnvironment(user);
}

/**
 * Attach a newly registered account to the organisation that invited it.
 *
 * Runs on first request rather than in a Better Auth hook, so that a person
 * admitted *after* they already had an account is picked up too — the owner
 * flips a status and the next page load finds it.
 *
 * The two paths here are the whole registration story:
 *
 *   - the email is on somebody's roster  -> they are an employee, and they join
 *                                           that organisation at the role the
 *                                           owner chose.
 *   - the email is on nobody's roster    -> they are registering their own
 *                                           company, and become its owner.
 *
 * A person on a roster cannot take the second path. That is deliberate: if an
 * employee could quietly found their own tenant, revoking them from the real
 * one would achieve nothing.
 *
 * Exported so it can be tested on its own. It takes a user rather than reading
 * the session precisely so that it can be — the session lookup is
 * `requireAccess`'s job, and this is the part with the rules in it.
 */
export async function admit(user: {
  id: string;
  name: string;
  email: string;
  company: string;
  isPlatformAdmin?: boolean;
}): Promise<{ organisation: OrganisationSummary; role: OrgRole } | AccessDenied> {
  const email = user.email.toLowerCase();

  // Existing memberships first — the common case, and it costs one query.
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: { organisation: true },
    orderBy: { createdAt: "asc" },
  });

  const rosters = await prisma.rosterEntry.findMany({
    where: { email },
    orderBy: { createdAt: "asc" },
  });

  if (memberships.length > 0) {
    const membership = memberships[0]!;
    const entry = rosters.find((r) => r.organisationId === membership.organisationId);

    // An owner is not gated by the roster. They created the organisation, and a
    // roster they administer cannot be the thing that locks them out of it —
    // that is a trap with no key, since only an owner can lift it.
    if (!isOwner(membership.role) && entry && !grantsAccess(entry.status)) {
      return {
        reason: entry.status === "revoked" ? "revoked" : "not-admitted",
        message:
          entry.status === "revoked"
            ? "Your access to this workspace has been withdrawn. Contact your administrator."
            : "Your account is not yet admitted to this workspace. Contact your administrator.",
      };
    }

    // First sign-in against an invitation: mark the seat taken.
    if (entry && entry.status === "allowed") {
      await prisma.rosterEntry.update({
        where: { id: entry.id },
        data: { status: "active", userId: user.id },
      });
    }

    return {
      organisation: {
        id: membership.organisation.id,
        name: membership.organisation.name,
        slug: membership.organisation.slug,
        role: membership.role,
      },
      role: toRole(membership.role),
    };
  }

  // No membership yet. Does anyone claim this person?
  const invite = rosters.find((r) => grantsAccess(r.status));
  if (invite) {
    const organisation = await prisma.organisation.findUnique({
      where: { id: invite.organisationId },
    });
    if (organisation) {
      const role = toRole(invite.role);
      // Both writes together: a membership without the roster link would leave
      // the owner's list showing an invitation that has plainly been accepted.
      await prisma.$transaction([
        prisma.membership.create({
          data: { userId: user.id, organisationId: organisation.id, role },
        }),
        prisma.rosterEntry.update({
          where: { id: invite.id },
          data: { status: "active", userId: user.id },
        }),
      ]);
      return {
        organisation: {
          id: organisation.id,
          name: organisation.name,
          slug: organisation.slug,
          role,
        },
        role,
      };
    }
  }

  // On a roster, but not an admitted one.
  const blocked = rosters[0];
  if (blocked) {
    return {
      reason: blocked.status === "revoked" ? "revoked" : "not-admitted",
      message:
        blocked.status === "revoked"
          ? "Your access to this workspace has been withdrawn. Contact your administrator."
          : "Your administrator has not yet granted you access. They can do that from the People page.",
    };
  }

  // A platform operator is nobody's employee either, but they are not
  // registering a company — they run the product. Founding one for them would
  // put an organisation named "Dexter" in the customer list the first time they
  // clicked through to a dashboard, and it would be indistinguishable from a
  // real customer afterwards. An operator who *does* legitimately run a
  // workspace still has a membership, and returned above.
  if (user.isPlatformAdmin) {
    return {
      reason: "no-organisation",
      message:
        "This account operates the platform and does not belong to a company. Use the admin console.",
    };
  }

  // Nobody's employee — they are registering their own company.
  //
  // Instrumented because an operator reached this line in a browser while
  // refusing to under curl, and no amount of reading explained it. Founding a
  // workspace is rare and irreversible, so it is worth one log line saying who
  // it was for and what the guard above saw.
  console.info(
    "[access] founding an organisation",
    JSON.stringify({
      userId: user.id,
      email: user.email,
      isPlatformAdmin: user.isPlatformAdmin ?? null,
      company: user.company,
      rosterRowsForEmail: rosters.length,
    }),
  );
  const organisation = await resolveActive(user);
  await prisma.rosterEntry.upsert({
    where: { organisationId_email: { organisationId: organisation.id, email } },
    // The founder appears on their own roster so the People page opens with
    // somebody on it, and so "who administers this?" has an answer in one place.
    create: {
      organisationId: organisation.id,
      email,
      name: user.name,
      status: "active",
      role: OWNER,
      source: "signup",
      userId: user.id,
    },
    update: { status: "active", userId: user.id },
  });
  return { organisation, role: OWNER };
}

/**
 * Resolve the caller, or throw.
 *
 * Throws `NoAccess` with a stated reason rather than returning null, so a
 * caller cannot forget to check. Pages catch it and render the reason; Server
 * Actions let it become a refusal.
 */
export async function requireAccess(): Promise<Access> {
  const user = await currentUser();
  if (!user) {
    throw new NoAccess({
      reason: "not-admitted",
      message: "Sign in to continue.",
    });
  }

  const outcome = await admit(user);
  if ("reason" in outcome) throw new NoAccess(outcome);

  return {
    user,
    organisation: outcome.organisation,
    role: outcome.role,
    isOwner: outcome.role === OWNER,
  };
}

/**
 * Access for a page or layout, resolved to a destination rather than an error.
 *
 * `requireAccess` throws, which is right for a Server Action and wrong here. A
 * page renders concurrently with its layout, so when both call it and both
 * throw, the outcome is a race between the layout's redirect and the page's
 * error — the same request can redirect or blow up depending on which settles
 * first. That is exactly the bug that let an operator land on a dashboard.
 *
 * So nothing on the render path throws any more. Everyone who cannot work in a
 * workspace is *sent* somewhere they can: an operator to their console,
 * everybody else to a page that explains why. Pages and layouts use this;
 * Server Actions keep `requireAccess`, because a POST has no destination.
 */
export async function requireWorkspace(): Promise<Access> {
  try {
    return await requireAccess();
  } catch (error) {
    if (!(error instanceof NoAccess)) throw error;

    const user = await currentUser();
    if (!user) redirect("/sign-in");
    // An operator has no workspace by design, and their console is one hop
    // away. Sending them there beats a refusal they can do nothing about.
    if (user.isPlatformAdmin) redirect("/admin");

    redirect(`/no-access?reason=${encodeURIComponent(error.denial.reason)}`);
  }
}

/**
 * As `requireAccess`, and refuses anyone who is not this customer's own
 * administrator.
 *
 * Throws, so it belongs in Server Actions — a POST has nowhere to be sent.
 * Pages want `requireOwnerWorkspace` below.
 */
export async function requireOwner(): Promise<Access> {
  const access = await requireAccess();
  if (!access.isOwner) {
    throw new NoAccess({
      reason: "not-admitted",
      message: "Only an administrator of this workspace can manage this.",
    });
  }
  return access;
}

/**
 * The administrator-only equivalent of `requireWorkspace`, for pages.
 *
 * Same reasoning, and the same bug it was written to fix: a page renders
 * concurrently with its layout, so a page that *throws* leaves the outcome to
 * whichever settles first. `requireWorkspace` was fixed for that and
 * `requireOwner` was not, which left the three administrator pages answering a
 * member with a rendered error instead of a redirect.
 *
 * A member is sent to their own dashboard rather than to /no-access: they have
 * a workspace and are perfectly entitled to be in it, they simply do not
 * administer it.
 */
export async function requireOwnerWorkspace(): Promise<Access> {
  const access = await requireWorkspace();
  if (!access.isOwner) redirect("/dashboard");
  return access;
}

export { MEMBER, OWNER };
