import { prisma } from "@/lib/prisma";
import { DEFAULT_CRITERIA } from "./criteria";
import {
  classify,
  readConditions,
  type Answers,
  type Classification,
  type StoredCriterion,
} from "./evaluate";

/**
 * Running the criteria check against a request, and writing down what it found.
 *
 * The brief's Step 2. It runs on submission, in the same breath — "automatic,
 * completed within minutes of intake" — and unlike Step 3 it needs no worker,
 * no model and no retrieval: it is a few comparisons over answers already in
 * the row, and putting it on a queue would mean a person watching a spinner
 * for something that takes a millisecond.
 *
 * ## What is written, and why all of it
 *
 * A row per *active* category, whether or not it fired. The brief asks for "the
 * specific criteria checked and triggered", and a list of triggers alone cannot
 * answer the question an auditor actually asks — *was this considered?* A
 * category an administrator switched off last month leaves no row, and its
 * absence is the honest answer: it was not checked, because it was not on.
 *
 * Each row denormalises the category's wording as it stood. Criteria are
 * editable by design, and a classification reached in March has to keep stating
 * the rule it was reached under — the same reasoning that makes `Finding` carry
 * `clauseRef` and `clauseStatement` rather than joining to a clause that may
 * since have been sharpened.
 *
 * And each row carries the working: which field, which threshold, and what the
 * request actually said. "Cost Impact triggered because 7,500,000 is at least
 * 5,000,000" is a sentence a review board can act on. "Cost Impact: triggered"
 * is one they have to come back and ask about.
 */

/** Every field a condition may name, read off the stored request.
 *
 *  Explicit rather than spreading the row, so that a column added to the model
 *  later does not silently become something an administrator can write a rule
 *  against before anyone has decided it should be. */
export function answersOf(request: Record<string, unknown>): Answers {
  return {
    // Group A
    plannedStart: request.plannedStart,
    // Group C
    technologies: request.technologies,
    newTechnologyComponent: request.newTechnologyComponent,
    replacesTechnologyComponent: request.replacesTechnologyComponent,
    newOrDuplicatedStorage: request.newOrDuplicatedStorage,
    dataClassification: request.dataClassification,
    // Group D
    estimatedCost: request.estimatedCost,
    newLicenceRequired: request.newLicenceRequired,
    linesOfBusiness: request.linesOfBusiness,
    newBusinessCapability: request.newBusinessCapability,
    regulatoryImpact: request.regulatoryImpact,
    securityDomainChange: request.securityDomainChange,
    applicationDecommissioned: request.applicationDecommissioned,
    applicationCriticality: request.applicationCriticality,
    newApplicationStandard: request.newApplicationStandard,
    dataGovernanceEscalation: request.dataGovernanceEscalation,
    standardsChangeProposed: request.standardsChangeProposed,
  };
}

/**
 * This customer's criteria, seeded on first use.
 *
 * Seeding here as well as in the script means an organisation created after the
 * script last ran is not silently assessed against nothing. The insert is
 * `skipDuplicates`, so two submissions arriving together cannot both create the
 * set — and an administrator's edits are never overwritten, because a category
 * that exists is left exactly as it is.
 */
export async function criteriaFor(organisationId: string): Promise<StoredCriterion[]> {
  const existing = await prisma.significanceCriterion.findMany({
    where: { organisationId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, category: true, label: true, active: true, conditions: true },
  });
  if (existing.length > 0) return existing;

  await prisma.significanceCriterion.createMany({
    data: DEFAULT_CRITERIA.map((seed, index) => ({
      organisationId,
      category: seed.category,
      label: seed.label,
      description: seed.description,
      conditions: seed.conditions,
      sortOrder: index,
    })),
    skipDuplicates: true,
  });

  return prisma.significanceCriterion.findMany({
    where: { organisationId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, category: true, label: true, active: true, conditions: true },
  });
}

/**
 * Check one request, and record the result against it.
 *
 * Returns the classification, so a caller can say what happened without reading
 * it back. Re-running is safe: the rows are keyed by request and criterion, so
 * a resubmission replaces its own answers rather than appending a second
 * opinion.
 *
 * Time is measured from the submission, not from now. A request classified in
 * January must still read the same way in March — see `classify`.
 */
