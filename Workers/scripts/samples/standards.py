"""The three reference standards — Northwind Energy's own library.

These are the base: what an assessment measures against. Between them they carry
every structural feature the parser has to survive, deliberately:

  · a ruled table with genuinely empty cells (Data §8.1 Tier 4)
  · a table nested inside a clause rather than beside it (Security §2.2)
  · a table that runs over a page break (Security §6.2)
  · a diagram rasterised to leave no text layer (Architecture §1.3)
  · a section with a heading and nothing under it (Data §9)
  · guidance blocks, which only the architecture document has
"""

from __future__ import annotations

from .build import Builder, Clause, Table


def data_standards(path: str) -> None:
    b = Builder("Data Standards", "Internal Use")
    b.cover(
        "Enterprise Information Management",
        "Data Standards",
        "Enterprise Data Management and Governance Standards",
        "DOC-DATA-STD  V-2.1",
        "01/04/2026",
    )
    b.new_page()
    b.revision_history(
        [
            ["1.0", "2024-06-14", "R. Okonjo", "Initial publication"],
            ["2.0", "2025-11-02", "R. Okonjo", "Added lifecycle and disposal"],
            ["2.1", "2026-04-01", "M. Ferreira", "Classification tiers revised"],
        ]
    )

    b.h1("1.", "Introduction")
    b.h2("1.1", "Purpose")
    b.body(
        "This document defines the Data Standards that govern how data is created, "
        "structured, stored, secured, integrated and retired across Northwind Energy. "
        "It is technology-agnostic and applies regardless of the platform or vendor "
        "delivering a solution."
    )
    b.h2("1.2", "Scope")
    b.body(
        "These standards apply to all structured, semi-structured and unstructured data "
        "created, processed, stored or transmitted by enterprise systems. They are binding "
        "for internal teams, contractors and external vendors delivering data-related "
        "solutions on behalf of the organisation."
    )
    b.h2("1.3", "Definitions of Terms")
    b.table(
        Table(
            ["Term", "Definition"],
            [
                ["Data Owner", "The role accountable for the definition, quality and appropriate use of a data domain."],
                ["Data Steward", "The role responsible for day-to-day application of data standards within a domain."],
                ["Golden Record", "The single trusted version of a data entity after reconciliation across sources."],
                ["PII", "Personally Identifiable Information — data that can identify an individual directly or indirectly."],
            ],
            widths=[1.0, 2.6],
        )
    )

    b.h1("2.", "Data Governance Standards")
    b.h2("2.1", "Data Ownership and Stewardship")
    b.clause(
        Clause(
            "Data Ownership and Stewardship",
            "Every data domain must have a designated Data Owner accountable for its "
            "definition and quality, supported by one or more Data Stewards.",
            "Clear ownership prevents ambiguity in decision-making and provides an "
            "escalation path when quality issues arise.",
            [
                "Every critical data domain must have a named Data Owner recorded in the data catalogue",
                "Data Owners must approve changes to data definitions and classification within their domain",
                "Stewardship responsibilities must be reviewed at least annually",
            ],
        )
    )
    b.h2("2.2", "Policy Compliance and Monitoring")
    b.clause(
        Clause(
            "Policy Compliance and Monitoring",
            "Compliance with these standards must be actively monitored and reported, with "
            "corrective action tracked to closure.",
            "Without active monitoring, governance policies become documentation exercises "
            "rather than enforced controls.",
            [
                "Non-compliant systems must be logged in a governance risk register with a remediation plan",
                "Key governance metrics must be reported to the Data Governance Council quarterly",
            ],
        )
    )

    b.h1("3.", "Data Architecture Standards")
    b.h2("3.1", "Layered Data Architecture")
    b.clause(
        Clause(
            "Layered Data Architecture",
            "Data platforms must implement a layered architecture separating raw, curated "
            "and consumption-ready data.",
            "Layering isolates change and allows reprocessing without impacting downstream "
            "consumers.",
            [
                "Raw data must be retained in its original form prior to transformation",
                "Data must not be modified in place within the raw layer",
                "Consumption layers must be modelled for their specific reporting or operational use",
            ],
        )
    )
    b.h2("3.2", "Single Source of Truth")
    b.clause(
        Clause(
            "Single Source of Truth",
            "Each data entity must have one authoritative system designated as its source of "
            "truth, from which all consuming systems derive their copy.",
            "Multiple uncontrolled sources of the same data lead to conflicting values and "
            "loss of trust in reporting.",
            [
                "Downstream systems must synchronise from the system of record rather than re-entering data",
                "Direct database-to-database connections into a system of record are prohibited; access must be mediated by the integration platform",
                "Any temporary duplication must be clearly labelled as a derived copy",
            ],
        )
    )

    b.h1("4.", "Data Modelling Standards")
    b.h2("4.1", "Naming Conventions")
    b.clause(
        Clause(
            "Naming Conventions",
            "All database objects must follow the documented naming convention below.",
            "Consistent naming reduces ambiguity and supports automated tooling such as "
            "catalogues and code generation.",
            [
                "Names must be descriptive, in English, and use approved abbreviations only",
                "Reserved words and platform-specific keywords must be avoided",
                "Conventions must be applied consistently across dev, test and production",
            ],
        )
    )
    b.table(
        Table(
            ["Object Type", "Convention", "Example"],
            [
                ["Table", "snake_case, plural noun", "customer_orders"],
                ["Column", "snake_case, singular noun", "order_date"],
                ["Primary Key", "pk_<table>", "pk_customer_orders"],
                ["Foreign Key", "fk_<table>_<ref_table>", "fk_orders_customers"],
                ["Index", "ix_<table>_<columns>", "ix_orders_order_date"],
                ["View", "vw_<business_name>", "vw_active_customers"],
            ],
            widths=[1.0, 1.5, 1.4],
        )
    )
    b.h2("4.2", "Standard Data Types and Formats")
    b.clause(
        Clause(
            "Standard Data Types and Formats",
            "Common data domains such as dates, currency and identifiers must use "
            "standardised types and formats across all systems.",
            "Inconsistent formats are a leading cause of integration defects and reporting "
            "errors.",
            [
                "Dates and timestamps must use ISO 8601 for system-to-system exchange",
                "Monetary values must specify a currency code and a consistent decimal precision",
                "Character encoding must default to UTF-8 across all stores and interfaces",
            ],
        )
    )

    b.h1("5.", "Data Quality Standards")
    b.h2("5.1", "Data Quality Dimensions")
    b.table(
        Table(
            ["Dimension", "Definition", "Example Metric"],
            [
                ["Accuracy", "Data correctly reflects the real-world object it represents", "% matching verified source"],
                ["Completeness", "Required attributes are populated", "% mandatory fields populated"],
                ["Timeliness", "Data is available within the required window", "Average latency vs SLA"],
                ["Uniqueness", "No unintended duplicates exist for the same entity", "Duplicate record rate"],
            ],
            widths=[0.9, 2.0, 1.2],
        )
    )
    b.h2("5.2", "Quality Monitoring and Remediation")
    b.clause(
        Clause(
            "Quality Monitoring and Remediation",
            "Critical data domains must be subject to automated quality monitoring with "
            "defined thresholds and remediation workflows.",
            "Proactive monitoring surfaces issues before they propagate into downstream "
            "reporting and operational decisions.",
            [
                "Automated checks must run on ingestion and on a scheduled interval",
                "Breaches of threshold must raise an alert and be logged for remediation",
                "Root-cause analysis must be performed for recurring issues",
            ],
        )
    )

    b.h1("6.", "Data Security and Privacy Standards")
    b.h2("6.1", "Data Classification")
    b.body(
        "All data assets must be classified according to sensitivity to determine the "
        "appropriate handling, access and protection controls. Every solution design must "
        "state the classification of the data it holds."
    )
    b.table(
        Table(
            ["Classification", "Default Access", "Encryption at Rest", "External Sharing"],
            [
                ["Public", "Everyone", "Not required", "Permitted"],
                ["Internal", "All employees", "Recommended", "Requires approval"],
                ["Confidential", "Need-to-know", "Required", "Contractual controls"],
                ["Restricted", "Named roles", "Required", "Prohibited"],
            ],
            widths=[1.1, 1.1, 1.1, 1.1],
        )
    )
    b.h2("6.2", "Access Control")
    b.clause(
        Clause(
            "Access Control",
            "Access to data must be granted on the principle of least privilege using "
            "role-based access control aligned to data classification.",
            "Least privilege limits the blast radius of a compromised credential and "
            "supports auditability of who can access what.",
            [
                "Access must be requested, approved and recorded",
                "Access must be re-certified at least annually for Confidential and Restricted data",
                "Privileged and administrative access must be logged and monitored",
            ],
        )
    )
    b.h2("6.3", "Encryption")
    b.clause(
        Clause(
            "Encryption",
            "Confidential and Restricted data must be encrypted both at rest and in transit "
            "using currently approved algorithms.",
            "Encryption protects confidentiality even when the underlying storage or network "
            "is compromised.",
            [
                "Data in transit must use TLS 1.2 or higher, or an equivalent current standard",
                "Deprecated protocols and weak cipher suites must be disabled",
                "Encryption keys must be managed separately from the data they protect",
            ],
        )
    )

    b.h1("7.", "Data Integration Standards")
    b.h2("7.1", "Integration Pattern Selection")
    b.clause(
        Clause(
            "Integration Pattern Selection",
            "Integration must use an approved pattern — batch, asynchronous messaging, event "
            "streaming or API — appropriate to the latency and volume of the use case.",
            "Standardised patterns reduce point-to-point complexity and make the integration "
            "landscape easier to monitor and maintain.",
            [
                "Point-to-point integrations must be avoided in favour of the shared integration platform",
                "Real-time integration must be used where near-immediate availability is required",
                "Batch integration must have clearly defined windows and dependencies",
            ],
        )
    )
    b.h2("7.2", "Resilience and Idempotency")
    b.clause(
        Clause(
            "Resilience and Idempotency",
            "Integrations must handle failure gracefully through retries, dead-letter "
            "handling and idempotent processing.",
            "Network and system failures are inevitable; resilient design ensures data is not "
            "lost, duplicated or corrupted when they occur.",
            [
                "Failed messages that cannot be processed after retries must be routed to a dead-letter queue",
                "Integrations must be idempotent so repeated delivery does not create duplicate outcomes",
                "Each transaction must carry a unique correlation identifier for traceability",
            ],
        )
    )

    b.h1("8.", "Data Lifecycle Management Standards")
    b.h2("8.1", "Retention and Archival")
    b.clause(
        Clause(
            "Retention and Archival",
            "All data must be retained and archived according to the periods defined below, "
            "based on legal, regulatory and business requirements.",
            "Structured retention ensures long-term integrity and regulatory compliance while "
            "managing storage cost.",
            [
                "Retention periods must be defined per data category and recorded in the catalogue",
                "Backup and archival processes must align with the defined retention period",
                "Auditability must be preserved throughout the lifecycle",
            ],
        )
    )
    # The last row leaves two cells genuinely empty. A parser that drops empty
    # cells shifts every later value one column left, and Tier 4 silently
    # inherits Tier 3's retention period.
    b.table(
        Table(
            ["Tier", "Category", "Retention Period", "Archive After", "Disposal Method"],
            [
                ["Tier 1", "Regulated financial records", "7 years", "2 years", "Certified destruction"],
                ["Tier 2", "Customer contract records", "6 years", "2 years", "Certified destruction"],
                ["Tier 3", "Operational telemetry", "90 days", "30 days", "Automated purge"],
                ["Tier 4", "Transient diagnostic logs", "", "", "Automated purge"],
            ],
            widths=[0.7, 1.5, 1.1, 0.9, 1.2],
            caption="Retention tiers. Tier 4 periods are set per system and are not fixed centrally.",
        )
    )
    b.h2("8.2", "Secure Disposal")
    b.clause(
        Clause(
            "Secure Disposal",
            "Data must be securely and irreversibly disposed of at the end of its lifecycle in "
            "accordance with retention, legal and regulatory requirements.",
            "Ensures expired data is permanently removed while maintaining auditability.",
            [
                "Disposal must be auditable, authorised and verifiable",
                "All copies and dependent systems must be identified and addressed before destruction",
                "Legal holds must override automated disposal",
            ],
        )
    )

    # Deliberately incomplete. The parser must report this rather than let a
    # question about records management be answered from a sibling document.
    b.h1("9.", "Records Management Standards")
    b.body("This section is under development.")

    b.h1("10.", "Roles and Responsibilities")
    b.body("The following matrix summarises accountability for key data activities.")
    b.table(
        Table(
            ["Activity", "Data Owner", "Data Steward", "Custodian", "Council"],
            [
                ["Define data domain and business rules", "A", "R", "C", "I"],
                ["Approve data classification", "A", "R", "I", "I"],
                ["Monitor data quality", "I", "R", "C", "I"],
                ["Approve access requests", "A", "R", "C", "I"],
                ["Approve data disposal", "A", "R", "R", "I"],
            ],
            widths=[2.2, 0.8, 0.9, 0.8, 0.7],
        )
    )
    b.body("R = Responsible, A = Accountable, C = Consulted, I = Informed")

    b.h1("Appendix A:", "Glossary of Terms")
    b.table(
        Table(
            ["Term", "Definition"],
            [
                ["Data Lineage", "The traceable record of where data originates and how it is transformed."],
                ["Dead-letter queue", "A holding queue for messages that cannot be processed after retries."],
                ["Idempotency", "Repeating an operation produces the same result as performing it once."],
                ["System of Record", "The authoritative source system for a given data entity."],
            ],
            widths=[1.0, 2.6],
        )
    )
    b.save(path)


