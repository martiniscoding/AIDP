/**
 * Opening a section on the parsed page.
 *
 * The outline said how many clauses, tables and figures each section produced.
 * How many is not what: "2 clauses" reads the same whether the parser found two
 * rules or cut one in half, which is why every hard bug in this product has
 * been an extraction question nobody could see. A row now opens into the text
 * behind the number.
 *
 * What this proves, against a throwaway organisation:
 *
 *   · a standard's section yields its clauses with the parts kept apart —
 *     statement, rationale, requirements, guidance — and the source lines each
 *     part was built from, which is what `Clause.sourceRefs` records;
 *   · a design's section yields its lines, because a design has no clauses and
 *     the lines *are* what was extracted;
 *   · a table comes back as a table, keeping its blank cells: Tier 4's RPO is
 *     blank on purpose and must not inherit Tier 3's;
 *   · a section the parser left empty says so rather than looking broken;
 *   · another customer's section is not readable, and answers as if it does not
 *     exist rather than confirming that it does.
 *
 * Needs the dev server. Run with:
 *   npx tsx --env-file=.env.local scripts/verify-parsed-sections.mts
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import { OWNER } from "../src/lib/access/roles";
import { sectionContent } from "../src/lib/ingest/documents";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PASSWORD = "a-throwaway-password";
const TAG = `zz-parsed-${Date.now()}`;

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

async function workspace(name: string) {
  const slug = `${TAG}-${name}`;
  const org = await prisma.organisation.create({ data: { name: `ZZ ${name}`, slug } });
  const email = `${slug}@test.invalid`;
  const account = await provisionAccount({
    email, name, company: org.name, password: PASSWORD,
  });
  await prisma.membership.create({
    data: { userId: account.userId, organisationId: org.id, role: OWNER },
  });
  await prisma.rosterEntry.create({
    data: { organisationId: org.id, email, status: "active", role: OWNER, userId: account.userId },
  });
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status} — is ${BASE} up?`);
  const cookie = (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { org, userId: account.userId, cookie };
}

async function document(organisationId: string, role: string, title: string) {
  return prisma.document.create({
    data: {
      organisationId,
      role,
      title,
      storageKey: `${TAG}/${title}`,
      byteSize: 10,
      sha256: randomUUID(),
      status: "ready",
    },
    select: { id: true },
  });
}

async function section(documentId: string, ordinal: number, title: string, isEmpty = false) {
  return prisma.documentSection.create({
    data: {
      documentId,
      ordinal,
      numberText: `${ordinal}.1`,
      title,
      headingPath: title,
      pageStart: ordinal,
      pageEnd: ordinal,
      isEmpty,
    },
    select: { id: true, ordinal: true },
  });
}

async function lines(documentId: string, sectionOrdinal: number, rows: [string, string, string][]) {
  for (const [index, [ref, kind, text]] of rows.entries()) {
    await prisma.sourceLine.create({
      data: {
        documentId,
        ordinal: sectionOrdinal * 100 + index,
        ref,
        kind,
        page: sectionOrdinal,
        text,
        sectionOrdinal,
      },
    });
  }
}

async function get(cookie: string, documentId: string, sectionId: string) {
  const res = await fetch(`${BASE}/api/documents/${documentId}/sections/${sectionId}`, {
    headers: { cookie, accept: "application/json" },
    redirect: "manual",
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// Inside the try, so a sign-in that cannot reach the server does not leave two
// organisations behind for the next run to trip over.
let mine: Awaited<ReturnType<typeof workspace>> | null = null;
let theirs: Awaited<ReturnType<typeof workspace>> | null = null;

try {
  mine = await workspace("mine");
  theirs = await workspace("theirs");

  console.log("\nA standard's section: its clauses, with the lines they came from");
  const standard = await document(mine!.org.id, "reference", "Data Standards");
  const retention = await section(standard.id, 8, "Retention");
  await lines(standard.id, 8, [
    ["L1", "heading", "8.1 Retention"],
    ["L2", "text", "Records are kept for a stated period."],
    ["L3", "bullet", "Tier 1 data is kept for seven years."],
  ]);
  await prisma.clause.create({
    data: {
      sectionId: retention.id,
      ordinal: 1,
      title: "Retention",
      statement: "Records are kept for a stated period.",
      rationale: "An unbounded store cannot be disposed of.",
      requirements: ["Tier 1 data is kept for seven years.", "A disposal date is recorded."],
      guidance: ["Use the retention table in Appendix A."],
      origin: "model",
      pageStart: 8,
      sourceRefs: {
        statement: ["L2"],
        requirements: [{ refs: ["L3"], strength: "must" }],
      },
    },
  });
  await prisma.tableBlock.create({
    data: {
      sectionId: retention.id,
      ordinal: 1,
      caption: "Retention by tier",
      columns: ["Tier", "RPO", "Archive after"],
      // Tier 4's cells are blank in the source, on purpose.
      rows: [["Tier 3", "90 days", "1 year"], ["Tier 4", "", ""]],
      pageStart: 8,
      confidence: 0.6,
    },
  });

  const std = await get(mine!.cookie, standard.id, retention.id);
  ok("the section is readable", std.status === 200, std.status);
  ok("named as a standard", std.body.role === "reference", std.body.role);

  const clauses = std.body.clauses as Record<string, unknown>[];
  ok("its clause came back", clauses?.length === 1, clauses?.length);
  const clause = clauses?.[0] ?? {};
  ok("the statement is its own field", clause.statement === "Records are kept for a stated period.");
  ok("so is the rationale", String(clause.rationale).startsWith("An unbounded store"));
  ok("requirements are a list, not a blob", (clause.requirements as string[])?.length === 2,
     clause.requirements);
  ok("guidance too", (clause.guidance as string[])?.length === 1, clause.guidance);
  ok("and how it was found is said", clause.origin === "model", clause.origin);
  const refs = clause.sourceRefs as Record<string, unknown>;
  ok(
    "the statement says which line it was built from",
    JSON.stringify(refs?.statement) === JSON.stringify(["L2"]),
    refs?.statement,
  );
  ok(
    "and a requirement carries its own refs",
    JSON.stringify(refs?.requirements) === JSON.stringify([{ refs: ["L3"], strength: "must" }]),
    refs?.requirements,
  );
  ok(
    "that ref is findable among the lines",
    (std.body.lines as { ref: string }[])?.some((l) => l.ref === "L3"),
    (std.body.lines as { ref: string }[])?.map((l) => l.ref),
  );

  console.log("\nIts table, as a table");
  const tables = std.body.tables as Record<string, unknown>[];
  ok("the table came back", tables?.length === 1, tables?.length);
  const table = tables?.[0] ?? {};
  ok("with its columns", (table.columns as string[])?.length === 3, table.columns);
  ok("and its rows", (table.rows as unknown[])?.length === 2, table.rows);
  ok(
    "Tier 4's blank cells stay blank, not inherited",
    JSON.stringify((table.rows as string[][])?.[1]) === JSON.stringify(["Tier 4", "", ""]),
    (table.rows as string[][])?.[1],
  );
  ok("and the parser's own doubt is carried", table.confidence === 0.6, table.confidence);

  console.log("\nA design's section: the lines are what was extracted");
  const design = await document(mine!.org.id, "assessed", "LCL Proposal");
  const tools = await section(design.id, 16, "Proposed Tools");
  await lines(design.id, 16, [
    ["L1", "heading", "Proposed Tools & Technologies"],
    ["L2", "table_row", "Security | Harbor"],
    ["L3", "table_row", "Deployment | Spinnaker"],
  ]);
  const des = await get(mine!.cookie, design.id, tools.id);
  ok("readable", des.status === 200, des.status);
  ok("named as a design", des.body.role === "assessed", des.body.role);
  ok("its three lines came back", (des.body.lines as unknown[])?.length === 3,
     (des.body.lines as unknown[])?.length);
  ok("in reading order", JSON.stringify((des.body.lines as { ref: string }[]).map((l) => l.ref))
     === JSON.stringify(["L1", "L2", "L3"]));
  ok(
    "each line says what kind it is",
    (des.body.lines as { kind: string }[])[1]?.kind === "table_row",
    (des.body.lines as { kind: string }[]).map((l) => l.kind),
  );
  ok("and a design has no clauses to show", (des.body.clauses as unknown[])?.length === 0);

  console.log("\nLines belong to their own section only");
  const other = await section(design.id, 18, "Pipeline");
  await lines(design.id, 18, [["L9", "text", "On premises"]]);
  const pipeline = await get(mine!.cookie, design.id, other.id);
  ok(
    "a neighbouring section's lines are not mixed in",
    JSON.stringify((pipeline.body.lines as { ref: string }[]).map((l) => l.ref)) ===
      JSON.stringify(["L9"]),
    (pipeline.body.lines as { ref: string }[]).map((l) => l.ref),
  );

  console.log("\nA section the parser found nothing in");
  const blank = await section(design.id, 20, "Records Management", true);
  const empty = await get(mine!.cookie, design.id, blank.id);
  ok("still readable", empty.status === 200, empty.status);
  ok("with nothing in it", (empty.body.lines as unknown[])?.length === 0
     && (empty.body.clauses as unknown[])?.length === 0
     && (empty.body.tables as unknown[])?.length === 0, empty.body);
  ok(
    "and the section says it was empty in the source",
    (empty.body.section as Record<string, unknown>)?.isEmpty === true,
  );

  console.log("\nAnother customer's section");
  const foreign = await get(theirs!.cookie, design.id, tools.id);
  ok("is not readable", foreign.status === 404, foreign.status);
  ok(
    "and answers as if it does not exist, not as forbidden",
    foreign.status !== 403,
    foreign.status,
  );
  ok(
    "the library call refuses it too, not only the route",
    await sectionContent(theirs!.userId, design.id, tools.id).then(
      () => false,
      () => true,
    ),
  );

  console.log("\nA section id that belongs to another document");
  const crossed = await get(mine!.cookie, standard.id, tools.id);
  ok("is not served under the wrong document", crossed.status === 404, crossed.status);

  const unsigned = await fetch(`${BASE}/api/documents/${design.id}/sections/${tools.id}`, {
    redirect: "manual",
  });
  ok("and nobody signed in gets nothing", unsigned.status === 401, unsigned.status);

  console.log("\nThe parsed page draws the outline as rows that open");
  const page = await fetch(`${BASE}/dashboard/documents/${design.id}/parsed`, {
    headers: { cookie: mine!.cookie },
    redirect: "manual",
  });
  const html = page.ok ? await page.text() : "";
  ok("the page renders", page.status === 200, page.status);
  ok("the outline is still there", html.includes("Proposed Tools"), page.status);
  ok(
    "its rows are collapsed controls, not plain links",
    html.includes('aria-expanded="false"'),
  );
  ok(
    "and the page says a row opens — otherwise only people who guess would find it",
    html.includes("Open a section to see exactly what was taken out of it"),
  );
  ok(
    "a section the parser left empty is still marked on the row",
    html.includes("empty in source"),
  );
} finally {
  await prisma.organisation.deleteMany({ where: { slug: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
