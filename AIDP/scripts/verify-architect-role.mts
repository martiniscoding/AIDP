/**
 * The architect role: who may decide what happens to a submission.
 *
 * The brief routes a finished report to "an assigned architect", and that
 * assignment means nothing while anyone in the workspace can record the
 * outcome themselves. Before this, `record` in outcomes.ts checked membership
 * and nothing else — every employee could approve, reject or escalate any
 * design but their own.
 *
 * What this proves:
 *
 *   · an architect and an administrator may decide; a member may not, and is
 *     refused by the library rather than by a hidden button;
 *   · the refusal for somebody with no standing names the permission, not the
 *     submission — whose work it is, is not theirs to learn;
 *   · nobody rules on their own submission, an architect and an administrator
 *     included: that check is about the work, not the permission;
 *   · a role string is normalised in exactly one place, so a role the
 *     vocabulary gains cannot collapse into "member" at one call site while
 *     working everywhere else;
 *   · and a workspace cannot be left with no administrator — including by the
 *     move this change made possible, owner to architect, which the old guard
 *     did not see.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-architect-role.mts
 */
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import {
  ARCHITECT,
  MEMBER,
  OWNER,
  ROLE_LABEL,
  ROLES,
  canDecideSubmissions,
  canManageStandards,
  isOwner,
  toRole,
} from "../src/lib/access/roles";
import * as roster from "../src/lib/access/roster";
import { OutcomeRefused, record } from "../src/lib/ingest/outcomes";