def security_standards(path: str) -> None:
    b = Builder("Security Standards", "Internal Use")
    b.cover(
        "Enterprise Information Security",
        "Security Standards",
        "Enterprise Information Security Standards",
        "DOC-SEC-STD  V-3.0",
        "01/02/2026",
    )
    b.new_page()
    b.revision_history(
        [
            ["2.0", "2024-09-30", "T. Alvarez", "Cloud security added"],
            ["3.0", "2026-02-01", "T. Alvarez", "Aligned to revised risk appetite"],
        ]
    )

    b.h1("1.", "Introduction")
    b.h2("1.1", "Purpose")
    b.body(
        "This document defines the Security Standards that govern how systems, applications, "
        "networks and data are protected against unauthorised access, disclosure, alteration "
        "and disruption."
    )
    b.h2("1.2", "Scope")
    b.body(
        "These standards apply to all systems, applications, infrastructure and data owned or "
        "operated by the organisation, and to third parties that access, process or host "
        "organisational data. They are binding for internal teams, contractors and external "
        "vendors."
    )

    b.h1("2.", "Identity and Access Management")
    b.h2("2.1", "Identity Lifecycle")
    b.clause(
        Clause(
            "Identity Lifecycle",
            "Identities must be provisioned, modified and de-provisioned through a controlled, "
            "auditable process aligned to employment or engagement status.",
            "Stale or orphaned accounts are a leading cause of unauthorised access.",
            [
                "Provisioning must be tied to an authoritative source such as the HR system",
                "Access must be revoked within one business day of termination",
                "Dormant accounts exceeding 90 days of inactivity must be disabled automatically",
            ],
        )
    )
    b.h2("2.2", "Authentication")
    b.clause(
        Clause(
            "Authentication",
            "All access must be authenticated using mechanisms appropriate to the sensitivity "
            "of the system, with multi-factor authentication required for privileged and remote "
            "access.",
            "Passwords alone are increasingly insufficient against credential-based attacks.",
            [
                "MFA must be enforced for all remote access, administrative access, and access to Confidential or Restricted systems",
                "Shared or generic accounts must be avoided; where unavoidable, usage must be logged",
                "Default vendor credentials must be changed before production deployment",
            ],
        )
    )
    # Nested inside the clause rather than beside it: the minimum standard for
    # this control lives only in the table.
    b.table(
        Table(
            ["Control", "Minimum Standard"],
            [
                ["Password length", "Minimum 12 characters; 14 or more for privileged accounts"],
                ["Password complexity", "Upper and lower case, numbers and symbols, or an equivalent passphrase policy"],
                ["Multi-factor authentication", "Required for remote, administrative and Confidential system access"],
                ["Account lockout", "After five consecutive failed attempts"],
                ["Session timeout", "30 minutes of inactivity; 15 minutes for privileged sessions"],
            ],
            widths=[1.1, 2.5],
        )
    )
    b.h2("2.3", "Least Privilege")
    b.clause(
        Clause(
            "Least Privilege",
            "Access must be granted on the principle of least privilege using role-based access "
            "control, and must be formally requested and approved.",
            "Least privilege constrains what any single identity can access or perform.",
            [
                "Access must be granted through defined roles rather than ad hoc individual permissions",
                "Segregation of duties must be enforced for high-risk transactions",
                "Access approvals must be documented and retained for audit",
            ],
        )
    )

    b.h1("3.", "Network Security")
    b.h2("3.1", "Segmentation and Zoning")
    b.clause(
        Clause(
            "Segmentation and Zoning",
            "Networks must be segmented into security zones based on trust level and data "
            "sensitivity, with controlled traffic flow between them.",
            "Segmentation contains the blast radius of a compromise.",
            [
                "Production, non-production and management networks must be separated",
                "Traffic between zones must pass through a defined control point with explicit allow rules",
                "Systems handling Confidential data must reside in a zone with elevated controls",
            ],
        )
    )
    b.table(
        Table(
            ["Zone", "Purpose", "Typical Controls"],
            [
                ["External / DMZ", "Internet-facing services", "Reverse proxy, WAF, strict inbound filtering"],
                ["Internal", "General user workstations and services", "Standard firewalling, endpoint protection"],
                ["Application / Data", "Business applications and databases", "Restricted east-west traffic, enhanced monitoring"],
                ["Management", "Infrastructure and administrative access", "Jump hosts, MFA, strict access lists"],
            ],
            widths=[1.0, 1.5, 1.7],
        )
    )
    b.h2("3.2", "Secure Remote Access")
    b.clause(
        Clause(
            "Secure Remote Access",
            "Remote access to internal systems must be provided through an approved, encrypted "
            "and authenticated solution.",
            "Unmanaged remote access pathways are a common entry point for attackers.",
            [
                "Remote access must require MFA and use encrypted channels",
                "Remote access logs must be retained and available for monitoring",
            ],
        )
    )

    b.h1("4.", "Application Security")
    b.h2("4.1", "Secure Development Lifecycle")
    b.clause(
        Clause(
            "Secure Development Lifecycle",
            "Security requirements, threat modelling and security testing must be integrated "
            "into each phase of the software development lifecycle.",
            "Addressing security during design is materially cheaper than remediating after "
            "release.",
            [
                "Threat modelling must be performed for new applications and significant architectural changes",
                "Static analysis and dependency scanning must run in the build pipeline",
                "Security defects above a defined severity must be remediated before production release",
            ],
        )
    )
    b.h2("4.2", "Secure Coding")
    b.clause(
        Clause(
            "Secure Coding",
            "Applications must be developed in accordance with secure coding practices and "
            "tested for common vulnerability classes before release.",
            "The majority of application breaches exploit well-known, preventable vulnerability "
            "classes.",
            [
                "Input validation and output encoding must be applied to prevent injection and cross-site scripting",
                "Third-party dependencies must be scanned for known vulnerabilities and kept current",
                "Sensitive data must not be logged, cached or exposed in error messages",
            ],
        )
    )
    b.h2("4.3", "API Security")
    b.clause(
        Clause(
            "API Security",
            "APIs must be authenticated, authorised, rate-limited and validated consistently "
            "with other application interfaces.",
            "APIs are exposed to a broader range of consumers and require explicit controls "
            "rather than obscurity.",
            [
                "APIs must require authentication and enforce authorisation on every request",
                "Rate limiting must be applied to protect against abuse and denial of service",
                "Input payloads must be validated against a defined contract",
            ],
        )
    )

    b.h1("5.", "Cryptography")
    b.h2("5.1", "Cryptographic Standards")
    b.clause(
        Clause(
            "Cryptographic Standards",
            "Encryption must use currently approved, industry-standard algorithms and key "
            "lengths for all Confidential and Restricted data, at rest and in transit.",
            "Algorithms weaken over time as computing power and cryptanalysis advance.",
            [
                "Data in transit must use TLS 1.2 or higher",
                "Deprecated protocols and cipher suites must be disabled",
                "Unencrypted transport of Confidential data is prohibited on all networks, including private ones",
            ],
        )
    )
    b.h2("5.2", "Key Management")
    b.clause(
        Clause(
            "Key Management",
            "Cryptographic keys must be generated, stored, rotated and retired through a "
            "dedicated key management process, separate from the data they protect.",
            "Keys stored alongside the data they protect undermine encryption entirely if "
            "compromised together.",
            [
                "Keys must be held in a dedicated key management service or hardware security module",
                "Key rotation schedules must be defined and enforced",
                "Keys must never be embedded in source code or configuration files",
            ],
        )
    )

    b.h1("6.", "Logging, Monitoring and Incident Response")
    b.h2("6.1", "Logging and Monitoring")
    b.clause(
        Clause(
            "Logging and Monitoring",
            "Systems must generate security-relevant logs which are centrally collected and "
            "retained for a defined period.",
            "Without centralised, tamper-resistant logging, malicious activity cannot be "
            "detected or reconstructed.",
            [
                "Logs must capture authentication events, privileged actions and configuration changes",
                "Logs must be forwarded to the central platform and protected from modification",
                "Log retention must align with regulatory and investigative requirements",
            ],
        )
    )
    b.h2("6.2", "Incident Severity Classification")
    b.body(
        "Incidents must be classified by severity to determine response priority and "
        "stakeholder notification."
    )
    b.table(
        Table(
            ["Severity", "Definition", "Example", "Initial Response"],
            [
                ["Critical", "Severe impact to critical systems, data or safety", "Active ransomware, large-scale breach", "Within the hour"],
                ["High", "Significant impact; contained but serious", "Confirmed unauthorised access to Confidential data", "Same business day"],
                ["Medium", "Limited impact; single system or contained scope", "Isolated malware detection, policy violation", "Within 2 business days"],
                ["Low", "Minimal impact; informational or precautionary", "Suspicious but unconfirmed activity", "Within 5 business days"],
            ],
            widths=[0.8, 1.7, 1.6, 1.0],
        )
    )

    b.h1("7.", "Third-Party and Vendor Security")
    b.h2("7.1", "Vendor Security Risk Assessment")
    b.clause(
        Clause(
            "Vendor Security Risk Assessment",
            "Third parties that access, process or host organisational data must undergo a "
            "security risk assessment proportionate to the engagement before onboarding.",
            "Third-party relationships extend the attack surface beyond direct control.",
            [
                "Vendors handling Confidential data must evidence an adequate control environment",
                "Findings must be documented, risk-rated and tracked to remediation",
                "High-risk vendors must be reassessed periodically for the duration of the engagement",
            ],
        )
    )

    b.h1("Appendix A:", "Glossary of Terms")
    b.table(
        Table(
            ["Term", "Definition"],
            [
                ["Defence in Depth", "Layered controls so the failure of one does not result in compromise."],
                ["MFA", "Multi-Factor Authentication — two or more independent verification factors."],
                ["WAF", "Web Application Firewall — filters and monitors HTTP traffic to an application."],
                ["Zero Trust", "Continuous verification of every user and device regardless of network location."],
            ],
            widths=[1.0, 2.6],
        )
    )
    b.save(path)


