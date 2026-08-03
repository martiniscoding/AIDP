"""The two submitted designs — what gets assessed.

Written against the standards deliberately, so every verdict has a knowable
right answer. Each carries a mix of compliance, silence and outright
contradiction, and ANSWER_KEY.md records what each clause should come back as.

They are Solution Architecture Documents, not standards, so they have no
Statement/Rationale/Requirements structure. They parse into prose sections —
which is the shape the analyse stage will actually meet in the wild.
"""

from __future__ import annotations

from .build import Builder, Table


def customer_portal(path: str) -> None:
    """Broadly compliant, with two hard contradictions and several silences."""
    b = Builder("Customer Portal Modernisation — SAD", "Internal Use")
    b.cover(
        "Digital Customer",
        "Customer Portal Modernisation",
        "Solution Architecture Document",
        "SAD-CPM-2026-014  V-0.9",
        "22/06/2026",
    )
    b.new_page()
    b.revision_history(
        [
            ["0.5", "2026-05-11", "A. Berger", "First draft for internal review"],
            ["0.9", "2026-06-22", "A. Berger", "Updated after security walkthrough"],
        ]
    )

    b.h1("1.", "Solution Overview")
    b.body(
        "The Customer Portal Modernisation programme replaces the existing self-service "
        "portal with a component-based web application backed by a set of domain services. "
        "The portal serves approximately 1.4 million residential and small-business "
        "customers, providing account management, billing history, payment, outage reporting "
        "and meter reading submission."
    )
    b.body(
        "The existing portal is a monolithic application with business logic embedded in the "
        "presentation layer and direct queries against the billing database. This design "
        "replaces it with a React front end consuming published APIs, and a service layer "
        "that owns its own data store."
    )

    b.h1("2.", "Architecture")
    b.h2("2.1", "Component Structure")
    b.body(
        "The solution comprises a React single-page application, an API gateway, four domain "
        "services (Account, Billing View, Outage, Metering) and a read-optimised projection "
        "store. The front end contains presentation logic only and consumes back-end "
        "capability exclusively through published APIs; no business rules are implemented in "
        "the browser."
    )
    b.h2("2.2", "API Design")
    b.body(
        "All service interfaces are designed contract-first. The OpenAPI 3.1 specification for "
        "each service is authored and reviewed before implementation begins, published to the "
        "enterprise API gateway, and registered in the API catalogue. Breaking changes require "
        "a new major version; minor versions remain backward compatible for existing "
        "consumers."
    )
    b.h2("2.3", "Session Handling")
    b.body(
        "Following load testing, session state is held in the application's in-process memory "
        "rather than an external cache. This removes a network hop from every authenticated "
        "request and reduced p95 latency by 40ms in the prototype. Sticky sessions are "
        "configured at the load balancer so that a customer returns to the instance holding "
        "their session, and instances are drained rather than terminated during deployment."
    )
    b.h2("2.4", "Architecture Decisions")
    b.body(
        "Significant decisions are recorded as Architecture Decision Records in the solution "
        "repository, alongside the source code. Each records the context, the decision, the "
        "alternatives considered and the consequences, and carries a status of proposed, "
        "accepted or superseded. Fourteen ADRs have been accepted to date."
    )

    b.h1("3.", "Data Design")
    b.h2("3.1", "Source of Truth")
    b.body(
        "Customer master data remains owned by the CRM, and account balances by the billing "
        "engine. The portal holds no master data of its own. Both are consumed through the "
        "enterprise integration platform; the portal maintains a read-only projection for "
        "query performance, clearly labelled as a derived copy and rebuilt nightly."
    )
    b.h2("3.2", "Physical Model")
    b.body(
        "The projection store is PostgreSQL. The physical model follows the team's established "
        "convention, carried over from the existing portal to minimise migration effort:"
    )
    b.table(
        Table(
            ["Object Type", "Convention", "Example"],
            [
                ["Table", "PascalCase, plural noun", "CustomerOrders"],
                ["Column", "camelCase", "orderDate"],
                ["Primary Key", "Id", "Id"],
                ["Foreign Key", "<Entity>Id", "CustomerId"],
                ["Index", "IX_<Table>_<Column>", "IX_CustomerOrders_OrderDate"],
            ],
            widths=[1.0, 1.5, 1.4],
        )
    )
    b.h2("3.3", "Formats")
    b.body(
        "All timestamps are stored and exchanged in ISO 8601 with an explicit UTC offset. "
        "Monetary amounts carry an ISO 4217 currency code and are stored to four decimal "
        "places. All text is UTF-8 end to end."
    )

    b.h1("4.", "Security")
    b.h2("4.1", "Authentication")
    b.body(
        "Customers authenticate against the customer identity provider using OpenID Connect. "
        "All administrative access to the portal, its infrastructure and its data stores "
        "requires multi-factor authentication through the corporate identity provider. "
        "Administrative sessions time out after 15 minutes of inactivity. There are no shared "
        "or generic accounts in the solution."
    )
    b.h2("4.2", "Authorisation")
    b.body(
        "Authorisation uses role-based access control. Four roles are defined — Customer, "
        "Contact Centre Agent, Portal Administrator and Read-Only Auditor — and permissions "
        "are attached to roles rather than to individuals. Role assignment is requested "
        "through the standard access request workflow and approved by the service owner."
    )
    b.h2("4.3", "Transport and Storage Encryption")
    b.body(
        "All external traffic terminates TLS 1.3 at the gateway. Service-to-service traffic "
        "inside the cluster uses mutual TLS. TLS 1.0 and 1.1, and all cipher suites below the "
        "approved baseline, are explicitly disabled at the gateway. Data at rest in the "
        "projection store is encrypted using the platform's managed encryption. Encryption "
        "keys are held in the cloud key management service, separate from the data, and "
        "rotated annually. No key material appears in source control or configuration."
    )
    b.h2("4.4", "Application Security Testing")
    b.body(
        "Static analysis and dependency scanning run on every pull request and block the merge "
        "on any high or critical finding. A threat model was produced during design and is "
        "reviewed each quarter. Input validation is applied at the API boundary against the "
        "OpenAPI schema, and output encoding is applied in the front end. Rate limiting is "
        "enforced at the gateway at 120 requests per minute per customer."
    )

    b.h1("5.", "Integration")
    b.h2("5.1", "Patterns")
    b.body(
        "The portal integrates with the CRM and the billing engine through the enterprise "
        "integration platform using synchronous REST for query operations. Outage reports are "
        "published as events to the enterprise event backbone for the outage management system "
        "to consume. There are no direct database connections from the portal to any system of "
        "record."
    )
    b.h2("5.2", "Failure Handling")
    b.body(
        "Outbound calls to the integration platform are wrapped in a circuit breaker with a "
        "two-second timeout. Failed calls are retried three times with exponential backoff. "
        "Where the billing engine is unavailable, the portal serves the last known balance from "
        "the projection with a staleness indicator shown to the customer."
    )

    b.h1("6.", "Deployment and Operations")
    b.h2("6.1", "Packaging")
    b.body(
        "Each service is packaged as an OCI container image built from the approved corporate "
        "base image. Images are scanned in the build pipeline and rejected on any high or "
        "critical vulnerability. Images are immutable and promoted unchanged between "
        "environments; all configuration is injected at runtime from the platform's "
        "configuration and secret stores."
    )
    b.h2("6.2", "Observability")
    b.body(
        "All services emit structured JSON logs. A correlation identifier is generated at the "
        "gateway and propagated across every downstream call using the W3C traceparent header, "
        "so a single customer interaction can be followed end to end. Business and technical "
        "metrics are exposed in Prometheus format and dashboarded in Grafana. Distributed "
        "traces are collected via OpenTelemetry. Customer identifiers are masked in all log "
        "output."
    )
    b.h2("6.3", "Availability")
    b.body(
        "The solution is deployed across three availability zones behind a regional load "
        "balancer, with no single points of failure in the request path. The target "
        "availability is 99.9%, agreed with the service owner."
    )

    b.h1("7.", "Open Items")
    b.bullets(
        [
            "Confirm the retention period for portal audit logs with the records team",
            "Agree the approach for customer data subject access requests",
            "Complete performance testing at projected peak (winter outage scenario)",
        ]
    )
    b.save(path)


