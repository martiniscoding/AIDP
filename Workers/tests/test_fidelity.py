"""Conclusions checked against the clause they claim to rest on.

Every case here was taken from one real run: standard1 against the Wellness
Station GCP design, run cmv88yx6m0000z4uy0vcoc6pn, 26 findings. The clause text
is quoted from the database, not invented for the test, so a case failing means
the engine has regressed against the actual source material.

What that run got wrong, and what each case pins down:

  1. §4 Workload Placement Criteria says Dell + VMware and Huawei "shall be
     assessed as the primary platform preference" and that "Other platforms
     shall apply when mandatory placement requirements or approved exceptions
     are present". The finding read `contradicts` at 0.9: "it must use Dell +
     VMware or Huawei Cloud Stack unless exceptions are approved". A framework
     for choosing had become a mandate.
  2. §5.6 governs "workloads with an approved target platform". The finding read
     `covered`: "specifies GKE ... thus meeting the clause's requirement for
     approved platform-specific deployment". Specified had become approved.
  3. §8.1 requires compliance with "governance, cybersecurity, identity, data
     protection, network connectivity, resiliency, and regulatory
     requirements" — seven families. The finding read `covered` on zoning,
     firewalls and identity, "implying compliance".

The guards are tested through `analyse._guard`, which is where a verdict is
actually decided, rather than through the fidelity predicates alone — the thing
worth proving is the final status a reviewer sees.

No database and no model.

    docker run --rm -v "$PWD":/repo -w /repo/Workers -e STAGE=analyse \
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \
      --entrypoint python workers-analyse tests/test_fidelity.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import fidelity  # noqa: E402
from aidp.stages import analyse  # noqa: E402

passed = 0
failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name}", extra)


def quote(text: str) -> dict:
    """One cited passage, shaped as the evidence list carries it."""
    return {"chunkId": f"c{abs(hash(text)) % 10000}", "excerpt": text, "sourceKind": "clause"}


def guard(verdict: str, rationale: str, clause: str, evidence: list[dict], confidence: float = 0.9):
    return analyse._guard(
        verdict,
        confidence,
        evidence,
        1.0,  # strong retrieval, so only the fidelity checks can move this
        rationale,
        cited_total=len(evidence),
        clause_text=clause,
    )


# ---- the real clause text, as stored ------------------------------------------

CLAUSE_4 = (
    "Title: Workload Placement Criteria\n"
    "Statement: The following workload characteristics shall be used to determine the "
    "preferred deployment platform.\n"
    "Requirements:\n"
    "- Dell + VMware Infrastructure and Huawei Cloud Stack shall be assessed as the "
    "primary platform preference.\n"
    "- Other platforms shall apply when mandatory placement requirements or approved "
    "exceptions are present."
)
CLAUSE_56 = (
    "Title: Approved Platform-Specific Deployments\n"
    "Statement: Workloads with an approved target platform or designated infrastructure "
    "model shall be treated as platform-specific deployments.\n"
    "Requirements:\n"
    "- Approved platform-specific deployments shall not default to Dell + VMware or "
    "Huawei Cloud Stack solely based on general workload classification when a confirmed "
    "solution architecture, vendor certification, regulatory requirement, or support "
    "model requires a specific platform."
)
CLAUSE_81 = (
    "Title: Public Cloud Deployment Guidance\n"
    "Statement: Public cloud shall be considered when the workload is customer-facing, "
    "externally accessible, elastic, or dependent on public cloud-native capabilities.\n"
    "Requirements:\n"
    "- Public cloud deployment must comply with applicable cloud governance, "
    "cybersecurity, identity, data protection, network connectivity, resiliency, and "
    "regulatory requirements."
)

print("\nCase 1 — a placement clause that mandates no platform")
verdict, rationale = guard(
    "contradicts",
    "The design specifies GKE and Google Cloud technologies, not Dell + VMware or Huawei "
    "Cloud Stack as primary platforms, violating the clause's mandatory platform "
    "preference; it must use Dell + VMware or Huawei Cloud Stack unless exceptions are "
    "approved.",
    CLAUSE_4,
    [quote("GKE hosts the kiosk services."), quote("Cloud SQL stores member records.")],
)
ok("the confirmed breach does not stand", verdict != "contradicts", verdict)
ok("it becomes a non-confirmed status", verdict == "needs_review", verdict)
ok(
    "and the reason names the clause's own provision for other platforms",
    "other platforms" in rationale.lower(),
    rationale,
)
ok(
    "the model's 90% confidence does not save it",
    guard("contradicts", "it must use Dell + VMware unless exceptions are approved", CLAUSE_4,
          [quote("GKE hosts the kiosk services.")], confidence=0.99)[0] != "contradicts",
)

print("\nCase 7 — a genuine mandatory violation, supported by the source")
real = (
    "Title: Data Residency\n"
    "Statement: Customer data shall not be stored outside the sovereign region. Storage "
    "outside the region is prohibited."
)
verdict, _ = guard(
    "contradicts",
    "Member records are replicated to us-east-1; the design must use an in-region store.",
    real,
    [quote("Cloud SQL replicates member records to us-east-1.")],
)
ok("a clause that really restricts still produces a breach", verdict == "contradicts", verdict)
ok(
    "and the predicate itself stands down on it",
    fidelity.overreaches("the design must use an in-region store", real) is None,
)

print("\nCase 2 — a named platform with no approval evidence")
verdict, rationale = guard(
    "covered",
    "The design specifies GKE (Google Kubernetes Engine) as the container platform, not "
    "defaulting to Dell+VMware or Huawei Cloud Stack, thus meeting the clause's "
    "requirement for approved platform-specific deployment.",
    CLAUSE_56,
    [quote("GKE is the container platform for kiosk services.")],
)
ok("naming the technology is not a pass", verdict != "covered", verdict)
ok("it becomes not_assessable, not a breach", verdict == "not_assessable", verdict)
ok(
    "and the reason says what record is missing",
    "approval" in rationale.lower() or "approved" in rationale.lower(),
    rationale,
)
ok(
    "the clause's own word 'approved' quoted back does not count as evidence",
    fidelity.needs_approval_evidence(
        CLAUSE_56, "GKE is the container platform.", "meets the approved platform requirement"
    )
    is not None,
)

print("\nCase 8 — a valid covered, with the approval actually quoted")
verdict, _ = guard(
    "covered",
    "GKE is the target platform under architecture board decision ARB-2291, which "
    "records the approved deployment model.",
    CLAUSE_56,
    [quote("GKE is the approved target platform per architecture review board decision ARB-2291.")],
)
ok("a design that shows the record passes", verdict == "covered", verdict)
ok(
    "and a clause with no approval qualifier is never asked for one",
    fidelity.needs_approval_evidence(
        "Statement: Services shall emit structured logs.", "The app logs to Cloud Logging.", ""
    )
    is None,
)

print("\nCase 3 — a compound requirement with partial evidence")
verdict, rationale = guard(
    "covered",
    "Design uses GCP public cloud for customer-facing kiosks with network zoning, "
    "firewalls, and identity management, implying compliance with cloud governance and "
    "security requirements.",
    CLAUSE_81,
    [
        quote("Network zoning and firewalls separate the kiosk tier."),
        quote("GCDS provides identity for staff access."),
    ],
)
ok("seven families are not covered by three", verdict != "covered", verdict)
ok("it becomes partial, not a breach and not a gap", verdict == "partial", verdict)
for family in ("data protection", "resiliency", "regulatory"):
    ok(f"the reason names the unaddressed “{family}”", family in rationale.lower(), rationale)
compound = fidelity.controls(CLAUSE_81, "Network zoning and firewalls. GCDS identity.", "")
ok("all seven families are detected", len(compound.families) == 7, compound.families)
ok("and it is recognised as compound", compound.is_compound)
ok(
    "a sentence that merely mentions two families is not compound",
    not fidelity.controls(
        "Statement: Logs shall be retained with appropriate security.", "", ""
    ).is_compound,
)

print("\nCase 3b — a compound requirement with every family evidenced")
verdict, _ = guard(
    "covered",
    "Governance board sign-off, cybersecurity controls, identity via GCDS, data "
    "protection by CMEK encryption, network connectivity over interconnect, resiliency "
    "through multi-zone availability, and regulatory compliance are each documented.",
    CLAUSE_81,
    [quote("The platform documents governance, security, identity, encryption, "
           "connectivity, availability and regulatory compliance.")],
)
ok("a fully evidenced compound requirement still passes", verdict == "covered", verdict)

print("\nCase 5 — missing documentation is not a missing component")
# The distinction the vocabulary now carries: "absent" is the design never
# engaging the mechanism; "not_assessable" is engaging it without the record.
ok(
    "a clause about an approval, answered with no record, is not_assessable",
    guard("covered", "GKE is specified as the platform.", CLAUSE_56,
          [quote("GKE runs the kiosk services.")])[0] == "not_assessable",
)
ok(
    "while a clause whose mechanism is untouched stays absent",
    guard("absent", "No extract mentions capacity expansion triggers or utilisation "
          "thresholds.", "Statement: Capacity expansion shall follow utilisation "
          "thresholds agreed with the platform owner.", [])[0] == "absent",
)
ok(
    "and an absent is not turned into a breach by either guard",
    guard("absent", "Nothing addresses this.", CLAUSE_4, [])[0] == "absent",
)

print("\nCase 6 — a recommended standard is not a company requirement")
# coverage.py has always kept these apart; this pins the property rather than
# re-implementing it. A suggestion names a standard the library does not have,
# and it is stored on the run's coverage, never as a finding.
import inspect  # noqa: E402

source = inspect.getsource(analyse)
ok(
    "nothing in the analyse stage writes a finding from a coverage suggestion",
    "suggest" not in source.split("def _write(")[1].split("def ")[0].lower(),
)
coverage_doc = " ".join((inspect.getdoc(__import__("aidp.coverage", fromlist=["x"])) or "").split())
ok(
    "and coverage states the rule in its own contract",
    "never a requirement on a design" in coverage_doc,
    coverage_doc[:200],
)

print("\nAn approved catalogue item is not an approval record")
# Four real false positives from the answer key, which an earlier version of the
# approval guard failed. The distinction is what the qualifier lands on: §5.6's
# "workloads with an approved target platform" makes the approval the gate on the
# clause, while these name an item from a standing list the organisation keeps.
# Demanding a per-design approval record for a base image is nonsense.
for clause_text, why in (
    ("Statement: Application components must be packaged as portable container images. "
     "Requirements: Images must be built from an approved base image",
     "an approved base image"),
    ("Statement: All database objects must follow the documented naming convention. "
     "Requirements: Names must be descriptive, in English, and use approved abbreviations only",
     "approved abbreviations"),
    ("Statement: All data must be retained and archived according to the periods defined "
     "below, based on legal, regulatory and business requirements. Certified copies are held.",
     "a stray 'Certified' with no governed noun"),
    ("Statement: Integrations shall use services from the approved service catalogue.",
     "an approved catalogue"),
):
    ok(f"no approval record is demanded for {why}",
       fidelity.needs_approval_evidence(clause_text, "We use the standard base image.", "") is None,
       fidelity.needs_approval_evidence(clause_text, "We use the standard base image.", ""))

ok(
    "while the clause whose gate IS approval still demands it",
    fidelity.needs_approval_evidence(CLAUSE_56, "GKE runs the kiosks.", "") is not None,
)

print("\nFamily words scattered over a clause are not an enumeration")
# A key-management clause counted as five control families because its statement
# said "encryption", its rationale said "compromised together" and a later
# requirement mentioned retention. Only a list in one breath is a list.
key_management = (
    "5.2 Key Management Statement: Cryptographic keys must be generated, stored, rotated "
    "and retired through a dedicated key management process, separate from the data they "
    "protect. Rationale: Keys stored alongside the data they protect undermine encryption "
    "entirely if compromised together. Requirements: Keys must be held in a dedicated key "
    "management service or hardware security module."
)
ok(
    "a key-management clause is not a compound governance requirement",
    not fidelity.controls(key_management, "", "").is_compound,
    fidelity.controls(key_management, "", "").families,
)
ok(
    "but one sentence listing seven families is",
    len(fidelity.controls(CLAUSE_81, "", "").families) == 7,
    fidelity.controls(CLAUSE_81, "", "").families,
)
ok(
    "and three families with no separator between them is not a list",
    not fidelity.controls(
        "Statement: Governance applies. Security applies. Identity applies.", "", ""
    ).is_compound,
)

print("\nConfidence cannot buy any of these")
for verdict_in, clause, ev in (
    ("contradicts", CLAUSE_4, [quote("GKE hosts the kiosks.")]),
    ("covered", CLAUSE_56, [quote("GKE is the container platform.")]),
    ("covered", CLAUSE_81, [quote("Firewalls and zoning are in place.")]),
):
    got, _ = guard(
        verdict_in,
        "it must use Dell + VMware unless exceptions are approved"
        if verdict_in == "contradicts"
        else "GKE is specified, implying compliance with governance and security.",
        clause,
        ev,
        confidence=1.0,
    )
    ok(f"{verdict_in} at 100% confidence is still corrected to {got}", got != verdict_in, got)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
