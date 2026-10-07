/**
 * Several standards in one upload.
 *
 * A standards library arrives as a folder, so the door takes a batch. The old
 * one read `form.get("file")` and silently kept the first: attach eight and
 * seven vanished with a 201 saying everything was fine. That is the failure
 * this guards against, along with the ones a batch introduces — one unreadable
 * file must not cost the other seven, and a caller that checks `res.ok` alone
 * must not read "three refused" as success.
 *
 * Against the real endpoint with a real session, in a throwaway organisation
 * that is removed at the end. Storage is whatever the app is configured with:
 * `record` stores the bytes itself on this path, so no handshake is involved.
 *
 *   npx tsx --env-file=.env.local scripts/verify-upload-batch.mts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import { MEMBER, OWNER } from "../src/lib/access/roles";
import { MAX_FILES } from "../src/lib/ingest/intake";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PASSWORD = "a-throwaway-password";
const TAG = `zz-batch-${Date.now()}`;
const SAMPLES = path.resolve(process.cwd(), "..", "samples", "standards");

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

type Outcome = { name: string; ok: boolean; error?: string; duplicate?: boolean };
type Batch = {
  files?: Outcome[];
  added?: number;
  duplicates?: number;
  refused?: number;
  error?: string;
  /** The single-file shape, kept for every caller written before the batch. */
  duplicate?: boolean;
};

const org = await prisma.organisation.create({ data: { name: "ZZ Upload Batch", slug: TAG } });

async function person(suffix: string, role: string) {
  const email = `${TAG}-${suffix}@test.invalid`;
  const account = await provisionAccount({
    email, name: suffix, company: org.name, password: PASSWORD,
  });
  await prisma.membership.create({
    data: { userId: account.userId, organisationId: org.id, role },
  });
  await prisma.rosterEntry.create({
    data: { organisationId: org.id, email, status: "active", role, userId: account.userId },
  });
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status} — is ${BASE} up?`);
  return (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
}

async function post(cookie: string, attach: [string, Uint8Array][], role = "reference") {
  const form = new FormData();
  form.set("role", role);
  for (const [name, bytes] of attach) {
    form.append(
      "file",
      new File([new Uint8Array(bytes)], name, { type: "application/pdf" }),
      name,
    );
  }
  const res = await fetch(`${BASE}/api/documents/upload`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Batch };
}

try {
  const boss = await person("boss", OWNER);
  const pdf = async (name: string) =>
    [name, new Uint8Array(await readFile(path.join(SAMPLES, name)))] as [string, Uint8Array];

  const three = [
    await pdf("Data_Standards.pdf"),
    await pdf("Security_Standards.pdf"),
    await pdf("Solution_Architecture_Standards.pdf"),
  ];

  console.log("\nThree standards in one request");
  const batch = await post(boss, three);
  // Counted and taken off the queue in one transaction, before anything else:
  // a live parse worker claims these within seconds otherwise and parses the
  // fixtures for real — paid vision calls on three sample PDFs, and a worker
  // left holding documents the cleanup removes underneath it.
  const queued = await prisma.$transaction(async (tx) => {
    const n = await tx.job.count({ where: { organisationId: org.id, stage: "parse" } });
    await tx.job.deleteMany({ where: { organisationId: org.id, stage: "parse" } });
    return n;
  });
  ok("accepted as created", batch.status === 201, batch.status);
  ok("all three are reported on", batch.body.files?.length === 3, batch.body.files);
  ok("all three were added", batch.body.added === 3, batch.body);
  ok("none refused", batch.body.refused === 0, batch.body.refused);
  ok(
    "each file is named in its own result",
    three.every(([name]) => batch.body.files?.some((f) => f.name === name)),
    batch.body.files?.map((f) => f.name),
  );

  console.log("\nAll three really landed — the old door kept only the first");
  const stored = await prisma.document.findMany({
    where: { organisationId: org.id },
    select: { title: true, role: true },
  });
  ok("three documents on record", stored.length === 3, stored.map((d) => d.title));
  ok("all filed as standards", stored.every((d) => d.role === "reference"));
  ok("each one has a parse job", queued === 3, queued);

  console.log("\nThe same batch again is three duplicates, not three copies");
  const again = await post(boss, three);
  ok("still answered", again.status === 201, again.status);
  ok("all three recognised", again.body.duplicates === 3, again.body);
  ok("nothing added", again.body.added === 0, again.body.added);
  ok(
    "and no second copy stored",
    (await prisma.document.count({ where: { organisationId: org.id } })) === 3,
  );

  console.log("\nOne bad file does not cost the good ones");
  const mixed = await post(boss, [
    await pdf("Data_Standards.pdf"),
    ["notes.txt", new TextEncoder().encode("just some text, not a document")],
    ["empty.pdf", new Uint8Array()],
  ]);
  ok("answered 207, not 201 — the batch was not all one answer", mixed.status === 207, mixed.status);
  ok("two refused", mixed.body.refused === 2, mixed.body);
  ok("the good one still recognised", mixed.body.duplicates === 1, mixed.body.duplicates);
  const bad = mixed.body.files?.filter((f) => !f.ok) ?? [];
  ok("each refusal names its file", bad.map((f) => f.name).sort().join() === "empty.pdf,notes.txt",
     bad.map((f) => f.name));
  ok("and says why", bad.every((f) => (f.error ?? "").length > 0), bad.map((f) => f.error));
  ok(
    "an empty file is called empty",
    bad.some((f) => f.name === "empty.pdf" && /empty/i.test(f.error ?? "")),
    bad,
  );

  console.log("\nOne file answers as it always did");
  const single = await post(boss, [await pdf("Data_Standards.pdf")]);
  ok("no batch wrapper", single.body.files === undefined, single.body);
  ok("the old shape, recognised as a duplicate", single.body.duplicate === true, single.body);

  console.log("\nLimits and refusals");
  const none = await post(boss, []);
  ok("nothing attached is still 400", none.status === 400, none.status);
  ok("with the sentence it always gave", none.body.error === "No file was attached.", none.body.error);

  const flood: [string, Uint8Array][] = Array.from({ length: MAX_FILES + 1 }, (_, i) => [
    `copy-${i}.pdf`,
    new TextEncoder().encode(`%PDF-1.4 ${i}`),
  ]);
  const toomany = await post(boss, flood);
  ok("too many files is refused", toomany.status === 413, toomany.status);
  ok(
    "and says how many may be sent",
    (toomany.body.error ?? "").includes(String(MAX_FILES)),
    toomany.body.error,
  );
  ok(
    "nothing from a refused batch was stored",
    (await prisma.document.count({ where: { organisationId: org.id } })) === 3,
  );

  console.log("\nThe standards guard still comes first");
  const staff = await person("staff", MEMBER);
  const refused = await post(staff, three);
  ok("a member is refused the batch", refused.status === 403, refused.status);
  ok("told who may", /administrator/i.test(refused.body.error ?? ""), refused.body.error);
  ok(
    "and none of their files was read",
    (await prisma.document.count({ where: { organisationId: org.id } })) === 3,
  );
} finally {
  // Before the organisation goes, so nothing is left for a worker to claim in
  // the moment between the two deletes.
  await prisma.job.deleteMany({ where: { organisation: { slug: TAG } } });
  await prisma.organisation.deleteMany({ where: { slug: TAG } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