def field_telemetry(path: str) -> None:
    """Weaker: several direct contradictions and larger silences."""
    b = Builder("Field Telemetry Ingestion Platform — SAD", "Internal Use")
    b.cover(
        "Digital Operations",
        "Field Telemetry Ingestion Platform",
        "Solution Architecture Document",
        "SAD-FTIP-2026-031  V-0.4",
        "09/07/2026",
    )
    b.new_page()
    b.revision_history(
        [["0.4", "2026-07-09", "K. Nwosu", "Draft for architecture review"]]
    )

    b.h1("1.", "Solution Overview")
    b.body(
        "The Field Telemetry Ingestion Platform collects measurement data from approximately "
        "310,000 field devices — smart meters, substation sensors and line monitors — and "
        "makes it available for operational analytics, outage prediction and regulatory "
        "reporting. Peak ingestion is roughly 45,000 messages per second during a network "
        "event."
    )
    b.body(
        "The platform replaces a set of per-region collection scripts with a single ingestion "
        "pipeline. It is a greenfield build on the operations Kubernetes estate."
    )

    b.h1("2.", "Architecture")
    b.h2("2.1", "Ingestion Path")
    b.body(
        "Devices publish to a regional MQTT broker over the private cellular APN. A set of "
        "ingestion workers subscribes to the broker, validates each payload, normalises units "
        "and writes to the time-series store. The workers hold no state between messages and "
        "scale horizontally on queue depth; any worker can be terminated at any point without "
        "loss of in-flight work, as unacknowledged messages return to the broker."
    )
    b.h2("2.2", "Transport")
    b.body(
        "Telemetry is transmitted over plain MQTT without transport encryption. The devices "
        "are battery-constrained and the TLS handshake measurably shortens field life; the "
        "cellular APN is a private network isolated from the public internet, which we consider "
        "sufficient protection for measurement data. Device authentication uses a per-device "
        "pre-shared key issued at commissioning."
    )
    b.h2("2.3", "Analytics Access")
    b.body(
        "The analytics service requires customer account context to attribute consumption. It "
        "connects directly to the billing system's Oracle database using a dedicated read-only "
        "account and a nightly query against the account and premise tables. This avoids the "
        "latency of the integration platform and was agreed with the billing team as a "
        "pragmatic interim measure."
    )

    b.h1("3.", "Data Design")
    b.h2("3.1", "Message Format")
    b.body(
        "Payloads are JSON. The schema is documented on the team wiki. Fields are added as new "
        "device types are onboarded; consumers are expected to ignore fields they do not "
        "recognise. There is no schema registry and no version field in the payload — the "
        "team's view is that additive-only changes make versioning unnecessary."
    )
    b.h2("3.2", "Classification and Retention")
    b.body(
        "Telemetry is classified Internal. Raw messages are retained in the time-series store "
        "for 90 days, after which they are aggregated to hourly summaries and the raw records "
        "are deleted by an automated purge job. Aggregates are retained for seven years to meet "
        "the regulatory reporting obligation. Deletion is logged and the job's output is "
        "retained for audit."
    )
    b.h2("3.3", "Physical Model")
    b.table(
        Table(
            ["Object Type", "Convention", "Example"],
            [
                ["Table", "snake_case, plural noun", "device_readings"],
                ["Column", "snake_case, singular noun", "reading_timestamp"],
                ["Index", "ix_<table>_<columns>", "ix_device_readings_device_id"],
            ],
            widths=[1.0, 1.5, 1.4],
        )
    )

    b.h1("4.", "Failure Handling")
    b.body(
        "Messages that fail schema validation are written to the application log with the "
        "offending payload and discarded, so that a malformed device firmware release cannot "
        "back up the pipeline. Transient write failures against the time-series store are "
        "retried twice; if both retries fail the message is dropped and a counter is "
        "incremented."
    )
    b.body(
        "Duplicate delivery is possible because the broker guarantees at-least-once. The "
        "ingestion worker writes using the device identifier and reading timestamp as a "
        "compound key, so a repeated message overwrites rather than duplicates."
    )

    b.h1("5.", "Deployment and Operations")
    b.h2("5.1", "Packaging")
    b.body(
        "Workers are packaged as container images and deployed to the operations Kubernetes "
        "cluster via the standard pipeline. Configuration is supplied through environment "
        "variables and Kubernetes secrets."
    )
    b.h2("5.2", "Monitoring")
    b.body(
        "Workers write plain-text log lines to standard output, which the platform's default "
        "collector forwards to the central log store. Queue depth and message throughput are "
        "exported as metrics and alert on threshold."
    )
    b.h2("5.3", "Availability")
    b.body(
        "The platform runs across two availability zones. Brief ingestion outages are tolerable "
        "because devices buffer locally for up to four hours and replay on reconnection."
    )

    b.h1("6.", "Open Items")
    b.bullets(
        [
            "Agree the long-term approach for account attribution with the billing team",
            "Assess whether device firmware can support TLS within the battery budget",
            "Confirm the operational owner for the ingestion pipeline",
        ]
    )
    b.save(path)
