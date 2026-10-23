/**
 * The architecture-request tables: what they guarantee, checked against the
 * real database rather than assumed from the schema.
 *
 * Five properties, and each one is a decision made in the schema that a later
 * phase will lean on:
 *
 *  1. A reference is unique per customer, and two customers may hold the same
 *     one — the per-organisation counter must not leak how many another has
 *     filed.
 *  2. Two requests can share a title inside one project. This is the whole
 *     reason a request names its project instead of founding one: Project
 *     carries `@@unique([organisationId, name])` and would refuse the second.
 *  3. A request survives its document being removed from the library. The
 *     links to the engine's rows are relation-free on purpose.
 *  4. A significance result keeps the rule it was reached under, after an
 *     administrator has edited the criterion.
 *  5. Routing is a history, not a field: reassignment leaves the earlier row.
 *
 * Everything is created inside two throwaway organisations and removed at the
 * end, so this is safe to run against a database with real work in it.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-architecture-request.mts
 */
import { prisma } from "../src/lib/prisma";
import { DEFAULT_CRITERIA } from "../src/lib/significance/criteria";

const TAG = `zz-arq-${Date.now()}`;

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

const orgA = await prisma.organisation.create({
  data: { name: "ZZ Requests A", slug: `${TAG}-a` },
});
const orgB = await prisma.organisation.create({
  data: { name: "ZZ Requests B", slug: `${TAG}-b` },
});

