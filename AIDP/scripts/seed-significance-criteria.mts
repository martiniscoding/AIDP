/**
 * Seed an organisation's significance criteria with the brief's default nine.
 *
 * Idempotent, and deliberately *not* a reset: a category that already exists is
 * left exactly as it is. An administrator who has tuned their cost threshold
 * must not lose it because somebody re-ran the seed, which is the same reason
 * `syncMembership` updates rather than recreates.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/seed-significance-criteria.mts [organisationSlug]
 *
 * With no argument every organisation is seeded, which is what a deployment
 * adding this table to an existing database wants.
 */
import { prisma } from "../src/lib/prisma";
import { DEFAULT_CRITERIA } from "../src/lib/significance/criteria";

const slug = process.argv[2];

const organisations = await prisma.organisation.findMany({
  where: slug ? { slug } : {},
  select: { id: true, name: true, slug: true },
  orderBy: { createdAt: "asc" },
});

if (organisations.length === 0) {
  console.error(slug ? `No organisation with slug "${slug}".` : "No organisations to seed.");
  process.exit(1);
}

let created = 0;
let kept = 0;

for (const org of organisations) {
  const existing = new Set(
    (
      await prisma.significanceCriterion.findMany({
        where: { organisationId: org.id },
        select: { category: true },
      })
    ).map((c) => c.category),
  );

  for (const [index, seed] of DEFAULT_CRITERIA.entries()) {
    if (existing.has(seed.category)) {
      kept += 1;
      continue;
    }
    await prisma.significanceCriterion.create({
      data: {
        organisationId: org.id,
        category: seed.category,
        label: seed.label,
        description: seed.description,
        conditions: seed.conditions,
        sortOrder: index,
      },
    });
    created += 1;
  }

  console.log(`${org.name} (${org.slug}) — ${DEFAULT_CRITERIA.length} categories in place`);
}

console.log(`\n${created} created, ${kept} already present.`);

// The one number in the defaults that nobody chose. Said on the way out rather
// than buried in the table, because a threshold left at its placeholder is a
// check that runs and means nothing — and the brief's own assumptions require
// this to be configured before go-live.
const unconfigured = DEFAULT_CRITERIA.filter((c) => c.needsConfiguration);
if (unconfigured.length > 0) {
  console.log(
    `\n⚠  Configure before go-live: ${unconfigured
      .map((c) => c.label)
      .join(", ")} — the seeded threshold is a placeholder, not the customer's policy.`,
  );
}

await prisma.$disconnect();
