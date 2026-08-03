# AIDP — what the product is

Status: working understanding · 2 August 2026
Derived from the four documents the client sent. Points marked ⚠ are inference
awaiting confirmation.

---

## In one sentence

**AIDP turns the client's enterprise standards from documents nobody can enforce
into an automatic gate that every solution design, vendor submission, and
existing system is checked against.**

---

## Who — confirmed 2 Aug 2026

Our client is an **advisory / consulting firm serving multiple enterprise
customers**. AIDP is built for them. Each of their customers is an organisation
with its own standards library.

```
The consultancy            our client, pays for AIDP
 └── Organisation          their customer, e.g. Meralco   ← hard tenant boundary
      ├── Framework        that customer's own standards
      │                    (+ optional baseline filling gaps)
      └── Project
           └── Submission  a design doc / SAD
                └── Assessment run → findings
```

**Organisation is the tenant boundary.** One customer's Internal-Use standards
must never surface in another's assessment.

### What the four sample documents are

Meralco's Architecture and Design Guidelines is **one customer's framework** — a
`V-0.1` internal draft, visibly unfinished. The other three are the consultancy's
**baseline framework**: unfilled, generic, and applicable to any customer.

The baseline maps onto Meralco's holes almost exactly, which is what makes it
useful:

| Meralco's guidelines | Baseline template |
|---|---|
| §3 Cybersecurity — **empty** | Security Standards, 26pp, 15 sections |
| §4 Data Guidelines — 4 principles | Data Standards, 23pp, 12 sections |
| No solution-architecture coverage | Solution Architecture Standards, 27pp |

So a customer's **effective framework** = their own standards, plus baseline
clauses filling the gaps. Findings should record which layer a clause came from —
"your own standard" carries different weight in a review than "industry
baseline."

---

## The problem

Across the four documents there are roughly **120 standards carrying close to 400
individual requirements**, and their own rules say all of them apply:

> *"All new and existing systems must be assessed against these standards"*
> — Data Standards §12
>
> *"Solution designs of significant scope or risk must be reviewed and approved
> by an Architecture Review Board prior to implementation"*
> — Solution Architecture §2.1
>
> *"Security requirements must be integrated into project and procurement
> approval gates"* — Security §2.1

Today that check is a human with a PDF. An architect reads a 60-page vendor
design while holding 400 requirements in their head. It takes days per
submission, differs between reviewers, and in practice most requirements are
never checked — people check the ten they remember.

**The standards exist. The enforcement doesn't.** That gap is the product.

---

## How it gets used

**1 · Onboard a customer organisation.** A consultant creates the organisation
and uploads that customer's standards documents. AIDP breaks them into individual
clauses, each with an identity, heading path, and requirements, and reports what
the framework does *not* cover — which is where baseline clauses get layered in.
The library becomes structured data instead of PDFs on SharePoint.

**2 · Run an assessment.** A project design lands — authored by the customer's
internal team, a third-party supplier, or the consultancy itself. Someone drops
it in and hits assess. AIDP checks it against that customer's whole framework and
produces a report before a human reads a page:

| Standard | Verdict | Evidence |
|---|---|---|
| Security §3.2 — MFA for administrative access | **Absent** | No mention of MFA in the design |
| SolArch §3.5 — Statelessness | **Contradicts** | Design §4.2 puts session state in application memory |
| Data Standards §4.2 — Naming conventions | **Contradicts** | Schema uses `customerOrders`; standard requires `customer_orders` |
| Data Standards §9.3 — Resilience and idempotency | **Partial** | Retries specified, no dead-letter path |
| SolArch §4.3 — Containerization | **Covered** | Design §6.1 specifies OCI images, externalised config |

Every row cites the clause and the page in the submitted document. The architect
stops being a search engine and becomes a reviewer — confirming and overriding
findings rather than hunting for them.