try {
  // --- the seed -----------------------------------------------------------
  console.log("\nDefault criteria");

  for (const [index, seed] of DEFAULT_CRITERIA.entries()) {
    await prisma.significanceCriterion.create({
      data: {
        organisationId: orgA.id,
        category: seed.category,
        label: seed.label,
        description: seed.description,
        conditions: seed.conditions,
        sortOrder: index,
      },
    });
  }
  const seeded = await prisma.significanceCriterion.count({
    where: { organisationId: orgA.id },
  });
  ok("the brief's nine categories seed", seeded === 9, `got ${seeded}`);

  let duplicateCategory = false;
  try {
    await prisma.significanceCriterion.create({
      data: { organisationId: orgA.id, category: "licensing", label: "Again" },
    });
  } catch {
    duplicateCategory = true;
  }
  ok("one row per category per customer", duplicateCategory);

  // The same category in another customer is a different rule, with its own
  // threshold. This is the tenant wall, and it has to hold on config too.
  const bCriterion = await prisma.significanceCriterion.create({
    data: { organisationId: orgB.id, category: "licensing", label: "Licensing" },
  });
  ok("another customer holds the same category independently", Boolean(bCriterion.id));

  // --- requests -----------------------------------------------------------
  console.log("\nRequests");

  const project = await prisma.project.create({
    data: { organisationId: orgA.id, name: `${TAG} project` },
  });

  const first = await prisma.architectureRequest.create({
    data: {
      organisationId: orgA.id,
      reference: "AR-0001",
      projectId: project.id,
      title: "Customer Portal Upgrade",
      requestedByName: "A. Requestor",
      estimatedCost: "7500000.00",
      linesOfBusiness: ["Retail", "Wholesale"],
      technologies: ["PostgreSQL", "Kubernetes"],
      securityDomainChange: true,
    },
  });
  ok("a request is created in the draft state", first.state === "draft", first.state);
  ok("cost keeps its precision", first.estimatedCost?.toString() === "7500000", String(first.estimatedCost));
  ok("list fields round-trip", first.linesOfBusiness.length === 2);
  ok("it starts with no classification", first.significance === null);

  // (2) Two requests, one title, one project. Project's own unique constraint
  // would have refused this had the request founded a project from its title.
  const second = await prisma.architectureRequest.create({
    data: {
      organisationId: orgA.id,
      reference: "AR-0002",
      projectId: project.id,
      title: "Customer Portal Upgrade",
    },
  });
  ok("two requests may share a title in one project", second.id !== first.id);

  // (1) The reference is the identity, and it is per customer.
  let duplicateReference = false;
  try {
    await prisma.architectureRequest.create({
      data: {
        organisationId: orgA.id,
        reference: "AR-0001",
        projectId: project.id,
        title: "A third",
      },
    });
  } catch {
    duplicateReference = true;
  }
  ok("a reference cannot repeat inside one customer", duplicateReference);

  const projectB = await prisma.project.create({
    data: { organisationId: orgB.id, name: `${TAG} project B` },
  });
  const bRequest = await prisma.architectureRequest.create({
    data: {
      organisationId: orgB.id,
      reference: "AR-0001",
      projectId: projectB.id,
      title: "Another customer's first request",
    },
  });
  ok("two customers may both hold AR-0001", bRequest.reference === first.reference);

  // --- (3) the links to the engine are weak on purpose --------------------
  console.log("\nSurviving the engine");

  const document = await prisma.document.create({
    data: {
      organisationId: orgA.id,
      role: "assessed",
      title: `${TAG} rendered intake`,
      storageKey: `${TAG}/intake.docx`,
      byteSize: 1,
      sha256: `${TAG}-hash`,
      status: "ready",
    },
  });
  await prisma.architectureRequest.update({
    where: { id: first.id },
    data: { documentId: document.id, state: "checking" },
  });

  // Removing the document from the library must not take the submission with
  // it. A cascade here would erase the governance record.
  await prisma.document.delete({ where: { id: document.id } });
  const survivor = await prisma.architectureRequest.findUnique({ where: { id: first.id } });
  ok("the request outlives its document", survivor !== null);
  ok(
    "and still names the document it was assessed from",
    survivor?.documentId === document.id,
    String(survivor?.documentId),
  );

  // --- (4) results keep the rule they were reached under ------------------
  console.log("\nSignificance results");

  const costCriterion = await prisma.significanceCriterion.findFirstOrThrow({
    where: { organisationId: orgA.id, category: "cost_impact" },
  });

  await prisma.significanceResult.create({
    data: {
      requestId: first.id,
      criterionId: costCriterion.id,
      category: costCriterion.category,
      categoryLabel: costCriterion.label,
      conditionText: "Estimated cost is at least 5,000,000.",
      triggered: true,
      triggeredBy: [
        { field: "estimatedCost", operator: "at_least", value: 5000000, actual: 7500000 },
      ],
    },
  });
  await prisma.architectureRequest.update({
    where: { id: first.id },
    data: { significance: "significant", significanceAt: new Date() },
  });

  let duplicateResult = false;
  try {
    await prisma.significanceResult.create({
      data: {
        requestId: first.id,
        criterionId: costCriterion.id,
        category: "cost_impact",
        categoryLabel: "Cost Impact",
      },
    });
  } catch {
    duplicateResult = true;
  }
  ok("a criterion is recorded against a request once", duplicateResult);

  // The administrator raises the threshold afterwards. The classification that
  // was already reached has to keep stating the rule it was reached under.
  await prisma.significanceCriterion.update({
    where: { id: costCriterion.id },
    data: { label: "Cost Impact (revised)", conditions: [] },
  });
  const kept = await prisma.significanceResult.findFirstOrThrow({
    where: { requestId: first.id, criterionId: costCriterion.id },
  });
  ok("the result keeps the label it was judged under", kept.categoryLabel === "Cost Impact");
  ok(
    "and the condition that fired it",
    kept.conditionText.includes("5,000,000"),
    kept.conditionText,
  );
  ok("with its working, not just its conclusion", Array.isArray(kept.triggeredBy));

  // Deleting the criterion entirely must not erase the audit record.
  await prisma.significanceCriterion.delete({ where: { id: costCriterion.id } });
  const orphan = await prisma.significanceResult.findFirst({
    where: { requestId: first.id, criterionId: costCriterion.id },
  });
  ok("and survives the criterion being deleted", orphan !== null);

  // --- (5) routing is a history -------------------------------------------
  console.log("\nRouting");

  const firstRouting = await prisma.reviewAssignment.create({
    data: { requestId: first.id, assignedToName: "First Architect", state: "active" },
  });
  await prisma.reviewAssignment.update({
    where: { id: firstRouting.id },
    data: { state: "reassigned" },
  });
  await prisma.reviewAssignment.create({
    data: { requestId: first.id, assignedToName: "Second Architect", state: "active" },
  });

  const history = await prisma.reviewAssignment.findMany({
    where: { requestId: first.id },
    orderBy: { createdAt: "asc" },
  });
  const active = history.filter((a) => a.state === "active");
  ok("reassignment keeps the earlier routing", history.length === 2, `got ${history.length}`);
  ok("exactly one routing is live", active.length === 1, `got ${active.length}`);
  ok("and it is the later one", active[0]?.assignedToName === "Second Architect");

  // --- cascades ------------------------------------------------------------
  console.log("\nCascades");

  await prisma.architectureRequest.delete({ where: { id: second.id } });
  const afterRequestDelete = await prisma.architectureRequest.count({
    where: { organisationId: orgA.id },
  });
  ok("a request can be removed", afterRequestDelete === 1, `got ${afterRequestDelete}`);

  await prisma.organisation.delete({ where: { id: orgA.id } });
  const [requests, results, assignments, criteria] = await Promise.all([
    prisma.architectureRequest.count({ where: { organisationId: orgA.id } }),
    prisma.significanceResult.count({ where: { requestId: first.id } }),
    prisma.reviewAssignment.count({ where: { requestId: first.id } }),
    prisma.significanceCriterion.count({ where: { organisationId: orgA.id } }),
  ]);
  ok(
    "removing a customer takes their requests, results, routings and criteria",
    requests === 0 && results === 0 && assignments === 0 && criteria === 0,
    `${requests}/${results}/${assignments}/${criteria}`,
  );

  const otherCustomer = await prisma.significanceCriterion.count({
    where: { organisationId: orgB.id },
  });
  ok("and leaves the other customer untouched", otherCustomer === 1, `got ${otherCustomer}`);
} finally {
  await prisma.organisation.deleteMany({ where: { slug: { startsWith: TAG } } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
