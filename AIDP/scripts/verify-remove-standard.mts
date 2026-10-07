/**
 * Taking a standard out of the library.
 *
 * Removing one is not housekeeping: it changes what every future assessment
 * measures against, and it has to do that without rewriting history. What this
 * proves, against a throwaway organisation:
 *
 *   · only an administrator may remove a standard, and a member is refused
 *     with the policy rather than with a fault;
 *   · everything derived from it goes — sections, clauses, chunks, figures —
 *     through the cascade, so no orphan clause is left for a search to find;
 *   · the next assessment measures against the remaining standards: a new
 *     framework version is cut, and the removed clauses are not in its count;
 *   · a run already on record keeps the framework it used, and its findings
 *     keep the clause reference, title and wording they were written with.
 *     This is the one that matters — the fear of breaking last quarter's
 *     report is why a stale standard sits in a library for a year;
 *   · a design is not a standard, and removing one is not governed by the
 *     standards policy.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-remove-standard.mts
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import { canManageStandards, OWNER, MEMBER } from "../src/lib/access/roles";
import {
  countClauses,
  resolveFramework,
  supersedeFrameworksFor,
} from "../src/lib/ingest/assessment";
import { listDocuments } from "../src/lib/ingest/documents";

const TAG = `zz-rmstd-${Date.now()}`;
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
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

const org = await prisma.organisation.create({ data: { name: "ZZ Remove Standard", slug: TAG } });

/** A standard with `clauses` clauses in one section, indexed and ready. */
async function standard(title: string, clauses: number) {
  const document = await prisma.document.create({
    data: {
      organisationId: org.id,
      role: "reference",
      title,
      storageKey: `${TAG}/${title}`,
      byteSize: 10,
      sha256: randomUUID(),
      status: "ready",
    },
    select: { id: true },
  });
  const section = await prisma.documentSection.create({
    data: {
      documentId: document.id,
      ordinal: 1,
      title: "1 Scope",
      headingPath: "1 Scope",
      pageStart: 1,
      pageEnd: 1,
    },
    select: { id: true },
  });
  for (let i = 0; i < clauses; i += 1) {
    await prisma.clause.create({
      data: {
        sectionId: section.id,
        ordinal: i + 1,
        title: `${title} rule ${i + 1}`,
        statement: "Something is required.",
      },
    });
  }
  await prisma.chunk.create({
    data: {
      organisationId: org.id,
      documentId: document.id,
      sourceKind: "section",
      ordinal: 1,
      headingPath: "1 Scope",
      text: "Something is required.",
      tokenCount: 4,
      contentHash: randomUUID(),
    },
  });
  return document.id;
}

