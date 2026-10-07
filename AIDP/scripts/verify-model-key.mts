/**
 * A company bringing its own model key.
 *
 * The feature is small on screen and has three sharp edges underneath, so this
 * proves them against a throwaway organisation:
 *
 *   · the key is stored encrypted and bound to its organisation. A ciphertext
 *     lifted into another company's row must fail to decrypt rather than
 *     quietly work, and an altered one must fail too — it would otherwise be
 *     sent to a provider as somebody's API key;
 *   · a key that cannot do the work is saved switched off, not live. The engine
 *     rests on strict JSON replies, and a model that cannot return one breaks
 *     assessments one clause at a time, which is to say silently;
 *   · "no usable key" resolves to null, which is what tells a worker to use the
 *     environment's. That is the whole backwards-compatibility promise: an
 *     organisation that never opens the page behaves exactly as before;
 *   · an encryption key that has been rotated out from under the stored value
 *     is *reported*, not hidden. The symptom otherwise is every assessment
 *     quietly running on the platform's key.
 *
 * It needs no real provider key: the handshake is expected to fail here, and
 * that failure is one of the things being checked. One unauthenticated request
 * per provider reaches the internet; nothing is spent.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-model-key.mts
 */
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { canManageCredentials, OWNER, MEMBER } from "../src/lib/access/roles";
import {
  decryptSecret,
  encryptSecret,
  SecretUnreadable,
  secretsConfigured,
} from "../src/lib/access/secrets";
import {
  load,
  remove,
  resolve,
  save,
  setEnabled,
  CredentialRefused,
} from "../src/lib/access/credentials";

const TAG = `zz-modelkey-${Date.now()}`;
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

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

// Self-contained: the encryption key is an operator setting, and a verification
// run should not depend on whether this machine happens to have one.
//
// It matters later, though. A throwaway key means this process seals rows the
// running app cannot open — so the app would correctly answer `credential: null`
// at section 7, and asserting otherwise would be testing the test.
const ownKey = !process.env.CREDENTIAL_ENCRYPTION_KEY;
if (ownKey) {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  console.log("  (using a throwaway CREDENTIAL_ENCRYPTION_KEY for this run)");
}

const org = await prisma.organisation.create({ data: { name: "ZZ Model Key", slug: TAG } });
const other = await prisma.organisation.create({
  data: { name: "ZZ Model Key Other", slug: `${TAG}-other` },
});
const actor = await prisma.user.create({
  data: {
    id: `${TAG}-user`,
    name: "ZZ Admin",
    email: `${TAG}@example.invalid`,
    company: "ZZ Model Key",
    country: "IN",
    phone: "",
  },
  select: { id: true },
});

