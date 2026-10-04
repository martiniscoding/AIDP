/**
 * The project answer key, scored against a real run.
 *
 * Workers/tests/test_project_answer_key.py proves the key is internally sound
 * and that every verdict in it survives the guards. It cannot say whether the
 * engine actually reaches those verdicts, because that needs the sample corpus
 * indexed and a model. This does: it uploads the five sample documents into a
 * throwaway organisation, puts both designs in one project, assesses the
 * project as a whole, and scores the result against the key's 21 rows.
 *
 * A throwaway organisation on purpose. The framework is built per organisation
 * from its own ready reference documents, so this one holds exactly the three
 * sample standards and nothing a demo workspace happens to contain. Everything
 * is removed at the end, whether it passed or not.
 *
 * Real model calls — parse, chunk, embed and 36 clauses — so this is not part of
 * the ordinary test sweep. Run it when the project-level judgement changes.
 *
 * Needs the dev server (for the upload endpoint) and the workers up.
 *
 *   BASE_URL=http://localhost:3002 npx tsx --env-file=.env.local \
 *     scripts/eval-project-answer-key.mts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import { OWNER } from "../src/lib/access/roles";
import type { Access } from "../src/lib/access/gate";
import { createProject, startProjectRun } from "../src/lib/ingest/projects";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PASSWORD = "a-throwaway-password";
const TAG = `zz-eval-${Date.now()}`;
const SAMPLES = path.resolve(process.cwd(), "..", "samples");

const STANDARDS = [
  "Solution_Architecture_Standards.pdf",
  "Data_Standards.pdf",
  "Security_Standards.pdf",
];
const DESIGNS = [
  "Customer_Portal_Modernisation_SAD.pdf",
  "Field_Telemetry_Ingestion_SAD.pdf",
];

/** The project rows of samples/ANSWER_KEY.md: clause -> expected verdict. */
async function projectKey(): Promise<Map<string, { expected: string; must: boolean }>> {
  const text = await readFile(path.join(SAMPLES, "ANSWER_KEY.md"), "utf8");
  const out = new Map<string, { expected: string; must: boolean }>();
  let inside = false;
  let must = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) inside = line.includes("as one project");
    if (line.startsWith("### ")) must = line.includes("Must get");
    if (!inside) continue;
    const m = line
      .trim()
      .match(/^\|\s*(Architecture|Data|Security)\s*§(\d+\.\d+)[^|]*\|[^|]*\|[^|]*\|\s*\*{0,2}(\w+)/);
    if (m) out.set(`${m[1]} ${m[2]}`, { expected: m[3], must });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const org = await prisma.organisation.create({
  data: { name: "ZZ Answer Key Eval", slug: TAG },
});

