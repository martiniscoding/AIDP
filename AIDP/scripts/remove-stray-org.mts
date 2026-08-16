/**
 * Remove an organisation that was created by mistake for a platform operator.
 *
 * A stale build served an older `admit`, and the operator's first visit to a
 * dashboard founded a workspace named after them — the exact outcome the guard
 * exists to prevent. This deletes it, and refuses to if it turns out to hold
 * anything, because an organisation with real work in it is not a mistake and
 * deleting one cascades to every document, chunk, run and finding under it.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/remove-stray-org.mts
 */
import { prisma } from "../src/lib/prisma";

const KEEP = "satyamindustry";

const organisations = await prisma.organisation.findMany({
  select: {
    id: true,
    name: true,
    slug: true,
    createdAt: true,
    _count: {
      select: { documents: true, chunks: true, runs: true, decisions: true, roster: true },
    },
    memberships: {
      select: { role: true, user: { select: { email: true, isPlatformAdmin: true } } },
    },
  },
});

let removed = 0;

for (const organisation of organisations) {
  if (organisation.slug === KEEP) {
    console.log(`keep  ${organisation.name} — the real customer workspace`);
    continue;
  }

  const counts = organisation._count;
  const holdsWork =
    counts.documents > 0 || counts.chunks > 0 || counts.runs > 0 || counts.decisions > 0;

  // Only ever remove a workspace whose *only* member is a platform operator.
  // Anything else is somebody's actual tenant.
  const onlyOperators =
    organisation.memberships.length > 0 &&
    organisation.memberships.every((membership) => membership.user.isPlatformAdmin);

  if (holdsWork) {
    console.log(
      `KEEP  ${organisation.name} — holds work ` +
        `(${counts.documents} documents, ${counts.runs} runs). Not touching it.`,
    );
    continue;
  }
  if (!onlyOperators) {
    console.log(
      `KEEP  ${organisation.name} — has non-operator members ` +
        `(${organisation.memberships.map((m) => m.user.email).join(", ")}). Not touching it.`,
    );
    continue;
  }

  console.log(
    `DROP  ${organisation.name} — empty, and its only member is a platform operator ` +
      `(${organisation.memberships.map((m) => m.user.email).join(", ")})`,
  );
  await prisma.organisation.delete({ where: { id: organisation.id } });
  removed += 1;
}

console.log(`\nRemoved ${removed}.`);
console.log("Organisations now:");
for (const organisation of await prisma.organisation.findMany({
  select: { name: true, slug: true, _count: { select: { memberships: true, documents: true } } },
})) {
  console.log(
    `  ${organisation.name} (${organisation.slug}) — ` +
      `${organisation._count.memberships} people, ${organisation._count.documents} documents`,
  );
}

const strays = await prisma.membership.findMany({
  where: { user: { isPlatformAdmin: true } },
  select: { user: { select: { email: true } }, organisation: { select: { name: true } } },
});
console.log(
  strays.length === 0
    ? "\nNo platform operator holds a membership anywhere. Correct."
    : `\nPlatform operators still holding memberships: ${strays
        .map((s) => `${s.user.email} in ${s.organisation.name}`)
        .join(", ")}`,
);

await prisma.$disconnect();