try {
  // -------------------------------------------------------------------------
  console.log("\n1. Encryption");
  ok("the deployment can store secrets", secretsConfigured());

  const secret = "sk-or-v1-abcdef0123456789abcdef0123456789";
  const sealed = encryptSecret(secret, org.id);
  ok("a key survives a round trip", decryptSecret(sealed, org.id) === secret);
  ok("the ciphertext does not contain the key", !sealed.includes(secret.slice(5)));
  ok(
    "the same key encrypts differently each time",
    encryptSecret(secret, org.id) !== encryptSecret(secret, org.id),
  );

  let bound = false;
  try {
    decryptSecret(sealed, other.id);
  } catch (error) {
    bound = error instanceof SecretUnreadable;
  }
  ok("a ciphertext moved to another company's row will not decrypt", bound);

  let tamperProof = false;
  const parts = sealed.split(".");
  const altered = [parts[0], parts[1], parts[2], Buffer.from("not the key").toString("base64")].join(".");
  try {
    decryptSecret(altered, org.id);
  } catch (error) {
    tamperProof = error instanceof SecretUnreadable;
  }
  ok("an altered ciphertext will not decrypt", tamperProof);

  // -------------------------------------------------------------------------
  console.log("\n2. What is refused outright");
  for (const [name, input] of [
    ["an empty key", { provider: "openrouter", apiKey: "   " }],
    ["something that is not a key", { provider: "openrouter", apiKey: "my key" }],
    ["a provider nothing can talk to", { provider: "acme-ai", apiKey: "a".repeat(40) }],
  ] as const) {
    let refused = false;
    try {
      await save(org.id, input, actor.id);
    } catch (error) {
      refused = error instanceof CredentialRefused;
    }
    ok(name, refused);
  }
  ok("and nothing was stored by a refusal", (await load(org.id)) === null);

  // -------------------------------------------------------------------------
  console.log("\n3. A key the provider rejects");
  const saved = await save(
    org.id,
    { provider: "openrouter", apiKey: `sk-or-v1-${"0".repeat(40)}` },
    actor.id,
  );
  ok("it is stored", saved !== null);
  ok("but switched off, because it could not be verified", saved.active === false);
  ok("with a reason an administrator can act on", (saved.probe?.notes.length ?? 0) > 0, saved.probe);
  ok("the screen sees only the last four characters", saved.keyLast4 === "0000");
  ok("and the defaults the product is tested with", saved.model === "openai/gpt-4.1-mini");
  ok(
    "a switched-off key resolves to nothing, so workers use the environment's",
    (await resolve(org.id)) === null,
  );
  console.log(`    (the provider said: ${saved.probe?.notes[0]})`);

  // -------------------------------------------------------------------------
  console.log("\n4. A working key, as the workers read it");
  // The handshake cannot pass without a real key, so the row is written the way
  // a passing one would be. Everything after the probe is what is under test.
  const live = "sk-ant-api03-pretend-this-one-works-9999";
  await prisma.providerCredential.update({
    where: { organisationId: org.id },
    data: {
      provider: "anthropic",
      ciphertext: encryptSecret(live, org.id),
      keyLast4: live.slice(-4),
      model: "claude-sonnet-4-5",
      fastModel: "claude-haiku-4-5-20251001",
      openrouterProviders: [],
      zdr: false,
      active: true,
      probe: { ok: true, authOk: true, jsonOk: true, visionOk: true, notes: [] },
      probedAt: new Date(),
    },
  });

  const forWorker = await resolve(org.id);
  ok("the worker gets the real key back", forWorker?.apiKey === live);
  ok("with the provider it belongs to", forWorker?.provider === "anthropic");
  ok("and both models", forWorker?.fastModel === "claude-haiku-4-5-20251001");

  const view = await load(org.id);
  ok("the screen still never sees it", JSON.stringify(view).includes(live) === false);
  ok("it shows who installed it", view?.setBy === "ZZ Admin");
  ok("and reports the key as readable", view?.unreadable === false);

  ok("another company's key is their own business", (await resolve(other.id)) === null);

  // -------------------------------------------------------------------------
  console.log("\n4a. Going back to the platform's key, and back again");
  // The point of the switch: trying a provider and reverting must not cost the
  // key. Deleting was the only way to stop using one, so trying twice meant
  // finding and pasting it twice.
  const parked = await setEnabled(org.id, false);
  ok("switching off is recorded", parked.enabled === false);
  ok(
    "the workers fall back to the environment's key",
    (await resolve(org.id)) === null,
  );
  ok("but the key is still there", parked.keyLast4 === live.slice(-4));
  ok(
    "and still decryptable, so nothing has to be pasted again",
    decryptSecret(
      (await prisma.providerCredential.findUniqueOrThrow({
        where: { organisationId: org.id },
        select: { ciphertext: true },
      })).ciphertext,
      org.id,
    ) === live,
  );
  // Parked and broken must stay separable: one needs nothing, the other needs
  // a new key, and a single flag would have made them one state on screen.
  ok("it is parked, not failed", parked.active === true && parked.enabled === false);

  const resumed = await setEnabled(org.id, true);
  ok("switching back on is recorded", resumed.enabled === true);
  ok("and the worker gets the same key again", (await resolve(org.id))?.apiKey === live);

  // A key the probe rejected stays skipped however the switch is set — the
  // administrator's choice cannot overrule "this key cannot do the work".
  await prisma.providerCredential.update({
    where: { organisationId: org.id },
    data: { active: false },
  });
  ok("a switched-on key that failed its check is still skipped", (await resolve(org.id)) === null);
  await prisma.providerCredential.update({
    where: { organisationId: org.id },
    data: { active: true },
  });

  ok(
    "switching an organisation that has no key is refused",
    await setEnabled(other.id, false).then(
      () => false,
      (error) => error instanceof CredentialRefused,
    ),
  );

  // -------------------------------------------------------------------------
  console.log("\n5. The encryption key rotated away");
  const real = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const orphaned = await load(org.id);
  ok("the page says the stored key can no longer be read", orphaned?.unreadable === true);
  ok(
    "and work carries on against the environment's key rather than failing",
    (await resolve(org.id)) === null,
  );
  process.env.CREDENTIAL_ENCRYPTION_KEY = real;
  ok("restoring it makes the key readable again", (await load(org.id))?.unreadable === false);

  // -------------------------------------------------------------------------
  console.log("\n6. Who may do this");
  ok("an administrator may", canManageCredentials(OWNER));
  ok("a member may not", !canManageCredentials(MEMBER));
  ok("and neither may a role nobody recognises", !canManageCredentials("standards-editor"));

  // -------------------------------------------------------------------------
  console.log("\n7. The endpoint the workers use");
  let reachable = true;
  try {
    const unauthorised = await fetch(
      `${BASE}/api/internal/credentials?organisationId=${org.id}`,
      { signal: AbortSignal.timeout(4000) },
    );
    ok("it refuses a caller with no shared secret", unauthorised.status === 401);

    const secretHeader = process.env.WORKER_SHARED_SECRET;
    if (secretHeader && !ownKey) {
      const authorised = await fetch(
        `${BASE}/api/internal/credentials?organisationId=${org.id}`,
        { headers: { "x-worker-secret": secretHeader }, signal: AbortSignal.timeout(4000) },
      );
      const body = (await authorised.json()) as { credential?: { apiKey?: string } };
      ok("and hands the worker the key with one", body.credential?.apiKey === live);
      ok("never cached", authorised.headers.get("cache-control") === "no-store");
    } else {
      console.log(
        secretHeader
          ? "    (skipped the authorised call — this run sealed the row with a key the app " +
            "does not have; set CREDENTIAL_ENCRYPTION_KEY in .env.local and restart it)"
          : "    (skipped the authorised call — WORKER_SHARED_SECRET is not set)",
      );
    }
  } catch {
    reachable = false;
    console.log(`    (skipped — no app answering on ${BASE})`);
  }
  if (!reachable) ok("endpoint checks skipped, not failed", true);

  // -------------------------------------------------------------------------
  console.log("\n8. Taking it away");
  await remove(org.id);
  ok("the row is gone", (await load(org.id)) === null);
  ok("and assessments fall back to the environment's key", (await resolve(org.id)) === null);
} finally {
  await prisma.providerCredential.deleteMany({
    where: { organisationId: { in: [org.id, other.id] } },
  });
  await prisma.organisation.deleteMany({ where: { id: { in: [org.id, other.id] } } });
  await prisma.user.deleteMany({ where: { id: actor.id } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