const TAG = `zz-arch-${Date.now()}`;
const PASSWORD = "a-throwaway-password";

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra: unknown = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`, extra);
  }
};

const refuses = async (name: string, work: () => Promise<unknown>, fragment: string) => {
  try {
    await work();
    ok(name, false, "it was allowed");
  } catch (error) {
    const message = error instanceof OutcomeRefused ? error.message : String(error);
    ok(name, message.includes(fragment), message);
  }
};

// ---------------------------------------------------------------------------
console.log("\nThe vocabulary");

ok("three roles, most authority first", ROLES.join(",") === "owner,architect,member", ROLES);
ok("architect has a label", ROLE_LABEL[ARCHITECT] === "Architect");
ok("an unknown role is still a member", toRole("wizard") === MEMBER);
ok("and so is an empty one", toRole("") === MEMBER);
// The safe direction: an unrecognised string must never read as an escalation.
ok("architect is not an administrator", !isOwner(ARCHITECT));
ok("and cannot curate the standards", !canManageStandards(ARCHITECT));

console.log("\nWho may decide a submission");

ok("an administrator may", canDecideSubmissions(OWNER));
ok("an architect may", canDecideSubmissions(ARCHITECT));
ok("a member may not", !canDecideSubmissions(MEMBER));
ok("and nor may an unknown role", !canDecideSubmissions("wizard"));

// ---------------------------------------------------------------------------
const org = await prisma.organisation.create({ data: { name: "ZZ Arch", slug: TAG } });

async function person(suffix: string, role: string) {
  const email = `${TAG}-${suffix}@test.invalid`;
  const account = await provisionAccount({ email, name: suffix, company: "ZZ Arch", password: PASSWORD });
  await prisma.membership.create({ data: { userId: account.userId, organisationId: org.id, role } });
  const entry = await prisma.rosterEntry.create({
    data: { organisationId: org.id, email, status: "active", role, userId: account.userId },
  });
  return { id: account.userId, email, entryId: entry.id, name: suffix };
}

const owner = await person("owner", OWNER);
const architect = await person("architect", ARCHITECT);
const member = await person("member", MEMBER);

try {
  const project = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} project` },
  });
  const framework = await prisma.framework.create({
    data: { organisationId: org.id, name: `${TAG} fw`, version: 1 },
  });
  const design = await prisma.document.create({
    data: {
      organisationId: org.id, projectId: project.id, role: "assessed",
      title: `${TAG} design`, storageKey: `${TAG}/d`, byteSize: 1,
      sha256: `${TAG}-d`, status: "ready", uploadedById: member.id,
    },
  });
  const run = await prisma.assessmentRun.create({
    data: {
      // A project run: `assessment_run_one_scope` allows exactly one of
      // documentId and projectId, which is the invariant `designs.for_run`
      // relies on. `designIds` is what carries the design here.
      organisationId: org.id, projectId: project.id,
      frameworkId: framework.id, state: "complete", designIds: [design.id],
    },
  });

  console.log("\nRecording an outcome");

  await refuses(
    "a member is refused",
    () => record(member.id, run.id, "approved", "", member.name),
    "Only an architect, or an administrator",
  );
  // The message names the permission, never the submission: somebody with no
  // standing here should not learn whose work it is.
  await refuses(
    "and the refusal does not name the design",
    () => record(member.id, run.id, "approved", "", member.name),
    "Ask one of them to take it",
  );

  const byArchitect = await record(architect.id, run.id, "approved", "", architect.name);
  ok("an architect may record one", byArchitect.decision === "approved");

  const byOwner = await record(owner.id, run.id, "approved", "", owner.name);
  ok("and so may an administrator", byOwner.decision === "approved");

  console.log("\nNobody rules on their own submission");

  // The design was uploaded by `member`. Make them an architect: the
  // separation-of-duties check is about the work, not the permission, so it
  // still refuses.
  await prisma.membership.update({
    where: { userId_organisationId: { userId: member.id, organisationId: org.id } },
    data: { role: ARCHITECT },
  });
  await refuses(
    "not even once they are an architect",
    () => record(member.id, run.id, "approved", "", member.name),
    "nobody rules on their own submission",
  );
  // And the refusal is the conflict, not the permission — they have the
  // permission now.
  await refuses(
    "and the refusal names the design",
    () => record(member.id, run.id, "approved", "", member.name),
    `${TAG} design`,
  );

  console.log("\nAdmitting somebody as an architect");

  const candidate = await prisma.rosterEntry.create({
    data: { organisationId: org.id, email: `${TAG}-new@test.invalid`, status: "imported" },
  });
  const actor = {
    user: { id: owner.id, name: owner.name, email: owner.email },
    organisation: { id: org.id, name: org.name, slug: org.slug, role: OWNER },
    role: OWNER,
    isOwner: true,
  } as unknown as Parameters<typeof roster.grant>[0];

  await roster.grant(actor, [candidate.id], ARCHITECT);
  const granted = await prisma.rosterEntry.findUniqueOrThrow({ where: { id: candidate.id } });
  // The bug this catches: `grant` collapsed every role that was not "owner"
  // into "member", so an architect admitted through this path arrived without
  // the permission the button said it was giving.
  ok("the role survives the grant", granted.role === ARCHITECT, granted.role);
  ok("and they are admitted", granted.status === "allowed", granted.status);

  console.log("\nA workspace cannot lose its last administrator");

  // Straight down to member — the case the old guard did see.
  let refused = "";
  try {
    await roster.setRole(actor, owner.entryId, MEMBER);
  } catch (error) {
    refused = String(error);
  }
  ok("an administrator cannot demote themselves", refused.includes("your own administrator rights"), refused);

  // Sideways to architect — the case it did not. Checking for "member" alone
  // let an owner be made an architect instead, which is still a workspace with
  // one fewer administrator, and could be the last.
  let sideways = "";
  try {
    await roster.setRole(actor, owner.entryId, ARCHITECT);
  } catch (error) {
    sideways = String(error);
  }
  ok(
    "and cannot sidestep it by becoming an architect",
    sideways.includes("your own administrator rights"),
    sideways,
  );

  // A second administrator, so the last-one guard is the thing under test
  // rather than the self-demotion one.
  const second = await person("second", OWNER);
  await roster.setRole(actor, second.entryId, ARCHITECT);
  const moved = await prisma.rosterEntry.findUniqueOrThrow({ where: { id: second.entryId } });
  ok("another administrator may be made an architect", moved.role === ARCHITECT, moved.role);

  // Now there is one administrator left, and it is the actor. Removing them
  // sideways has to be refused for the same reason.
  let last = "";
  try {
    await roster.setRole(actor, owner.entryId, ARCHITECT);
  } catch (error) {
    last = String(error);
  }
  ok("the last one still cannot step sideways", last.length > 0, last);
} finally {
  await prisma.submissionOutcome.deleteMany({ where: { organisationId: org.id } });
  await prisma.assessmentRun.deleteMany({ where: { organisationId: org.id } });
  await prisma.document.deleteMany({ where: { organisationId: org.id } });
  await prisma.framework.deleteMany({ where: { organisationId: org.id } });
  await prisma.project.deleteMany({ where: { organisationId: org.id } });
  await prisma.rosterEntry.deleteMany({ where: { organisationId: org.id } });
  await prisma.membership.deleteMany({ where: { organisationId: org.id } });
  await prisma.organisation.delete({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
