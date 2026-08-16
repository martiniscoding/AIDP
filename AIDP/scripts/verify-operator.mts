/**
 * Prove the platform operator account does what it should — and, more
 * importantly, cannot do what it should not.
 *
 * Read-only. Run with:
 *   npx tsx --env-file=.env.local scripts/verify-operator.mts
 */
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";
import { admit } from "../src/lib/access/gate";
import { listOrganisations, organisationDetail } from "../src/lib/access/platform";
import { requireEnv } from "./require-env.mts";

const OPERATOR = process.env.OPERATOR_EMAIL ?? "superadmin@orivinex.com";
const PASSWORD = requireEnv("OPERATOR_PASSWORD", "The platform operator's password.");

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

const operator = await prisma.user.findUniqueOrThrow({ where: { email: OPERATOR } });

console.log("\n1. Sign-in");
for (const [password, expected] of [
  [PASSWORD, true],
  ["definitely-not-the-password", false],
] as const) {
  let status = 0;
  try {
    const res = await auth.api.signInEmail({
      body: { email: OPERATOR, password },
      asResponse: true,
    });
    status = res.status;
  } catch {
    status = 401;
  }
  ok(`${expected ? "correct password accepted" : "wrong password rejected"}`, (status === 200) === expected, `status ${status}`);
}

console.log("\n2. Holds operator rights, belongs to no company");
ok("isPlatformAdmin", operator.isPlatformAdmin);
ok("no membership", (await prisma.membership.count({ where: { userId: operator.id } })) === 0);
ok("on nobody's roster", (await prisma.rosterEntry.count({ where: { email: OPERATOR } })) === 0);

console.log("\n3. Visiting a dashboard does NOT found a company for them");
const organisationsBefore = await prisma.organisation.count();
const outcome = await admit(operator);
ok("refused a workspace", "reason" in outcome && outcome.reason === "no-organisation", JSON.stringify(outcome));
ok("no organisation created", (await prisma.organisation.count()) === organisationsBefore);

console.log("\n4. Can see every company's people and spend");
const organisations = await listOrganisations();
ok("sees all companies", organisations.length === organisationsBefore, `${organisations.length}`);
const satyam = organisations.find((organisation) => organisation.slug === "satyamindustry");
ok("satyamindustry listed", satyam !== undefined);
ok("its administrator is named", satyam?.owners.some((owner) => owner.email === "orvinex@gmail.com") ?? false);
ok("its people are counted", (satyam?.memberCount ?? 0) === 2, String(satyam?.memberCount));

const detail = await organisationDetail(satyam!.id);
ok("both people listed", detail?.people.length === 2, String(detail?.people.length));
ok(
  "the employee appears",
  detail?.people.some((person) => person.email === "sk4251867@gmail.com") ?? false,
);

console.log("\n5. Cannot see any document");
// The guarantee is structural: nothing the console returns carries document
// content. Assert on the shape rather than trusting the queries by eye.
const asJson = JSON.stringify(detail);
const titles = await prisma.document.findMany({ select: { title: true } });
ok("document count is exposed", typeof detail?.documentCount === "number");
for (const document of titles) {
  ok(
    `title "${document.title.slice(0, 34)}…" is absent`,
    !asJson.includes(document.title),
  );
}
ok("no storage keys leaked", !asJson.includes("storageKey"));
ok("no chunk text leaked", !/"text"\s*:/.test(asJson));

await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
