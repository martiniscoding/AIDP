/**
 * Prove the activity board reports what actually happened.
 *
 * The aggregation reaches across three tables and one raw join, which is where
 * a per-person number quietly stops adding up. Everything here is cross-checked
 * against an independent count rather than against itself.
 *
 * Read-only. Run with:
 *   npx tsx --env-file=.env.local scripts/verify-activity.mts
 */
import { prisma } from "../src/lib/prisma";
import { organisationActivity } from "../src/lib/access/activity";

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

const organisations = await prisma.organisation.findMany({
  select: { id: true, name: true },
  orderBy: { createdAt: "asc" },
});

if (organisations.length === 0) {
  console.log("No organisations in this database — nothing to verify.");
  process.exit(0);
}

for (const org of organisations) {
  console.log(`\n${org.name}`);
  const activity = await organisationActivity(org.id);

  // 1. Totals against independent counts, scoped the same way.
  const [references, submissions, runs, decisions] = await Promise.all([
    prisma.document.count({ where: { organisationId: org.id, role: { not: "assessed" } } }),
    prisma.document.count({ where: { organisationId: org.id, role: "assessed" } }),
    prisma.assessmentRun.count({ where: { organisationId: org.id } }),
    prisma.decision.count({ where: { organisationId: org.id } }),
  ]);

  ok("standards total matches", activity.totals.references === references,
     `board ${activity.totals.references} vs ${references}`);
  ok("submissions total matches", activity.totals.submissions === submissions,
     `board ${activity.totals.submissions} vs ${submissions}`);
  ok("decisions total matches", activity.totals.decisions === decisions,
     `board ${activity.totals.decisions} vs ${decisions}`);

  // Runs reach through the document, so a run whose document was deleted is
  // legitimately unreachable. It may undercount; it must never overcount.
  ok("assessments never overcount", activity.totals.runs <= runs,
     `board ${activity.totals.runs} vs ${runs}`);

  // 2. The per-person rows must sum to the totals — that is the whole claim
  //    the table makes, and a dropped null attribution breaks it silently.
  const summed = activity.people.reduce(
    (acc, person) => ({
      references: acc.references + person.references,
      submissions: acc.submissions + person.submissions,
      runs: acc.runs + person.runs,
      decisions: acc.decisions + person.decisions,
    }),
    { references: 0, submissions: 0, runs: 0, decisions: 0 },
  );
  ok("per-person rows sum to the totals",
     summed.references === activity.totals.references &&
     summed.submissions === activity.totals.submissions &&
     summed.runs === activity.totals.runs &&
     summed.decisions === activity.totals.decisions,
     JSON.stringify(summed));

  // 3. Spend must agree with the People page, which reads the same table.
  const spend = await prisma.tokenUsage.aggregate({
    where: { organisationId: org.id },
    _sum: { totalTokens: true },
  });
  const boardSpend = activity.people.reduce((sum, p) => sum + p.totalTokens, 0);
  ok("spend agrees with token_usage", boardSpend === (spend._sum.totalTokens ?? 0),
     `board ${boardSpend} vs ${spend._sum.totalTokens ?? 0}`);

  // 4. Tenant boundary: nothing in the feed may belong to another customer.
  const foreign = await Promise.all(
    activity.events.map(async (event) => {
      const [kind, id] = event.id.split(":");
      if (kind === "doc")
        return prisma.document.count({ where: { id, organisationId: { not: org.id } } });
      if (kind === "run")
        return prisma.assessmentRun.count({ where: { id, organisationId: { not: org.id } } });
      return prisma.decision.count({ where: { id, organisationId: { not: org.id } } });
    }),
  );
  ok("no event belongs to another organisation", foreign.every((n) => n === 0));

  // 5. The feed is a feed: newest first, and bounded.
  const times = activity.events.map((event) => event.at.getTime());
  ok("feed is newest first", times.every((t, i) => i === 0 || times[i - 1]! >= t));
  ok("feed is bounded", activity.events.length <= 60, String(activity.events.length));

  // 6. Every event names somebody, even when nobody can be named.
  ok("every event has a person label", activity.events.every((e) => e.personName.length > 0));

  console.log(
    `  … ${activity.people.length} people, ${activity.events.length} events, ` +
      `unattributed=${activity.hasUnattributed}`,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
