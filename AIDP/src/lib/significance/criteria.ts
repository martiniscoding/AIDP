/**
 * The nine significance categories, as the brief's default configuration.
 *
 * Seed data, not policy. Every category, condition and threshold here is
 * editable by an administrator once it is in the database — that is the whole
 * reason `SignificanceCriterion` is a table rather than a constant. This file
 * is what a customer starts from on day one.
 *
 * Pure, with no database and no server-only imports, so the seed script, the
 * evaluator and the admin screen can all read the same definitions rather than
 * each keeping their own copy of what "cost impact" means.
 */

/**
 * The operators a condition can use.
 *
 * Deliberately few, and every one of them answerable from a single stored
 * answer. A condition the requestor cannot be asked directly — "is this a
 * *material* version change?" — is not expressible here, and that is the point:
 * a significance classification lands in an audit record, and it has to be
 * reproducible from the submitted answers rather than from a reading of them.
 */
export const OPERATORS = [
  /** A yes/no answer that was yes. */
  "is_true",
  /** A number at or above `value`. */
  "at_least",
  /** A list with at least `value` entries. */
  "count_at_least",
  /** A choice among `value`, a list of accepted answers. */
  "one_of",
  /** A date further into the future than `value` months from now. */
  "further_out_than_months",
] as const;

export type Operator = (typeof OPERATORS)[number];

export type Condition = {
  /** A column on ArchitectureRequest. */
  field: string;
  operator: Operator;
  value?: number | string[];
  /** The condition in the brief's own words, for the admin screen and for the
   *  `conditionText` a result denormalises. */
  text: string;
};

export type CriterionSeed = {
  category: string;
  label: string;
  description: string;
  conditions: Condition[];
  /** True where the seeded threshold is a placeholder that an administrator has
   *  to set before the check means anything. See `cost_impact`. */
  needsConfiguration?: boolean;
};

/**
 * A placeholder, and the one number in this file that is not from the brief.
 *
 * The brief says the cost threshold is "the organisation's defined project
 * cost-governance threshold, typically aligned to the PMO's", which is a number
 * only the customer has. Seeding one anyway would mean every submission is
 * silently measured against a figure nobody chose, so the seed marks this
 * category as needing configuration and says so on the way out.
 */
export const PLACEHOLDER_COST_THRESHOLD = 5_000_000;

export const DEFAULT_CRITERIA: CriterionSeed[] = [
  {
    category: "major_technology_change",
    label: "Major Technology Change",
    description:
      "A new platform, product or component is introduced, or one replaces another.",
    conditions: [
      {
        field: "newTechnologyComponent",
        operator: "is_true",
        text: "A new technology component is introduced.",
      },
      {
        field: "replacesTechnologyComponent",
        operator: "is_true",
        text: "A new technology component replaces an existing one.",
      },
    ],
  },
  {
    category: "licensing",
    label: "Licensing",
    description:
      "A new software licence is being procured for technology approval, independently of funding.",
    conditions: [
      {
        field: "newLicenceRequired",
        operator: "is_true",
        text: "A new software licence is required.",
      },
    ],
  },
  {
    category: "cost_impact",
    label: "Cost Impact",
    description:
      "Estimated cost meets or exceeds the organisation's project cost-governance threshold.",
    needsConfiguration: true,
    conditions: [
      {
        field: "estimatedCost",
        operator: "at_least",
        value: PLACEHOLDER_COST_THRESHOLD,
        text: `Estimated cost is at least ${PLACEHOLDER_COST_THRESHOLD.toLocaleString("en-GB")}.`,
      },
    ],
  },
  {
    category: "business_impact",
    label: "Business Impact",
    description:
      "A new capability across lines of business, several lines of business affected, or a regulatory impact.",
    conditions: [
      {
        field: "newBusinessCapability",
        operator: "is_true",
        text: "A new business capability is introduced.",
      },
      {
        field: "linesOfBusiness",
        operator: "count_at_least",
        value: 2,
        text: "More than one line of business is affected.",
      },
      {
        field: "regulatoryImpact",
        operator: "is_true",
        text: "A regulatory impact is identified.",
      },
    ],
  },
  {
    category: "security_impact",
    label: "Security Impact",
    description:
      "A major change in the security domain — one triggering a higher-tier Authority-to-Operate or risk assessment.",
    conditions: [
      {
        field: "securityDomainChange",
        operator: "is_true",
        text: "A major change in the security domain is identified.",
      },
    ],
  },
  {
    category: "application_architecture_impact",
    label: "Application Architecture Impact",
    description:
      "An application is decommissioned or replaced, a critical application is affected, or a new application standard is introduced.",
    conditions: [
      {
        field: "applicationDecommissioned",
        operator: "is_true",
        text: "An application is being decommissioned or replaced.",
      },
      {
        field: "applicationCriticality",
        operator: "one_of",
        value: ["business_critical", "mission_critical"],
        text: "A business-critical or mission-critical application is affected.",
      },
      {
        field: "newApplicationStandard",
        operator: "is_true",
        text: "A new application standard is introduced.",
      },
    ],
  },
  {
    category: "data_architecture_impact",
    label: "Data Architecture Impact",
    description:
      "An escalation from Data & Information Governance, or an impact on data storage or duplication.",
    conditions: [
      {
        field: "dataGovernanceEscalation",
        operator: "is_true",
        text: "An escalation from Data & Information Governance is identified.",
      },
      {
        field: "newOrDuplicatedStorage",
        operator: "is_true",
        text: "New or duplicated data storage is introduced.",
      },
    ],
  },
  {
    category: "time_impact",
    label: "Time Impact",
    description:
      "Implementation will not begin within the defined window, so approval must return to governance first.",
    conditions: [
      {
        field: "plannedStart",
        operator: "further_out_than_months",
        value: 12,
        text: "Implementation begins more than 12 months from now.",
      },
    ],
  },
  {
    category: "standards_change",
    label: "Standards Change",
    description:
      "A change to an approved architecture principle, or to a platform or technology standard.",
    conditions: [
      {
        field: "standardsChangeProposed",
        operator: "is_true",
        text: "A change to an existing principle or standard is proposed.",
      },
    ],
  },
];

/** The classifications a criteria check can reach. */
export const SIGNIFICANCE = ["significant", "not_significant"] as const;

export type Significance = (typeof SIGNIFICANCE)[number];
