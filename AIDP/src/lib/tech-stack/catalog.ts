import type { BrandSlug } from "@/components/brand/marks";

/**
 * The option catalog behind the Technology Stack & Architecture Reference.
 *
 * Sections and wording follow the client assessment template. The catalog is
 * a starting set, never a closed list: every multi-select field accepts a
 * write-in, and section 4 accepts extra platforms. A write-in is stored as the
 * plain string the client typed, so nothing here has to change to accept one.
 *
 * `id` is what lands in the database. Renaming an id orphans existing answers,
 * so treat these as stable keys and change `label` instead.
 */

export type Option = {
  id: string;
  label: string;
  brand?: BrandSlug;
  /** Shown under the label on wider cards. Keep it to a few words. */
  hint?: string;
};

export const DATA_SOURCES: readonly Option[] = [
  { id: "sap", label: "SAP", brand: "sap", hint: "ERP" },
  { id: "oracle-erp", label: "Oracle", brand: "oracle", hint: "ERP / database" },
  { id: "dynamics-365", label: "Dynamics 365", brand: "dynamics", hint: "ERP / CRM" },
  { id: "netsuite", label: "NetSuite", brand: "netsuite", hint: "ERP" },
  { id: "salesforce", label: "Salesforce", brand: "salesforce", hint: "CRM" },
  { id: "hubspot", label: "HubSpot", brand: "hubspot", hint: "CRM" },
  { id: "workday", label: "Workday", brand: "workday", hint: "HR / finance" },
  { id: "shopify", label: "Shopify", brand: "shopify", hint: "Commerce" },
  { id: "stripe", label: "Stripe", brand: "stripe", hint: "Payments" },
  { id: "postgres", label: "PostgreSQL", brand: "postgres", hint: "Operational DB" },
  { id: "mysql", label: "MySQL", brand: "mysql", hint: "Operational DB" },
  { id: "mongodb", label: "MongoDB", brand: "mongodb", hint: "Document store" },
  { id: "kafka", label: "Kafka", brand: "kafka", hint: "Event streams" },
  { id: "iot", label: "IoT / sensor telemetry", brand: "iot" },
  { id: "flat-files", label: "Flat files & spreadsheets", brand: "files" },
  { id: "rest-apis", label: "Third-party APIs", brand: "apis" },
];

export const DATA_WAREHOUSING: readonly Option[] = [
  { id: "snowflake", label: "Snowflake", brand: "snowflake" },
  { id: "databricks", label: "Databricks", brand: "databricks", hint: "Lakehouse" },
  { id: "fabric", label: "Microsoft Fabric", brand: "fabric" },
  { id: "bigquery", label: "BigQuery", brand: "bigquery", hint: "Google Cloud" },
  { id: "redshift", label: "Redshift", brand: "redshift", hint: "AWS" },
  { id: "synapse", label: "Synapse Analytics", brand: "synapse", hint: "Azure" },
  { id: "sql-server", label: "SQL Server", brand: "sqlserver", hint: "On-premise" },
  { id: "oracle-dw", label: "Oracle", brand: "oracle", hint: "On-premise" },
  { id: "teradata", label: "Teradata", brand: "teradata" },
  { id: "clickhouse", label: "ClickHouse", brand: "clickhouse" },
  { id: "postgres-dw", label: "PostgreSQL", brand: "postgres" },
  { id: "none", label: "No warehouse yet", brand: "none" },
];

export const BI_REPORTING: readonly Option[] = [
  { id: "power-bi", label: "Power BI", brand: "powerbi" },
  { id: "tableau", label: "Tableau", brand: "tableau" },
  { id: "looker", label: "Looker", brand: "looker" },
  { id: "qlik", label: "Qlik", brand: "qlik" },
  { id: "excel", label: "Excel", brand: "excel" },
  { id: "metabase", label: "Metabase", brand: "metabase" },
  { id: "superset", label: "Apache Superset", brand: "superset" },
  { id: "sigma", label: "Sigma" },
  { id: "thoughtspot", label: "ThoughtSpot" },
  { id: "none", label: "No BI tool yet", brand: "none" },
];

export const PRIMARY_CLOUD: readonly Option[] = [
  { id: "azure", label: "Microsoft Azure", brand: "azure" },
  { id: "aws", label: "AWS", brand: "aws" },
  { id: "gcp", label: "Google Cloud", brand: "gcp" },
  { id: "oci", label: "Oracle Cloud", brand: "oraclecloud" },
  { id: "ibm", label: "IBM Cloud", brand: "ibmcloud" },
  { id: "multi-cloud", label: "Multi-cloud", brand: "multicloud" },
  { id: "on-premise", label: "On-premise", brand: "onprem" },
];

/**
 * Section 3. Fixed set — these four are the template's own wording and the
 * answers feed a comparison across clients, so a write-in would dilute them.
 */
export const WORKLOADS: readonly Option[] = [
  {
    id: "bi-dashboards",
    label: "Business Intelligence & dashboards",
    hint: "Standard enterprise reporting, self-service analytics",
    brand: "powerbi",
  },
  {
    id: "data-engineering",
    label: "Data engineering",
    hint: "Complex ETL/ELT pipelines, large-scale transformations",
    brand: "lakehouse",
  },
  {
    id: "data-science-ai",
    label: "Data science & AI/ML",
    hint: "Predictive modelling, LLMOps, advanced analytics",
    brand: "compute",
  },
  {
    id: "sharing-governance",
    label: "Data sharing & governance",
    hint: "Secure, cross-organisation data collaboration",
    brand: "warehouse",
  },
];

/** Section 4. Clients may add their own rows on top of these. */
export const PLATFORMS: readonly Option[] = [
  {
    id: "microsoft-fabric",
    label: "Microsoft Fabric",
    hint: "Unified SaaS, Power BI ecosystem",
    brand: "fabric",
  },
  {
    id: "databricks",
    label: "Databricks",
    hint: "Lakehouse, open format, AI/ML focus",
    brand: "databricks",
  },
  {
    id: "snowflake",
    label: "Snowflake",
    hint: "Data warehouse, secure data sharing",
    brand: "snowflake",
  },
  {
    id: "aws-gcp-modular",
    label: "AWS / GCP modular",
    hint: "Custom-built pipelines, deep control",
    brand: "modular",
  },
];

export const USAGE_CHOICES = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const;

export const INTEREST_CHOICES = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const;

/**
 * Resolve a stored answer back to a catalog entry.
 *
 * Stored values are catalog ids for known options and raw text for write-ins,
 * so anything that misses gets rendered from its own string with a monogram.
 */
export function resolveOption(
  catalog: readonly Option[],
  value: string,
): Option {
  return catalog.find((option) => option.id === value) ?? { id: value, label: value };
}

/** Stable key for a write-in platform, namespaced so it can't collide. */
export function customPlatformKey(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `custom-${slug || "platform"}`;
}