try {
  const account = await provisionAccount({
    email: `${TAG}@test.invalid`,
    name: "Eval",
    company: org.name,
    password: PASSWORD,
  });
  await prisma.membership.create({
    data: { userId: account.userId, organisationId: org.id, role: OWNER },
  });
  await prisma.rosterEntry.create({
    data: {
      organisationId: org.id,
      email: `${TAG}@test.invalid`,
      status: "active",
      role: OWNER,
      userId: account.userId,
    },
  });
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: `${TAG}@test.invalid` },
    select: { id: true, name: true, email: true, company: true, isPlatformAdmin: true },
  });
  const access: Access = {
    user,
    organisation: { id: org.id, name: org.name, slug: TAG, role: OWNER },
    role: OWNER,
    isOwner: true,
  };

  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: `${TAG}@test.invalid`, password: PASSWORD }),
  });
  if (!signIn.ok) throw new Error(`sign-in failed: ${signIn.status} — is ${BASE} up?`);
  const cookie = (signIn.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");

  const project = await createProject(access, { name: "Northwind submissions" });
  console.log(`  project "${project.name}" opened in a throwaway workspace`);

  async function upload(folder: string, name: string, role: string, projectId?: string) {
    const bytes = await readFile(path.join(SAMPLES, folder, name));
    const form = new FormData();
    form.set("file", new File([bytes], name, { type: "application/pdf" }));
    form.set("role", role);
    if (projectId) form.set("projectId", projectId);
    const res = await fetch(`${BASE}/api/documents/upload`, {
      method: "POST",
      headers: { cookie, origin: BASE },
      body: form,
    });
    const body = (await res.json()) as { id?: string; error?: string };
    if (!res.ok) throw new Error(`${name}: ${res.status} ${body.error ?? ""}`);
    console.log(`  uploaded ${role.padEnd(9)} ${name}`);
    return body.id!;
  }

  for (const name of STANDARDS) await upload("standards", name, "reference");
  for (const name of DESIGNS) await upload("designs", name, "assessed", project.id);

  console.log("\n  waiting for parse, chunk and embed…");
  for (let i = 0; i < 90; i += 1) {
    const docs = await prisma.document.findMany({
      where: { organisationId: org.id },
      select: { title: true, status: true, failureReason: true },
    });
    const done = docs.filter((d) => d.status === "ready").length;
    const failed = docs.filter((d) => d.status === "failed");
    if (failed.length) throw new Error(`ingest failed: ${failed.map((f) => f.title).join(", ")}`);
    if (docs.length === 5 && done === 5) break;
    if (i % 4 === 0) console.log(`    ${done}/5 ready`);
    await sleep(10_000);
  }

  const started = await startProjectRun(access, project.id);
  console.log(`\n  ${started.scope}`);
  let state = "queued";
  for (let i = 0; i < 120; i += 1) {
    const run = await prisma.assessmentRun.findUniqueOrThrow({
      where: { id: started.runId },
      select: { state: true, completedClauses: true, totalClauses: true, failureReason: true },
    });
    state = run.state;
    if (state === "complete" || state === "failed") {
      if (state === "failed") throw new Error(`run failed: ${run.failureReason}`);
      break;
    }
    if (i % 3 === 0) console.log(`    ${run.completedClauses}/${run.totalClauses} clauses`);
    await sleep(10_000);
  }

  const findings = await prisma.finding.findMany({
    where: { runId: started.runId },
    select: { clauseRef: true, clauseTitle: true, verdict: true, evidence: true },
  });
  const got = new Map<string, { verdict: string; designs: string[] }>();
  for (const f of findings) {
    const designs = [
      ...new Set(
        (Array.isArray(f.evidence) ? f.evidence : [])
          .map((e) => (e as { documentTitle?: string }).documentTitle ?? "")
          .filter(Boolean),
      ),
    ];
    // Findings carry the clause number; the key names it "Book §n.n".
    got.set(f.clauseRef.trim(), { verdict: f.verdict, designs });
  }

  const key = await projectKey();
  console.log(`\n  scoring ${key.size} key rows against ${findings.length} findings\n`);
  let right = 0;
  let wrong = 0;
  let missing = 0;
  let mustWrong = 0;
  for (const [clause, { expected, must }] of key) {
    const number = clause.split(" ")[1];
    const found = got.get(number) ?? got.get(clause);
    if (!found) {
      missing += 1;
      console.log(`  ?    ${clause.padEnd(22)} expected ${expected} — no finding for this clause`);
      continue;
    }
    const hit = found.verdict === expected;
    if (hit) right += 1;
    else {
      wrong += 1;
      if (must) mustWrong += 1;
    }
    console.log(
      `  ${hit ? "ok  " : "MISS"} ${clause.padEnd(22)} expected ${expected.padEnd(12)} got ${found.verdict.padEnd(12)} ${found.designs.length > 1 ? "(both designs)" : ""}`,
    );
  }
  const scored = right + wrong;
  console.log(
    `\n  ${right}/${scored} correct` +
      (missing ? `, ${missing} clause(s) not in the run` : "") +
      `  —  must-get rows wrong: ${mustWrong}`,
  );
} finally {
  await prisma.organisation.deleteMany({ where: { slug: TAG } });
  await prisma.user.deleteMany({ where: { email: `${TAG}@test.invalid` } });
  await prisma.$disconnect();
  console.log("\n  throwaway workspace removed");
}
