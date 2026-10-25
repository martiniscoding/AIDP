import { requireWorkspace } from "@/lib/access/gate";
import { canManageStandards } from "@/lib/access/roles";
import { PLACEHOLDER_COST_THRESHOLD } from "@/lib/significance/criteria";
import { criteriaFor } from "@/lib/significance/record";
import { readConditions } from "@/lib/significance/evaluate";
import { answersOf } from "@/lib/significance/record";
import { PageHeader } from "@/components/ui/PageHeader";
import { CriteriaBoard, type CriterionView } from "./CriteriaBoard";

export const dynamic = "force-dynamic";

/** The operators that compare against a single number, and so have a threshold
 *  an administrator can sensibly be offered a box for. */
const NUMERIC = new Set(["at_least", "count_at_least", "further_out_than_months"]);

/**
 * What makes a submission architecturally significant here.
 *
 * The brief's Section 2 — nine categories, seeded from its own table, and
 * editable because the thresholds are the customer's governance policy rather
 * than ours. Any one category triggering sends a request to a person; none
 * triggering is what allows the fast path through Step 5.
 *
 * Readable by everyone, changeable by an administrator. An employee filing a
 * request should be able to see what will be asked of it — that is the point of
 * writing the criteria down — but not to decide whether their own work needs a
 * review board.
 */
export default async function CriteriaPage() {
  const { organisation } = await requireWorkspace();
  const canEdit = canManageStandards(organisation.role);

  const criteria = await criteriaFor(organisation.id);

  // The field names a condition may legitimately use. Read from the same place
  // the check reads them, so a category naming something the form does not
  // collect is reported here rather than discovered when it never fires.
  const known = new Set(Object.keys(answersOf({})));

  const view: CriterionView[] = criteria.map((criterion) => {
    const conditions = readConditions(criterion.conditions);
    return {
      id: criterion.id,
      category: criterion.category,
      label: criterion.label,
      description: (criterion as { description?: string }).description ?? "",
      active: criterion.active,
      conditions:
        conditions.length === 0
          ? [
              {
                text: "",
                field: "",
                operator: "",
                threshold: null,
                problem: "This category has no conditions, so it can never be triggered.",
              },
            ]
          : conditions.map((condition) => ({
              text: condition.text || `${condition.field} ${condition.operator}`,
              field: condition.field,
              operator: condition.operator,
              threshold:
                NUMERIC.has(condition.operator) && typeof condition.value === "number"
                  ? condition.value
                  : null,
              problem: known.has(condition.field)
                ? null
                : `It checks "${condition.field}", which the request form does not ask, so it can never be met.`,
            })),
    };
  });

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Significance criteria"
        lede="What makes a request architecturally significant. Any one of these triggering sends it to a person; none triggering lets it through on the findings alone."
      />

      {!canEdit && (
        <p className="mb-4 text-[12.5px] text-ink/60">
          These are shown so you can see what will be asked of a request. Only an administrator
          can change them.
        </p>
      )}

      <CriteriaBoard
        criteria={view}
        canEdit={canEdit}
        placeholderThreshold={PLACEHOLDER_COST_THRESHOLD}
      />
    </>
  );
}