try {
  console.log("\nWho may remove a standard");
  ok("an administrator may", canManageStandards(OWNER));
  ok("a member may not", !canManageStandards(MEMBER));

  console.log("\nThe library says what each standard contributes");
  const keep = await standard("Data Standards", 3);
  const drop = await standard("Retired Standards", 2);
  const member = await provisionAccount({
    email: `${TAG}@test.invalid`,
    name: "Member",
    company: org.name,
    password: PASSWORD,
  });
  await prisma.membership.create({
    data: { userId: member.userId, organisationId: org.id, role: MEMBER },
  });
  const listed = await listDocuments(member.userId, org.id);
  const byTitle = new Map(listed.map((d) => [d.title, d]));
  ok("a standard's clause count is on its row", byTitle.get("Data Standards")?.clauses === 3,
     byTitle.get("Data Standards")?.clauses);
  ok("and the one about to go shows its own", byTitle.get("Retired Standards")?.clauses === 2,
     byTitle.get("Retired Standards")?.clauses);

  console.log("\nA run on record, measured against both");
  const before = await resolveFramework(org.id);
  ok("the framework holds both standards", before.documentCount === 2, before.documentCount);
  ok("and counts every clause", before.clauseCount === 5, before.clauseCount);

  const doomed = await prisma.clause.findFirstOrThrow({
    where: { section: { documentId: drop } },
    select: { id: true, title: true },
  });
  const run = await prisma.assessmentRun.create({
    data: {
      organisationId: org.id,
      documentId: keep, // stands in for a design; the point is the framework pin
      frameworkId: before.id,
      state: "complete",
      totalClauses: before.clauseCount,
      completedClauses: before.clauseCount,
      completedAt: new Date(),
    },
    select: { id: true },
  });
  await prisma.finding.create({
    data: {
      runId: run.id,
      clauseId: doomed.id,
      clauseRef: "9.9",
      clauseTitle: doomed.title ?? "",
      clauseStatement: "Something is required.",
      verdict: "contradicts",
      confidence: 0.9,
      rationale: "The design does the opposite.",
    },
  });

  console.log("\nRemoving it");
  // The action's own guard is `canManageStandards`, checked above and over HTTP
  // by verify-standards-http.mts. What is exercised here is what the removal
  // does to the framework, and what survives it — in the order the action does
  // it, because the membership rows have to be read before they cascade away.
  const retired = await supersedeFrameworksFor(drop);
  ok("the version that counted it is retired", retired === 1, retired);
  await prisma.document.delete({ where: { id: drop } });

  ok("the document is gone", (await prisma.document.count({ where: { id: drop } })) === 0);
  ok(
    "its sections went with it",
    (await prisma.documentSection.count({ where: { documentId: drop } })) === 0,
  );
  ok(
    "so did its clauses — none left for a search to find",
    (await prisma.clause.count({ where: { section: { documentId: drop } } })) === 0,
  );
  ok("and its chunks", (await prisma.chunk.count({ where: { documentId: drop } })) === 0);
  ok(
    "the standard that stays is untouched",
    (await prisma.clause.count({ where: { section: { documentId: keep } } })) === 3,
  );

  console.log("\nWhat the next assessment measures against");
  const after = await resolveFramework(org.id);
  ok("a new framework version is cut", after.version > before.version, [before.version, after.version]);
  ok("holding only what is left", after.documentCount === 1, after.documentCount);
  ok("and counting only its clauses", after.clauseCount === 3, after.clauseCount);
  ok("the old version is not reused", after.id !== before.id);
  const retiredRow = await prisma.framework.findUniqueOrThrow({
    where: { id: before.id },
    select: { supersededAt: true, version: true },
  });
  ok("it is still on record, marked superseded", retiredRow.supersededAt !== null, retiredRow);
  ok(
    "and asking again does not hand it back",
    (await resolveFramework(org.id)).id === after.id,
  );

  console.log("\nWhat the report already written keeps");
  const pinned = await prisma.assessmentRun.findUniqueOrThrow({
    where: { id: run.id },
    select: { frameworkId: true, totalClauses: true, findings: true },
  });
  ok("the run still points at the framework it used", pinned.frameworkId === before.id);
  ok("and still says it measured five clauses", pinned.totalClauses === 5, pinned.totalClauses);
  ok("its finding survived the standard", pinned.findings.length === 1, pinned.findings.length);
  const finding = pinned.findings[0];
  ok(
    "reading as it was written, clause and all",
    finding.clauseRef === "9.9"
      && finding.clauseTitle === doomed.title
      && finding.clauseStatement === "Something is required."
      && finding.verdict === "contradicts",
    finding,
  );
  ok(
    "the old framework now counts what is actually left of it",
    (await countClauses(before.id)) === 3,
    await countClauses(before.id),
  );

  console.log("\nA design is not a standard");
  const design = await prisma.document.create({
    data: {
      organisationId: org.id,
      role: "assessed",
      title: "A design",
      storageKey: `${TAG}/design`,
      byteSize: 10,
      sha256: randomUUID(),
      status: "ready",
    },
    select: { id: true },
  });
  const designs = await listDocuments(member.userId, org.id);
  ok(
    "a design contributes no clauses to the framework",
    designs.find((d) => d.id === design.id)?.clauses === 0,
  );
  const stillThree = await resolveFramework(org.id);
  ok(
    "and adding one does not version the framework",
    stillThree.id === after.id,
    [after.id, stillThree.id],
  );
  console.log("\nThe control itself, on the library page");
  // Render-level, because the server action is not the only gate that matters:
  // offering a member a control that would be refused reads as a fault, and
  // withholding it from an administrator makes the feature invisible.
  const signIn = async (email: string) => {
    const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (!res.ok) return null;
    return (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
  };
  const library = async (cookie: string) => {
    const res = await fetch(`${BASE}/dashboard/documents`, {
      headers: { cookie },
      redirect: "manual",
    });
    return res.ok ? await res.text() : "";
  };

  const asMember = await signIn(`${TAG}@test.invalid`);
  if (!asMember) {
    ok(`signed in against ${BASE}`, false, "is the dev server up on this port?");
  } else {
    const memberHtml = await library(asMember);
    ok("a member can read the library", memberHtml.includes("Reference Library"));
    ok(
      "and is not offered a way to remove a standard",
      !memberHtml.includes("from the standards"),
    );
    ok(
      "but is told who can",
      memberHtml.includes("Only an administrator can add standards"),
    );

    const boss = await provisionAccount({
      email: `${TAG}-boss@test.invalid`,
      name: "Boss",
      company: org.name,
      password: PASSWORD,
    });
    await prisma.membership.create({
      data: { userId: boss.userId, organisationId: org.id, role: OWNER },
    });
    const asOwner = await signIn(`${TAG}-boss@test.invalid`);
    const ownerHtml = asOwner ? await library(asOwner) : "";
    ok("an administrator sees the library", ownerHtml.includes("Reference Library"));
    ok(
      "with a remove control on the standard that is left",
      ownerHtml.includes("Remove Data Standards from the standards"),
      ownerHtml.length,
    );
    ok(
      "and the clause count beside it, which is what removing it costs",
      ownerHtml.includes("3 clauses"),
    );
    ok(
      "the design in the library has no remove control",
      !ownerHtml.includes("Remove A design from the standards"),
    );
  }
} finally {
  await prisma.organisation.deleteMany({ where: { slug: TAG } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: `${TAG}@test.invalid` } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
