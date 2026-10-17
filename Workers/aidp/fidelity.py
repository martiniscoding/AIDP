"""Does the conclusion say more than the clause does?

Three failures, all found in one real run of standard1 against a GCP design,
all the same shape: the model reached a conclusion the source clause does not
support, and nothing checked the conclusion against the source.

**The restriction nobody wrote.** §4 Workload Placement Criteria says "Dell +
VMware Infrastructure and Huawei Cloud Stack shall be *assessed as the primary
platform preference*" and "Other platforms shall apply when mandatory placement
requirements or approved exceptions are present". The finding said the design
"must use Dell + VMware or Huawei Cloud Stack unless exceptions are approved",
and graded it `contradicts` at 0.9. A clause that tells you to *assess* a
preference had become a clause that *mandates* a platform — the rationale even
wrote "mandatory platform preference", which is not a thing.

**Specified read as approved.** §5.6 applies to "workloads with an *approved*
target platform". The finding said the design "specifies GKE ... thus meeting
the clause's requirement for approved platform-specific deployment" — `covered`.
Naming a technology is not being approved to use it, and the clause's own
precondition was never evidenced.

**Seven controls, three quotes.** §8.1 requires public cloud deployment to
"comply with applicable cloud governance, cybersecurity, identity, data
protection, network connectivity, resiliency, and regulatory requirements". The
finding was `covered` on zoning, firewalls and identity management, "implying
compliance" — three families of seven, with data protection, resiliency and
regulatory never mentioned.

Everything here is deterministic and reads only the clause's own words and the
model's own output. Nothing is special-cased to a clause, a platform or a
vendor: the signals are the vocabulary standards use for preference, for
approval and for enumerated control families. A guard fires or it does not, and
when it fires it says which words in the clause it read.

Used by `_guard` in stages/analyse.py, which demotes rather than rewrites — the
engine never upgrades a verdict on the strength of these.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# ---------------------------------------------------------------- P1: overreach

# What a conclusion looks like when it asserts that one option is the only
# permitted one. These are the phrasings the model actually produced, plus their
# obvious neighbours. "unless ... approved" is here because it is the tell: it
# describes a rule with an exception process, which is a mandate, not a
# preference.
_EXCLUSIVE = re.compile(
    r"\b(?:"
    r"must (?:use|be (?:used|deployed|hosted|placed)|run on)"
    r"|must not use"
    r"|required to use"
    r"|only (?:permitted|allowed|approved)"
    r"|mandator(?:y|ily) (?:platform|use|deploy)"
    r"|not permitted to use"
    r"|shall (?:use|not use)"
    r"|unless (?:an? )?(?:exception|waiver|approval)s?"
    r" (?:is|are|has been|have been)? ?(?:approved|granted|obtained)"
    r"|violat\w+ the clause's mandatory"
    r")\b",
    re.IGNORECASE,
)

# What a clause looks like when it expresses a leaning rather than a rule. A
# clause may say "shall" and still only be ordering you to *assess* something —
# "shall be assessed as the primary platform preference" is an instruction to
# weigh, not an instruction to choose.
_PREFERENTIAL = re.compile(
    r"\b(?:"
    r"preference|preferred|preferentially"
    r"|shall be (?:assessed|considered|evaluated|weighed)"
    r"|should be (?:assessed|considered|evaluated|preferred)"
    r"|shall be used to determine"
    r"|may be (?:selected|chosen|considered)"
    r"|better fit|best fit|more suitable|suitability"
    r"|primary (?:platform )?(?:preference|option|choice)"
    r"|where (?:appropriate|suitable|applicable)"
    r")\b",
    re.IGNORECASE,
)

# What a clause looks like when it really does restrict. Deliberately narrow:
# every one of these restricts *behaviour*, so none of them can be satisfied by a
# clause that merely uses the word in passing.
#
# "mandatory" is NOT in here on its own, and that omission is the whole lesson of
# §4. It reads "Other platforms shall apply when mandatory placement requirements
# or approved exceptions are present" — where "mandatory" qualifies a *kind of
# requirement that lets you use something else*. Treating the bare word as
# restrictive stood the guard down on the one clause it was written for. It
# counts only where it qualifies use.
_RESTRICTIVE = re.compile(
    r"\b(?:"
    r"only|solely|exclusively|no other"
    r"|shall not (?:use|be (?:used|deployed|hosted|placed|provisioned))"
    r"|must not (?:use|be (?:used|deployed|hosted|placed|provisioned))"
    r"|prohibit\w*|forbid\w*|restricted to|limited to|confined to"
    r"|is not permitted|are not permitted|not permissible"
    r"|mandator\w+ (?:to use|platform|use|deployment target)"
    r"|use (?:is|shall be) mandator\w+"
    r"|in all cases|without exception"
    r")\b",
    re.IGNORECASE,
)

# A clause that provides for alternatives cannot be a clause that permits only
# one thing. This is the strongest signal there is, and it outranks any
# restrictive-sounding word elsewhere in the text — §4 carries both, and the
# provision for other platforms is what it actually means.
_ADMITS_ALTERNATIVES = re.compile(
    r"\b(?:"
    r"other platforms?|alternative platforms?|another platform"
    r"|other (?:options?|environments?|infrastructure)"
    r"|shall apply when|may apply when|applies? where"
    r"|approved exceptions?|mandatory placement requirements?"
    r"|requires? a specific platform"
    r"|unless|where (?:a |an )?(?:confirmed|vendor|regulatory|support)"
    r")\b",
    re.IGNORECASE,
)


def overreaches(rationale: str, clause_text: str) -> str | None:
    """Why this conclusion claims more than the clause does, or None.

    Read in this order, because the order is what the real clause taught:

    1. The conclusion must assert that one option is the only permitted one.
       Nothing else is an overreach of this kind.
    2. A clause that provides for alternatives is not a clause that permits one
       thing, whatever else it says. §4 says "Other platforms shall apply when
       mandatory placement requirements or approved exceptions are present", and
       an earlier version of this guard stood down on the stray "mandatory" and
       let the bad finding through.
    3. Otherwise a clause that unambiguously restricts behaviour supports the
       conclusion and is left alone — which is what keeps a genuine mandatory
       violation reportable.
    4. Otherwise, a clause that speaks in preferences does not support it.
    """
    if not _EXCLUSIVE.search(rationale):
        return None

    alternatives = _ADMITS_ALTERNATIVES.search(clause_text)
    if alternatives:
        return (
            f"Concluded that one platform is required, but the clause provides for others "
            f"(“{alternatives.group(0)}”). A preference with exceptions is not a mandate."
        )

    if _RESTRICTIVE.search(clause_text):
        return None

    leaning = _PREFERENTIAL.search(clause_text)
    if not leaning:
        return None
    return (
        f"Concluded a platform restriction the clause does not state — it speaks of "
        f"“{leaning.group(0)}”, not of a requirement to use one."
    )


# ------------------------------------------- a breach that is really a silence

# "The document does not say." Every one of these describes a thing the design
# failed to *record*, not a thing it does.
_HEDGE = re.compile(
    r"\b(?:"
    r"does not confirm|do not confirm|not confirmed"
    r"|lacks? (?:documented|evidence|confirmation)"
    r"|no (?:documented|evidence of)"
    r"|not (?:documented|evidenced|stated|specified|demonstrated)"
    r")\b",
    re.IGNORECASE,
)

# What the design *does*, said in the active voice. A rationale carrying one of
# these is describing behaviour, and behaviour can breach a clause however much
# paperwork is also missing: "uses one undifferentiated code unit and lacks
# documented approval" is a real contradiction, and only the first half is why.
_AFFIRMATIVE = re.compile(
    r"\b(?:"
    r"uses?|stores?|shares?|runs?|allows?|exposes?|writes?|manipulates?|sends?"
    r"|keeps?|places?|deploys?|queries|querying|accesses|replicates?|routes?"
    r"|lacks (?:logs|metrics|monitoring|alerts?|health|resilience|failover"
    r"|authentication|authorisation|authorization|encryption)"
    r")\b",
    re.IGNORECASE,
)


def hedged_breach(rationale: str) -> str | None:
    """Why this "contradicts" is really a silence, or None.

    A document that does not say is not a document that breaches. Both judge
    prompts say so — rule 3c — and a cheap model still answers "contradicts"
    over a reason that is entirely about a missing record: "the designs mention
    scaling mechanisms but *do not confirm* capacity expansion decisions are
    triggered by utilisation", "operational readiness *is not confirmed* before
    final approval". Three of eighteen contradictions on one real run.

    The distinction that matters is whether the design is described as *doing*
    something. "Uses one undifferentiated code unit and lacks documented
    approval" breaches on its first clause and would be wrong to demote; "does
    not confirm X" states nothing the design does at all.

    Only the first sentence is read. The judge is asked for gap, impact and fix
    in that order, and the fix sentence always says what is missing — testing
    the whole rationale would demote every finding that proposes a remedy.
    """
    gap = _first_sentence(rationale)
    if not _HEDGE.search(gap):
        return None
    if _AFFIRMATIVE.search(gap):
        return None
    return (
        "Reported a breach over a record the document does not contain, not over "
        "anything the design does."
    )


def _first_sentence(text: str) -> str:
    """The gap, which is the first of the three sentences the judge writes."""
    parts = re.split(r"(?<=[.!?])\s+", text.strip(), maxsplit=1)
    return parts[0] if parts else text


# ------------------------------------------------- P2: specified is not approved

# A clause whose *subject* is qualified by one of these is a clause about work
# that has been through a governance process. The process leaves a record, and
# the record is what the design has to show.
#
# The qualifier alone is not enough, and three real false positives are why.
# "Images must be built from an approved base image", "Names must use approved
# abbreviations only" and a stray "Certified" in a retention table all tripped an
# earlier version of this. Those are catalogue items: the organisation keeps a
# list, the design satisfies the rule by picking from it, and demanding a
# per-design approval record for a base image is nonsense.
#
# What §5.6 does is different in kind — "workloads with an approved target
# platform", "Approved platform-specific deployments" — where the approval is
# what makes the clause apply to this design at all. So the qualifier has to land
# on a noun denoting the work under assessment or its placement, within a couple
# of words. A noun from a standing list does not count, however approved it is.
_GOVERNED = (
    r"workloads?|deployments?|target platforms?|platform[- ]specific"
    r"|infrastructure models?|solution architectures?|hosting (?:models?|environments?)"
    r"|placements?|exceptions?|waivers?|deviations?|dispensations?"
)
_APPROVAL_QUALIFIER = re.compile(
    r"\b(?P<word>approved|confirmed|certified|authoris(?:ed)?|authorized|designated"
    r"|sanctioned|accredited|endorsed|ratified|signed[- ]off)\b"
    r"(?:\W+\w+){0,2}?\W+(?:" + _GOVERNED + r")\b",
    re.IGNORECASE,
)

# What the record looks like when a design does carry it. Deliberately broader
# than the qualifier: a design rarely says "approved", it says "the ARB
# accepted", "waiver WR-114", "per the signed exception".
_APPROVAL_EVIDENCE = re.compile(
    r"\b(?:approv\w+|authoris\w+|authoriz\w+|certif\w+|accredit\w+|waiver|waived"
    r"|exception (?:granted|approved|record|reference)|sign(?:ed)?[- ]off|signoff"
    r"|ratified|endorsed|sanctioned|governance (?:decision|board|record)"
    r"|architecture (?:review )?board|\bARB\b|\bCAB\b|design authority"
    r"|decision record|\bADR\b|dispensation)\b",
    re.IGNORECASE,
)


def needs_approval_evidence(clause_text: str, evidence_text: str, rationale: str) -> str | None:
    """Why a "covered" here has not shown the approval the clause turns on.

    The clause qualifies its subject with "approved", "certified" or the like, so
    the thing it governs is a thing that has been through a process. Nothing in
    the cited passages records that process. A technology being named is not the
    record — which is exactly how "specifies GKE" became "meeting the clause's
    requirement for approved platform-specific deployment".
    """
    qualifier = _APPROVAL_QUALIFIER.search(clause_text)
    if not qualifier:
        return None
    # The design's own words are what count. A rationale that merely repeats the
    # clause's "approved" proves nothing, so the quotes are checked on their own
    # first, and the rationale only helps if it points at a record too.
    if _APPROVAL_EVIDENCE.search(evidence_text):
        return None
    if _APPROVAL_EVIDENCE.search(_without_clause_echo(rationale, clause_text)):
        return None
    return (
        f"The clause governs what is “{qualifier.group('word')}”, and nothing quoted records an "
        f"approval, certification or waiver. Naming the technology is not the approval."
    )


def _without_clause_echo(rationale: str, clause_text: str) -> str:
    """The rationale minus the clause's own approval words quoted back at it.

    A model that writes "meeting the clause's requirement for approved
    platform-specific deployment" has cited the clause, not the design. Dropping
    the words that only appear because the clause used them keeps the check
    honest.
    """
    echoes = {m.group("word").lower() for m in _APPROVAL_QUALIFIER.finditer(clause_text)}
    if not echoes:
        return rationale
    pattern = "|".join(re.escape(word) for word in sorted(echoes))
    return re.sub(rf"\b(?:{pattern})\b", " ", rationale, flags=re.IGNORECASE)


# ------------------------------------------- P3: compound control requirements

# The families a governance clause enumerates. Each entry is one family and the
# words that stand for it, so "cybersecurity" and "security" are one family and
# not two, and a clause naming seven of these is asking seven questions.
_FAMILIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("governance", ("governance", "governed", "stewardship")),
    ("security", ("security", "cybersecurity", "cyber security", "infosec")),
    (
        "identity",
        ("identity", "authentication", "authorisation", "authorization", "iam", "access control"),
    ),
    (
        "data protection",
        ("data protection", "data privacy", "privacy", "encryption", "data residency"),
    ),
    ("connectivity", ("connectivity", "network connectivity", "networking", "interconnect")),
    ("resiliency", ("resiliency", "resilience", "availability", "disaster recovery", "continuity")),
    ("regulatory", ("regulatory", "regulation", "compliance obligation", "statutory", "legal")),
    ("operational", ("operational", "operations", "monitoring", "support model", "escalation")),
)

# Below this a clause is not really enumerating control families, it is just a
# sentence that happens to mention two of them.
_COMPOUND_AT = 3


@dataclass(frozen=True)
class Compound:
    """A requirement that asks several independent questions."""

    families: tuple[str, ...]
    addressed: tuple[str, ...]
    missing: tuple[str, ...]

    @property
    def is_compound(self) -> bool:
        return len(self.families) >= _COMPOUND_AT


def _families_in(text: str) -> tuple[str, ...]:
    lowered = text.lower()
    found = []
    for family, words in _FAMILIES:
        if any(re.search(rf"\b{re.escape(word)}\b", lowered) for word in words):
            found.append(family)
    return tuple(found)


# One sentence. Crude on purpose: a clause's own enumeration never spans a full
# stop, and the alternative — counting family words anywhere in the clause —
# counted a key-management clause as five control families because its statement
# said "encryption", its rationale said "compromised" and a table two
# requirements later mentioned retention.
_SENTENCE = re.compile(r"(?<=[.;:])\s+|\n")

# An enumeration separates its items. A sentence naming three families without
# one of these is a sentence about a subject, not a list of requirements.
_ENUMERATED = re.compile(r",|\band\b|\bor\b", re.IGNORECASE)


def _enumeration(clause_text: str) -> tuple[str, ...]:
    """The largest run of control families the clause lists in one breath.

    What makes §8.1 compound is not that it mentions governance somewhere — it
    is that one requirement reads "governance, cybersecurity, identity, data
    protection, network connectivity, resiliency, and regulatory requirements".
    Seven questions in one sentence. That shape is what this looks for.
    """
    best: tuple[str, ...] = ()
    for sentence in _SENTENCE.split(clause_text):
        families = _families_in(sentence)
        if len(families) > len(best) and _ENUMERATED.search(sentence):
            best = families
    return best


def controls(clause_text: str, evidence_text: str, rationale: str) -> Compound:
    """Which of the clause's control families the answer actually engages.

    "Covered" on a requirement naming seven families needs all seven answered.
    The engine cannot judge each one for the model, but it can see which ones
    were never mentioned at all — and a family nobody mentioned was not assessed.
    """
    families = _enumeration(clause_text)
    shown = set(_families_in(evidence_text)) | set(_families_in(rationale))
    addressed = tuple(f for f in families if f in shown)
    return Compound(
        families=families,
        addressed=addressed,
        missing=tuple(f for f in families if f not in shown),
    )


# Subject synonyms used by the conservative alignment check below. This is a
# review trigger, not a semantic classifier: it catches passages on an entirely
# different topic while allowing common architecture vocabulary to line up.
_SUBJECT_ALIASES = (
    {"api", "interface", "endpoint"},
    {"protocol", "rest", "http", "https"},
    {"payload", "message", "schema", "format"},
    {"identity", "authentication", "authorization", "access", "iam", "mfa"},
    {"encryption", "cryptography", "tls", "cipher"},
    {"logging", "audit", "trace", "tracing", "monitoring"},
    {"privacy", "protection", "masking", "redaction"},
    {"resilience", "resiliency", "availability", "recovery", "backup"},
    {"performance", "latency", "throughput", "capacity"},
    {"retention", "lifecycle", "archive", "deletion"},
)
_SUBJECT_CANONICAL = {
    word: min(group) for group in _SUBJECT_ALIASES for word in group
}
_SUBJECT_DOMAINS = {
    "integration": frozenset({"api", "http", "format", "integration", "endpoint"}),
    "security": frozenset({"access", "cipher", "security", "authorization"}),
    "data": frozenset({"masking", "archive", "database", "record"}),
    "resilience": frozenset({"availability", "disaster", "continuity"}),
    "operations": frozenset({"audit", "monitoring", "operations", "support"}),
    "performance": frozenset({"capacity", "throughput", "performance"}),
}
_SUBJECT_STOP = frozenset(
    "a an and are as at be by can for from in into is it of on or shall that the their "
    "this to with must should may will system design requirement requirements support "
    "appropriate ensure define provide implement use using".split()
)


def _subject_terms(text: str) -> set[str]:
    return {
        _SUBJECT_CANONICAL.get(word, word)
        for word in re.findall(r"[a-z0-9]+", text.casefold())
        if len(word) > 2 and word not in _SUBJECT_STOP
    }


def subject_mismatch(clause_text: str, evidence_text: str) -> str | None:
    """Flag cited text with no recognizable subject overlap with the clause.

    This deliberately errs on the side of asking for human review. It never
    decides whether a requirement is satisfied and it permits semantic
    paraphrases when they share a recognized architecture term.
    """
    required = _subject_terms(clause_text)
    cited = _subject_terms(evidence_text)
    if len(required) < 2 or len(cited) < 2 or required & cited:
        return None
    required_domains = {
        domain for domain, words in _SUBJECT_DOMAINS.items() if required & words
    }
    cited_domains = {
        domain for domain, words in _SUBJECT_DOMAINS.items() if cited & words
    }
    # Broad clauses and evidence can legitimately span several topics. Only
    # flag a clear, single-topic collision where both sides identify exactly
    # one different domain; otherwise leave the semantic reading to the judge.
    if len(required_domains) != 1 or len(cited_domains) != 1:
        return None
    if required_domains == cited_domains:
        return None
    return (
        "The cited passage has no recognizable subject terms in common with this clause; "
        "check that the evidence answers this requirement."
    )
