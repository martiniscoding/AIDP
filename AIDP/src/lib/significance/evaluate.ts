import {
  OPERATORS,
  type Condition,
  type Operator,
  type Significance,
} from "./criteria";

/**
 * Is this submission architecturally significant?
 *
 * The brief's Step 2. Nine categories, each a short list of conditions over the
 * answers the requestor gave; any one condition met triggers its category, and
 * any one category triggered makes the submission significant.
 *
 * Pure, with no database and no model, and deliberately so. This decides
 * whether a human has to look at a piece of work, the answer lands in a
 * governance audit, and the first thing anyone will ask of a classification
 * they disagree with is *why*. So it is a function of the stored answers and
 * nothing else: given the same request and the same criteria, it returns the
 * same thing for ever, and it shows its working.
 *
 * ## Four rules everything here keeps
 *
 * **An unanswered question never triggers.** A null cost is not a cost below
 * the threshold and it is not a cost above it — it is an answer nobody gave,
 * and a classification built on one is a classification nobody can defend.
 *
 * **A condition that cannot be evaluated says so.** An administrator naming a
 * field that does not exist has written a rule that can never fire; silently
 * returning false would leave a category that looks configured and does
 * nothing. The outcome carries the problem so the screen can show it.
 *
 * **Time is measured from a fixed moment, not from now.** "Implementation
 * begins more than twelve months out" is a different answer in March than it
 * was in January, so the moment is passed in and pinned on the result. Re-read
 * a year later, the record still says what it meant.
 *
 * **Every condition is evaluated, not just enough to decide.** Short-circuiting
 * on the first match would be quicker and would leave the audit record saying
 * "triggered" without saying by how many things — and "it was significant on
 * cost alone" and "it was significant on five counts" are different
 * conversations at a review board.
 */

/** What one condition did, and why. */
export type ConditionOutcome = {
  field: string;
  operator: Operator;
  /** The threshold or list the condition compares against, when it has one. */
  value?: number | string[];
  /** The condition in the brief's own words. */
  text: string;
  /** What the request actually said, as a person would read it back. */
  actual: string;
  met: boolean;
  /** Why this could not be judged at all. Absent when it could. */
  problem?: string;
};

/** What one category did. */
export type CriterionOutcome = {
  criterionId: string;
  category: string;
  categoryLabel: string;
  /** The conditions as they stood, joined for the denormalised audit column. */
  conditionText: string;
  triggered: boolean;
  conditions: ConditionOutcome[];
};

export type Classification = {
  significance: Significance;
  /** Every active category, whether or not it triggered — "checked and
   *  triggered", which is what the brief asks to be recorded. */
  results: CriterionOutcome[];
  /** The categories that fired, for a one-line summary. */
  triggered: CriterionOutcome[];
  /** Conditions that could not be judged, across every category. An
   *  administrator needs these in front of them: each one is a rule that will
   *  never fire. */
  problems: ConditionOutcome[];
  /** The moment the time-based conditions were measured from. */
  asOf: Date;
};

/** A criterion as stored. Structural, so this module needs no Prisma types. */
export type StoredCriterion = {
  id: string;
  category: string;
  label: string;
  active: boolean;
  conditions: unknown;
};

/** The answers, as stored. Every field a condition may name. */
export type Answers = Record<string, unknown>;

/** How a value reads back to a person, for the audit record. */
function describe(value: unknown): string {
  if (value === null || value === undefined) return "not answered";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return text === "" ? "not answered" : text;
}

/** A number, or null when the answer is not one. Prisma's Decimal arrives as an
 *  object, so this goes through its string form rather than trusting a cast. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return null;
  const parsed = Number(typeof value === "object" ? String(value) : value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `months` after `from`, with the end of a short month handled the way a person
 * means it.
 *
 * Adding twelve months to 31 January lands on 31 January. Adding one month to
 * it cannot land on 31 February, and JavaScript would roll that forward to
 * 2 or 3 March — so the day is clamped to the last of the target month, which
 * is what "a month later" means to everybody who is not a calendar library.
 */
function addMonths(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const target = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1,
      from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** The conditions on a criterion, or an empty list when the stored value is not
 *  the shape this understands. A malformed row is a criterion that does
 *  nothing, which `evaluateCriterion` then reports. */
export function readConditions(value: unknown): Condition[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Condition =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as Condition).field === "string" &&
      (OPERATORS as readonly string[]).includes((entry as Condition).operator),
  );
}