def architecture_standards(path: str) -> None:
    b = Builder("Solution Architecture Standards", "Internal Use")
    b.cover(
        "Enterprise Architecture",
        "Solution Architecture Standards",
        "Standards, Architecture Patterns and Technology Guidelines",
        "DOC-SOL-ARCH-STD  V-1.4",
        "15/03/2026",
    )
    b.new_page()
    b.revision_history(
        [
            ["1.0", "2024-01-22", "J. Whitfield", "Initial publication"],
            ["1.4", "2026-03-15", "J. Whitfield", "Observability and NFR sections expanded"],
        ]
    )

    b.h1("1.", "Introduction")
    b.h2("1.1", "Purpose")
    b.body(
        "This document defines the Solution Architecture Standards that govern how "
        "applications and technology solutions are designed, integrated and deployed. "
        "Alongside each standard it states the recommended patterns and reference "
        "technologies, so that teams have both the rule and the means of implementing it."
    )
    b.h2("1.2", "Scope")
    b.body(
        "These standards apply to all new solution designs, major enhancements and technology "
        "selections, and are binding for internal teams as well as external vendors delivering "
        "solutions on the organisation's behalf. Every significant design must be reviewed by "
        "the Architecture Review Board before implementation."
    )
    b.h2("1.3", "Enterprise Context")
    b.diagram(
        "Figure 1 — Enterprise context. Systems are grouped by domain; arrows indicate "
        "governed data flow through the integration platform.",
        [
            ("DIGITAL CUSTOMER", ["Customer Portal", "Billing Engine", "Contact Centre", "Notification Hub"]),
            ("DIGITAL OPERATIONS", ["Field Workforce", "Asset Register", "SCADA Gateway", "Outage Management"]),
            ("PLATFORM", ["Integration Platform", "Enterprise Data Platform", "Identity Provider", "Observability Stack"]),
        ],
    )

    b.h1("2.", "Architecture Governance")
    b.h2("2.1", "Architecture Decision Records")
    b.clause(
        Clause(
            "Architecture Decision Records",
            "Significant architecture decisions, including rationale, alternatives considered "
            "and trade-offs, must be documented as Architecture Decision Records and retained "
            "alongside the solution.",
            "Undocumented decisions are quickly forgotten and frequently relitigated.",
            [
                "ADRs must be created for decisions with long-term or cross-team impact",
                "ADRs must record status: proposed, accepted, deprecated or superseded",
                "ADRs must be version-controlled alongside the solution's source code",
            ],
            ["Use the lightweight ADR template rather than a heavyweight document format"],
        )
    )
    b.h2("2.2", "Reference Architecture Alignment")
    b.clause(
        Clause(
            "Reference Architecture Alignment",
            "New solutions must be designed against an applicable reference architecture where "
            "one exists, with deviations explicitly justified.",
            "Reference architectures encode proven, pre-vetted decisions and reduce design time.",
            [
                "Deviations must be documented with rationale and reviewed by architecture governance",
                "Exceptions must be time-bound and recorded in the exception register",
            ],
        )
    )

    b.h1("3.", "Design Principles")
    b.h2("3.1", "Loose Coupling and High Cohesion")
    b.clause(
        Clause(
            "Loose Coupling and High Cohesion",
            "Components must be designed with well-defined interfaces and minimal "
            "interdependency, so each can change independently.",
            "Tightly coupled systems are expensive to change and test.",
            [
                "Components must communicate through versioned interfaces rather than direct database access",
                "Shared databases across independently owned services must be avoided",
            ],
            ["Event-driven architecture and publish/subscribe messaging", "API Gateway pattern to abstract internal topology"],
        )
    )
    b.h2("3.2", "API-First Design")
    b.clause(
        Clause(
            "API-First Design",
            "Application capabilities must be exposed through documented, versioned APIs "
            "designed contract-first, before any user interface is built against them.",
            "Contract-first design enables parallel development and treats the API as a durable "
            "product rather than a by-product.",
            [
                "APIs must be designed contract-first using an agreed specification format such as OpenAPI",
                "APIs must maintain backward compatibility within a major version",
                "APIs must be registered in the API catalogue or gateway for discoverability",
            ],
            ["OpenAPI 3.x for contract-first specification", "API Gateway for authentication, throttling and traffic management"],
        )
    )
    b.h2("3.3", "Statelessness and Horizontal Scalability")
    b.clause(
        Clause(
            "Statelessness and Horizontal Scalability",
            "Application components must be stateless wherever possible, with session and "
            "state externalised to a dedicated store, to support horizontal scaling.",
            "Stateless components scale out by adding instances and are resilient to individual "
            "instance failure.",
            [
                "Session state must be externalised to a shared cache or data store rather than held in local application memory",
                "Components must be safely restartable without loss of in-flight business state",
                "Horizontal scaling must be the default; vertical scaling requires justification in an ADR",
            ],
            ["Distributed cache such as Redis for externalised session state", "Load balancer with least-connections distribution across stateless instances"],
        )
    )
    b.h2("3.4", "Resilience by Design")
    b.clause(
        Clause(
            "Resilience by Design",
            "Solutions must anticipate the failure of dependencies and degrade gracefully "
            "rather than propagating failure across the system.",
            "In distributed systems, dependency failure is a matter of when, not if.",
            [
                "Timeouts and retries with exponential backoff must be applied to all external calls",
                "Critical dependencies must have a defined fallback or degraded mode",
                "Unprocessable asynchronous messages must be routed to a dead-letter queue rather than discarded",
            ],
            ["Circuit Breaker pattern", "Bulkhead pattern to isolate resource pools", "Retry with exponential backoff and jitter"],
        )
    )

    b.h1("4.", "Application Architecture")
    b.h2("4.1", "Containerisation and Packaging")
    b.clause(
        Clause(
            "Containerisation and Packaging",
            "Application components must be packaged as portable, self-contained container "
            "images that include their runtime dependencies.",
            "Containerisation ensures consistency between development, test and production.",
            [
                "Images must be built from an approved base image",
                "Images must be scanned for vulnerabilities before deployment",
                "Images must be immutable; configuration must be externalised rather than baked in",
            ],
            ["Docker or an equivalent OCI-compliant runtime", "Kubernetes for orchestration", "Container registry with vulnerability scanning"],
        )
    )
    b.h2("4.2", "Front-End Architecture")
    b.clause(
        Clause(
            "Front-End Architecture",
            "User-facing applications must use a component-based front-end architecture with a "
            "clear separation from back-end business logic, accessed exclusively through APIs.",
            "Separating concerns allows each to evolve independently and supports multiple front "
            "ends over the same services.",
            [
                "Front-end applications must not embed business rules belonging in the service layer",
                "Front-end applications must consume back-end capabilities only through published APIs",
            ],
            ["Component-based frameworks such as React, Angular or Vue", "Backend-for-Frontend where aggregation is required"],
        )
    )

    b.h1("5.", "Integration Architecture")
    b.h2("5.1", "Event-Driven Integration")
    b.clause(
        Clause(
            "Event-Driven Integration",
            "Where multiple systems react to the same business event, solutions must publish to "
            "a shared event backbone rather than each producer calling each consumer.",
            "An event-driven approach decouples producers from consumers entirely.",
            [
                "Events must be modelled as immutable facts with a well-defined, published schema",
                "Event schemas must be versioned and backward-compatible within a major version",
                "Consumers must handle duplicate or out-of-order delivery",
            ],
            ["Event streaming platform such as Kafka", "Schema registry to govern and version event schemas"],
        )
    )

    b.h1("6.", "Non-Functional Requirements")
    b.h2("6.1", "Observability")
    b.clause(
        Clause(
            "Observability",
            "Solutions must emit structured logs, metrics and distributed traces sufficient to "
            "diagnose issues without requiring code changes.",
            "Without observability, diagnosing production issues becomes slow guesswork.",
            [
                "Structured logging must be implemented with a correlation identifier propagated across service calls",
                "Key business and technical metrics must be exposed for monitoring and alerting",
                "Distributed tracing must be implemented for solutions composed of multiple services",
            ],
            ["Centralised log aggregation", "Prometheus and Grafana for metrics", "OpenTelemetry for distributed tracing"],
        )
    )
    b.h2("6.2", "Availability and Recovery")
    b.clause(
        Clause(
            "Availability and Recovery",
            "Solutions must define an availability target and recovery objectives aligned to "
            "business criticality, and be architected with redundancy to meet them.",
            "Explicit targets ensure the right level of investment in redundancy where it "
            "matters.",
            [
                "An availability target must be documented per solution",
                "Recovery time objective and recovery point objective must be stated explicitly",
                "Critical solutions must eliminate single points of failure through redundancy",
            ],
            ["Multi-zone deployment for redundancy", "Health checks and automated failover"],
        )
    )
    b.table(
        Table(
            ["Criticality", "Availability Target", "RTO", "RPO"],
            [
                ["Tier 1 — Mission critical", "99.95%", "1 hour", "15 minutes"],
                ["Tier 2 — Business critical", "99.9%", "4 hours", "1 hour"],
                ["Tier 3 — Productivity", "99.5%", "8 hours", "4 hours"],
            ],
            widths=[1.8, 1.2, 0.8, 0.8],
        )
    )

    b.h1("7.", "Technology Reference Model")
    b.table(
        Table(
            ["Layer", "Purpose", "Representative Technologies"],
            [
                ["Presentation", "User-facing interfaces", "Component-based web frameworks; native or cross-platform mobile"],
                ["API & Integration", "Exposing and managing service interfaces", "API gateway; integration platform; schema registry"],
                ["Application", "Core business processing", "Container-based services; managed runtimes; serverless functions"],
                ["Data & Storage", "Persisting and querying data", "Relational OLTP; document store; data warehouse; distributed cache"],
                ["Observability", "Monitoring and diagnosing system health", "Centralised logging; metrics; distributed tracing; alerting"],
            ],
            widths=[1.0, 1.5, 2.0],
        )
    )

    b.h1("Appendix A:", "Glossary of Terms")
    b.table(
        Table(
            ["Term", "Definition"],
            [
                ["ADR", "Architecture Decision Record — a short document capturing a significant decision."],
                ["Circuit Breaker", "A pattern that halts calls to a failing dependency to prevent cascading failure."],
                ["RPO", "Recovery Point Objective — the maximum acceptable data loss, measured in time."],
                ["RTO", "Recovery Time Objective — the maximum acceptable time to restore a system."],
            ],
            widths=[1.0, 2.6],
        )
    )
    b.save(path)