**3 · Review and decide.** The architect works the findings queue. Confirmed
findings become the ARB pack. Their standards require exceptions to be
*"formally requested, risk-assessed, time-bound"* — so an override carrying a
rationale and an expiry date **is** the exception register, attached to the exact
clause it deviates from. That is a spreadsheet today.

**4 · Ask it things.** *"What's our minimum password length?"* → *12 characters,
14+ for privileged accounts — Security Standards §3.2.* Highest-frequency use,
least glamorous. Today this interrupts an architect or gets guessed.

**5 · Assess what already runs.** Same engine pointed at documentation for
existing systems, producing the remediation register §12 requires.

**6 · Audit their own standards.** Find what's missing from their own library,
and internal contradictions — their Integration principle 3 prohibits
point-to-point database connections while their own context diagram shows direct
app-to-app arrows.

---

## Users

| Role | Side | Uses it to |
|---|---|---|
| Consultant / engagement lead | Consultancy | Onboard customers, run assessments, produce the report |
| Delivery architect | Consultancy | Self-check own designs against the customer's rules before submitting |
| Enterprise Architecture | Customer | Own the standards library; see its coverage gaps ⚠ |
| Architecture Review Board | Customer | Approve on evidence; hold the exception register ⚠ |
| Third-party supplier | Customer's supplier | Self-check a design before submitting it ⚠ |

⚠ = unconfirmed whether customer-side users get direct access, or everything is
mediated by the consultancy. Changes whether AIDP needs external-user invitation
and per-role redaction.

---

## What it is not

It answers questions, but it is **not a chatbot** — nobody has to ask anything
for it to produce value; it runs the whole checklist itself. It stores documents
but is not a document store. It does not write policy; it measures against
policy.

The distinction drives the build. A chatbot is judged on whether the answer reads
well. This is judged on whether a "compliant" verdict survives an audit.

---

## Consequences for the build

1. **Retrieval runs backwards.** The reference clause is the query, not the user.
   For each of ~120 clauses, search the assessed document and classify. Nobody
   types anything. This is why chunking must be clause-atomic — a Requirements
   bullet severed from its Statement is a useless probe.
2. **A fifth worker stage: analyse.** Parse → chunk → embed → **analyse** →
   findings. See [build-plan.md](./build-plan.md).
3. **Documents have a role.** `reference` stops after embed; `assessed`
   continues into analyse.
4. **Citations are non-negotiable.** An ARB will not accept an uncited assertion,
   and their standards demand traceability.
5. **Absence is the hard verdict.** Proving a requirement is unaddressed means
   proving retrieval didn't just miss it. Never assert `absent` on weak recall —
   emit `needs_review`.
6. **We are inside our own product's scope.** All four documents say they bind
   *"internal teams, contractors, and external vendors."* AIDP must pass the ARB
   and a vendor security assessment to ship.

---

## Open questions

Resolved 2 Aug 2026: the client is an advisory firm serving many enterprise
customers, and assessments run *project design → that customer's standards*.

Still open:

1. **Do customer-side users get direct access,** or is everything mediated by the
   consultancy? Decides whether we need external invitation, per-role redaction,
   and a supplier self-check surface. Affects Phase 6, not Phase 1.
2. **Is the Technology Stack form per organisation or per project?** Onboarding
   profile for a customer, or intake context for each engagement. Currently
   one-per-user-account, which is wrong either way. **Blocks the Phase 1 schema.**
3. **Is the baseline framework applied by default, or opted into per customer?**
   And should findings visibly separate "your own standard" from "industry
   baseline"? Recommend yes — they carry different weight in a review.
4. **Cross-customer benchmarking** — is *"how many of our customers mandate
   MFA?"* a wanted feature? Real value for an advisory firm, but it punches
   through the tenant wall and needs deliberate governance. Not now; design so it
   stays possible.

---

## One-line pitch

> *Your standards say every design must be assessed against them. AIDP does that
> assessment in minutes instead of days, checks all 400 requirements instead of
> the ten people remember, and cites every finding to the page — so the ARB
> reviews evidence rather than hunting for it.*