function evaluateCondition(
  condition: Condition,
  answers: Answers,
  asOf: Date,
): ConditionOutcome {
  const base = {
    field: condition.field,
    operator: condition.operator,
    value: condition.value,
    text: condition.text ?? "",
  };

  // An administrator naming a field the form does not collect has written a
  // rule that can never fire. Reported rather than quietly answered "no".
  if (!(condition.field in answers)) {
    return {
      ...base,
      actual: "no such question",
      met: false,
      problem: `This request has no question called "${condition.field}", so the condition can never be met.`,
    };
  }

  const raw = answers[condition.field];
  const actual = describe(raw);

  switch (condition.operator) {
    case "is_true":
      return { ...base, actual, met: raw === true };

    case "at_least": {
      const threshold = toNumber(condition.value);
      if (threshold === null) {
        return { ...base, actual, met: false, problem: "No threshold is configured." };
      }
      const given = toNumber(raw);
      // Unanswered is not "below the threshold": it is an answer nobody gave.
      return { ...base, actual, met: given !== null && given >= threshold };
    }

    case "count_at_least": {
      const threshold = toNumber(condition.value);
      if (threshold === null) {
        return { ...base, actual, met: false, problem: "No count is configured." };
      }
      const list = Array.isArray(raw) ? raw.filter((x) => String(x ?? "").trim()) : null;
      if (list === null) {
        return {
          ...base,
          actual,
          met: false,
          problem: `"${condition.field}" is not a list, so it cannot be counted.`,
        };
      }
      return { ...base, actual: `${list.length} (${actual})`, met: list.length >= threshold };
    }

    case "one_of": {
      const accepted = Array.isArray(condition.value)
        ? condition.value.map((entry) => String(entry))
        : null;
      if (accepted === null || accepted.length === 0) {
        return { ...base, actual, met: false, problem: "No accepted answers are configured." };
      }
      return { ...base, actual, met: accepted.includes(String(raw ?? "")) };
    }

    case "further_out_than_months": {
      const months = toNumber(condition.value);
      if (months === null) {
        return { ...base, actual, met: false, problem: "No window is configured." };
      }
      const planned = toDate(raw);
      if (planned === null) {
        // No date given. Not "soon" and not "far off" — unanswered.
        return { ...base, actual, met: false };
      }
      const cutoff = addMonths(asOf, months);
      return {
        ...base,
        actual: `${describe(planned)} (window ends ${describe(cutoff)})`,
        met: planned.getTime() > cutoff.getTime(),
      };
    }

    default: {
      // An operator this build does not know — a criterion written by a newer
      // deployment, or a hand-edited row. Never treated as met.
      const unknown: string = condition.operator;
      return {
        ...base,
        actual: describe(raw),
        met: false,
        problem: `This version does not understand the rule "${unknown}".`,
      };
    }
  }
}

/** One category, against one request. */
export function evaluateCriterion(
  criterion: StoredCriterion,
  answers: Answers,
  asOf: Date,
): CriterionOutcome {
  const conditions = readConditions(criterion.conditions);
  const outcomes = conditions.map((condition) => evaluateCondition(condition, answers, asOf));

  // A category with no conditions is a category that does nothing. Said out
  // loud, because on the screen it looks configured.
  if (outcomes.length === 0) {
    return {
      criterionId: criterion.id,
      category: criterion.category,
      categoryLabel: criterion.label,
      conditionText: "",
      triggered: false,
      conditions: [
        {
          field: "",
          operator: "is_true",
          text: "",
          actual: "nothing to check",
          met: false,
          problem: "This category has no conditions, so it can never be triggered.",
        },
      ],
    };
  }

  return {
    criterionId: criterion.id,
    category: criterion.category,
    categoryLabel: criterion.label,
    // Joined as they stood, so the stored result keeps explaining itself after
    // an administrator has rewritten them.
    conditionText: outcomes.map((outcome) => outcome.text).filter(Boolean).join(" "),
    triggered: outcomes.some((outcome) => outcome.met),
    conditions: outcomes,
  };
}

/**
 * The whole check: every active category, and the classification they add up to.
 *
 * `asOf` is the moment time-based conditions are measured from — the request's
 * submission, not the moment this happens to run, so a re-evaluation of the
 * same submission cannot reach a different answer.
 */
export function classify(
  criteria: StoredCriterion[],
  answers: Answers,
  asOf: Date,
): Classification {
  const results = criteria
    .filter((criterion) => criterion.active)
    .map((criterion) => evaluateCriterion(criterion, answers, asOf));

  const triggered = results.filter((result) => result.triggered);
  const problems = results.flatMap((result) =>
    result.conditions.filter((condition) => condition.problem),
  );

  return {
    // Any one category is enough, which is the brief's own rule: a submission
    // is significant if *anything* about it is.
    significance: triggered.length > 0 ? "significant" : "not_significant",
    results,
    triggered,
    problems,
    asOf,
  };
}