export async function runCriteriaCheck(requestId: string): Promise<Classification | null> {
  const request = await prisma.architectureRequest.findUnique({ where: { id: requestId } });
  if (!request) return null;

  const criteria = await criteriaFor(request.organisationId);
  const result = classify(
    criteria,
    answersOf(request as unknown as Record<string, unknown>),
    request.submittedAt ?? request.createdAt,
  );

  await prisma.$transaction([
    // Cleared first, so a category switched off since the last run does not
    // leave a stale row claiming it was checked this time.
    prisma.significanceResult.deleteMany({ where: { requestId } }),
    prisma.significanceResult.createMany({
      data: result.results.map((outcome) => ({
        requestId,
        criterionId: outcome.criterionId,
        category: outcome.category,
        categoryLabel: outcome.categoryLabel,
        conditionText: outcome.conditionText,
        triggered: outcome.triggered,
        // The working, not just the conclusion. Only the conditions that fired
        // for a triggered category — a reader wants to know what made this
        // significant, and every condition is already on the criterion itself.
        triggeredBy: outcome.triggered
          ? outcome.conditions.filter((condition) => condition.met)
          : [],
      })),
    }),
    prisma.architectureRequest.update({
      where: { id: requestId },
      data: { significance: result.significance, significanceAt: new Date() },
    }),
  ]);

  return result;
}

/** What was recorded, for the screen. Ordered as the criteria are. */
export async function resultsFor(requestId: string) {
  return prisma.significanceResult.findMany({
    where: { requestId },
    orderBy: [{ triggered: "desc" }, { categoryLabel: "asc" }],
  });
}


/**
 * Editing a customer's criteria. Owner only.
 *
 * Whoever controls these controls which submissions a person ever looks at, so
 * the rule is the same one that guards the standards library: an employee
 * submitting a design must not be able to decide whether their own work needs
 * a review board. `canManageStandards` is reused rather than restated, and the
 * check lives here rather than on the screen so a direct POST meets it too.
 *
 * What may be changed is deliberately narrow. An administrator sets thresholds,
 * renames a category and switches one off; they do not invent operators or name
 * fields the form does not collect, because a rule built on either can never
 * fire and would sit there looking configured. `classify` reports both, and the
 * screen shows what it says.
 */
export class CriteriaRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriteriaRefused";
  }
}

/** The values an administrator may change on one category. */
export type CriterionEdit = {
  label?: string;
  active?: boolean;
  /** The whole condition list, replaced. Partial edits of a list are a worse
   *  problem than they look: two administrators editing different conditions
   *  would silently drop one another's. */
  conditions?: unknown;
};

export async function updateCriterion(
  organisationId: string,
  criterionId: string,
  edit: CriterionEdit,
): Promise<void> {
  const criterion = await prisma.significanceCriterion.findFirst({
    where: { id: criterionId, organisationId },
    select: { id: true },
  });
  // Not found rather than refused: a criterion in another customer is
  // indistinguishable from one that does not exist.
  if (!criterion) throw new CriteriaRefused("That category no longer exists.");

  const data: Record<string, unknown> = {};

  if (edit.label !== undefined) {
    const label = edit.label.trim().slice(0, 120);
    if (!label) throw new CriteriaRefused("Give the category a name.");
    data.label = label;
  }
  if (edit.active !== undefined) data.active = Boolean(edit.active);
  if (edit.conditions !== undefined) {
    const conditions = readConditions(edit.conditions);
    if (Array.isArray(edit.conditions) && conditions.length !== edit.conditions.length) {
      throw new CriteriaRefused(
        "One of those conditions is not in a shape this version understands.",
      );
    }
    data.conditions = conditions;
  }

  if (Object.keys(data).length === 0) return;
  await prisma.significanceCriterion.update({ where: { id: criterionId }, data });
}

/** Put a customer's criteria back to the brief's defaults.
 *
 *  The way out of a configuration nobody can explain any more. Replaces the
 *  conditions and the labels, and leaves every recorded result alone — those
 *  denormalise the rule they were judged under precisely so that this is safe.
 */
export async function restoreDefaults(organisationId: string): Promise<number> {
  const existing = await prisma.significanceCriterion.findMany({
    where: { organisationId },
    select: { id: true, category: true },
  });
  const byCategory = new Map(existing.map((row) => [row.category, row.id]));

  let restored = 0;
  for (const [index, seed] of DEFAULT_CRITERIA.entries()) {
    const id = byCategory.get(seed.category);
    if (id) {
      await prisma.significanceCriterion.update({
        where: { id },
        data: {
          label: seed.label,
          description: seed.description,
          conditions: seed.conditions,
          active: true,
          sortOrder: index,
        },
      });
    } else {
      await prisma.significanceCriterion.create({
        data: {
          organisationId,
          category: seed.category,
          label: seed.label,
          description: seed.description,
          conditions: seed.conditions,
          sortOrder: index,
        },
      });
    }
    restored += 1;
  }
  return restored;
}
