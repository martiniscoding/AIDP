"""What the organisation's technology stack says about a design.

A standards register states rules. A technology stack states *facts about what
is approved* — "Amazon Redshift | Analytics | Hold" is not something a design
can comply with. But several standards are written entirely about it:

    EA-007  Every technology is classified Adopt, Trial, Assess or Hold in the
            Technology Stack; only Adopt is used for new production work.
    EA-008  New technology is introduced through the evaluation and procurement
            process; a product not in the Technology Stack needs approval.

Those two cannot be answered from the design alone, and until this module the
judge was asked to answer them with no sight of the stack at all. It would
reliably say `partial`: the design says what it uses, the clause says what the
stack must permit, and nothing in the prompt connected the two.

So this hands the judge the missing half, as facts, for the clauses that are
about it.

## The two halves, and why only one of them is deterministic

**A technology the stack holds back** is a lookup. The stack names 227
technologies; scanning the design for those names needs no model, costs
nothing, and gives the judge a pointed sentence: *the design names Amazon
Redshift, and your stack records it as Hold.*

**A technology the stack has never heard of** cannot be found that way. Searching
stack names in a design can only ever surface things that are *in* the stack —
Mirth Connect is absent precisely because it is not there to search for. That
half needs something that reads the design and names what it finds, which is
the judge. So the judge is given the approved list, compactly, and decides.

## Matching, and the asymmetry it has to keep

A false *absence* is far worse than a missed one. Reporting "Postgres is not in
your approved stack" to a customer whose stack says `PostgreSQL (Amazon Aurora
/ RDS)` accuses them of running something unapproved that they approved. One of
those loses a reviewer's trust for good; a shadow technology we failed to spot
does not.

So the two directions use different strictness:

  * **naming a technology as held back** — strict, primary name only;
  * **deciding something is absent** — generous, and the judge is shown every
    form a row's name takes so it does not call a match a stranger.

Bracket contents are the reason that matters. 39 of the 227 rows carry them and
they mean three different things:

    Amazon Web Services (AWS)            an alias
    PostgreSQL (Amazon Aurora / RDS)     the products it is delivered as
    MongoDB (self-hosted)                a deployment flavour, not a name

Read as aliases, a design mentioning "Serverless" would match Databricks SQL.
So they are never used to assert a match — only shown to the judge, and used to
hold back an absence claim.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import db

#: The four positions, lower-cased, in the order a reviewer cares about them:
#: the ones that are not plain approval first.
STATUSES = ("hold", "assess", "trial", "adopt")

#: Only `adopt` is unqualified approval. EA-007 says so outright — "only Adopt
#: is used for new production work" — so trial and assess are facts worth
#: putting in front of the judge rather than silence.
APPROVED_FOR_NEW_WORK = ("adopt",)

#: Below this many characters a name cannot be searched for in prose. "Go" is
#: inside "Google", "Django" and "going"; "Ray" is inside "array" and "AWS
#: X-Ray", which is a different product. `lifecycle._names_product` solves this
#: by requiring a short name to *be* the whole name, which works there because
#: the name came from a model naming one technology. Here the haystack is a
#: whole design, so the only honest answer is not to scan for them — they still
#: reach the judge in the approved list below.
_MIN_SCANNABLE = 5

#: Clause wording that means the clause is about the stack. Deliberately
#: phrases rather than single words: "assess" alone appears in half the
#: security register ("must be assessed before release") and would attach this
#: block to clauses it says nothing about.
_CONCERNS = (
    "technology stack",
    "technology radar",
    "approved technolog",
    "technology selection",
    "approved stack",
    "approved product",
    "technology is introduced",
    "new technology",
    "approved version",
    "organisation has approved",
    "organization has approved",
)


@dataclass
class Row:
    """One technology, and this organisation's position on it."""

    name: str
    status: str
    category: str = ""
    approved_versions: str = ""
    notes: str = ""

    @property
    def primary(self) -> str:
        """The name with any bracket stripped: "PostgreSQL (Aurora / RDS)" → "PostgreSQL"."""
        return re.sub(r"\s*\([^)]*\)", "", self.name).strip()

    @property
    def bracketed(self) -> str:
        """Whatever was in the bracket, or "". Shown, never matched on."""
        found = re.search(r"\(([^)]*)\)", self.name)
        return found.group(1).strip() if found else ""

    @property
    def approved_for_new_work(self) -> bool:
        return self.status in APPROVED_FOR_NEW_WORK


@dataclass
class Hit:
    """A stack technology this design names."""

    row: Row
    #: The design's own words, for a reviewer checking the claim.
    quote: str


@dataclass
class Stack:
    rows: list[Row] = field(default_factory=list)

    def __bool__(self) -> bool:
        return bool(self.rows)

    @property
    def counts(self) -> dict[str, int]:
        out = {status: 0 for status in STATUSES}
        for row in self.rows:
            out[row.status] = out.get(row.status, 0) + 1
        return out


def load(conn, organisation_id: str) -> Stack:
    """This organisation's stack, newest document wins.

    A customer may have uploaded a stack more than once. `technology` rows hang
    off the document they were read from, so the most recently ingested one is
    the current position — the same rule the library screen shows.
    """
    rows = db.query(
        conn,
        """
        SELECT t."name", t."status", t."category", t."approvedVersions", t."notes"
          FROM "technology" t
          JOIN "document" d ON d."id" = t."documentId"
         WHERE t."organisationId" = %s
           AND d."status" = 'ready'
         ORDER BY d."createdAt" DESC, t."ordinal" ASC
        """,
        (organisation_id,),
    )
    seen: set[str] = set()
    out: list[Row] = []
    for row in rows or []:
        key = str(row["name"] or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(
            Row(
                name=str(row["name"] or "").strip(),
                status=str(row["status"] or "").strip().lower(),
                category=str(row["category"] or "").strip(),
                approved_versions=str(row["approvedVersions"] or "").strip(),
                notes=str(row["notes"] or "").strip(),
            )
        )
    return Stack(rows=out)


def design_text(conn, document_ids: list[str]) -> str:
    """Everything the design says, for the name scan.

    Read from `chunk` rather than re-rendering the document: the chunks are
    already the design's text, already in the database, and already the thing
    retrieval searches — so a technology the scan finds is one the rest of the
    engine can also see. No model and no second parse.
    """
    if not document_ids:
        return ""
    rows = db.query(
        conn,
        """
        SELECT "text"
          FROM "chunk"
         WHERE "documentId" = ANY(%s)
         ORDER BY "documentId", "ordinal"
        """,
        (document_ids,),
    )
    return "\n".join(str(row["text"] or "") for row in rows or [])


def _pattern(words: list[str]) -> re.Pattern[str] | None:
    """A regex naming this technology in prose, tolerant of how it is written.

    "Node.js", "Node JS" and "node-js" are one technology written three ways, so
    the separators between a name's words are free. The boundaries are not: a
    name has to stand as its own word, or "Kafka" would match "Kafkaesque" and
    every short name would match inside a longer one.
    """
    if not words:
        return None
    return re.compile(
        r"(?<![A-Za-z0-9])" + r"[\s\-./_]*".join(map(re.escape, words)) + r"(?![A-Za-z0-9])",
        re.IGNORECASE,
    )


#: Vendor words that may be dropped from the FRONT of a name, and only there.
#:
#: Designs say "Kafka", not "Apache Kafka". But dropping a vendor word is only
#: safe when what is left still names the thing: "Amazon Redshift" → "Redshift"
#: is a technology, "Amazon Web Services" → "Web Services" is a phrase that
#: appears in every integration design ever written. So the remainder is
#: accepted only when it is a *single* word, long enough to stand alone —
#: which keeps "Kafka" and "Redshift" and rejects "Web Services", "SQL" (from
#: Microsoft SQL Server) and "MQ" (from Amazon MQ).
#:
#: Deliberately not `lifecycle._GENERIC`, which exists for the opposite problem
#: — deciding whether a model's chosen product id matches a name it was given —
#: and so includes "server", "engine" and "enterprise". Stripping those here
#: would leave "SQL" and "Docker" doing work they cannot do.
_VENDOR_PREFIXES = {
    "apache", "amazon", "aws", "microsoft", "google", "oracle", "ibm",
    "redhat", "eclipse", "hashicorp", "cloudera", "confluent",
}


def _searchable(row: Row) -> list[tuple[re.Pattern[str], bool]]:
    """Every way this row's name may appear in prose, each with whether it has
    to be capitalised. Empty if the row cannot be scanned for at all.

    The primary name only — never the bracket. See the module docstring: a
    bracket is as likely to hold "self-hosted" as "AWS", and a scan that took
    them for names would report a design as running Databricks SQL because it
    said "Serverless".

    The capitalisation rule applies to the shortened form and nowhere else, and
    it is here because of a real false positive. "HashiCorp Vault" shortens to
    "Vault", and a real design read

        AWS Backup protects core databases, but *vault lock* is not enabled on
        all backup plans

    — which matched, and put "HashiCorp Vault, recorded as Hold" in front of the
    judge as a technology that design had chosen. It had not: `vault lock` is a
    feature of AWS Backup. A full name is its own context and needs no such
    rule; a single word taken out of one does, and a technology is a proper
    noun, so a lower-case occurrence is almost always the common noun instead.

    The cost is a design that writes "kafka" in lower case, which is then
    missed. That is the right way round — see the module docstring on why a
    false absence is worse than a missed one.
    """
    words = re.findall(r"[A-Za-z0-9]+", row.primary)
    if not words:
        return []

    out: list[tuple[re.Pattern[str], bool]] = []
    if len("".join(words)) >= _MIN_SCANNABLE:
        found = _pattern(words)
        if found:
            out.append((found, False))

    # The same name without its vendor prefix, under the single-word rule above.
    rest = list(words)
    while rest and rest[0].lower() in _VENDOR_PREFIXES:
        rest = rest[1:]
    if len(rest) == 1 and rest != words and len(rest[0]) >= _MIN_SCANNABLE:
        found = _pattern(rest)
        if found:
            out.append((found, True))

    return out


def names_in(stack: Stack, text: str) -> list[Hit]:
    """Stack technologies this design names, deterministically.

    No model and no network: the stack is the gazetteer. Ordered with the ones
    that are not approved for new work first, because those are the finding.
    """
    hits: list[Hit] = []
    for row in stack.rows:
        found = None
        for pattern, needs_capital in _searchable(row):
            for candidate in pattern.finditer(text):
                if needs_capital and not text[candidate.start()].isupper():
                    continue
                found = candidate
                break
            if found:
                break
        if not found:
            continue
        hits.append(Hit(row=row, quote=_around(text, found.start(), found.end())))

    order = {status: index for index, status in enumerate(STATUSES)}
    hits.sort(key=lambda hit: (order.get(hit.row.status, len(STATUSES)), hit.row.name.lower()))
    return hits


#: The most unmatched names put in front of the judge. A block of fifty lines
#: stops being a fact and starts being noise.
MAX_UNLISTED = 20


def _initials(name: str) -> str:
    """"Amazon Elastic Kubernetes Service" -> "EKS": the vendor dropped, then initials."""
    words = [w for w in re.findall(r"[A-Za-z0-9]+", name) if w.lower() not in _VENDOR_PREFIXES]
    return "".join(w[0] for w in words).upper() if len(words) > 1 else ""


def _recorded(stack: Stack, name: str) -> bool:
    """Whether some stack row is this name, written in full, shortened or in its bracket.

    A design says "EKS", "Step Functions" or "Redis" where the stack says "Amazon
    Elastic Kubernetes Service", "AWS Step Functions" or "Amazon ElastiCache
    (Redis)". Reporting those as missing would bury the technology that really is
    absent, and tell the judge something false about a technology that is not.
    """
    if names_in(stack, name):
        return True
    low = re.escape(name.lower())
    word = re.compile(rf"(?<![a-z0-9]){low}(?![a-z0-9])")
    acronym = name.replace(" ", "").upper() if " " not in name.strip() else ""
    for row in stack.rows:
        if word.search(row.name.lower()):
            return True
        if acronym and 2 <= len(acronym) <= 6 and _initials(row.primary) == acronym:
            return True
    return False


def unlisted(stack: Stack, text: str, names: list[str]) -> list[Hit]:
    """Names the design uses that no stack entry matches, each checked in code.

    The model proposes names; it is never trusted on them. A name counts only if
    it is literally in the design (so one the model invented is dropped) and no
    stack row matches it by the same gazetteer `names_in` uses (so a technology
    the stack already records is not reported as missing). What is left is
    reported as a fact with the design's own words beside it, and no verdict.
    """
    seen: set[str] = set()
    out: list[Hit] = []
    for raw in names:
        name = " ".join(str(raw or "").split())
        key = name.lower()
        if len(name) < 3 or key in seen:
            continue
        seen.add(key)
        found = re.search(re.escape(name), text, flags=re.IGNORECASE)
        if not found or _recorded(stack, name):
            continue
        out.append(
            Hit(
                row=Row(name=name, status="unlisted"),
                quote=_around(text, found.start(), found.end()),
            )
        )
        if len(out) >= MAX_UNLISTED:
            break
    return out


def _around(text: str, start: int, end: int, width: int = 90) -> str:
    """The design's own words around a match, for a reviewer to check it by."""
    left = max(0, start - width)
    right = min(len(text), end + width)
    snippet = " ".join(text[left:right].split())
    return f"…{snippet}…" if (left > 0 or right < len(text)) else snippet


def concerns_technology(clause: dict) -> bool:
    """Whether this clause is about what the stack approves.

    Gated rather than attached to every clause, for two reasons. The approved
    list is a thousand tokens and most clauses have no use for it, so paying for
    it a hundred and seventy times is waste; and a block of technology names in
    front of a clause about encryption keys is not neutral — it is material the
    judge may reach for, and evidence that cannot be relevant should not be in
    the prompt at all.
    """
    haystack = " ".join(
        str(clause.get(key) or "") for key in ("title", "statement")
    ).lower()
    return any(phrase in haystack for phrase in _CONCERNS)


def render(stack: Stack, hits: list[Hit], unmatched: list[Hit] | None = None) -> str:
    """The stack as the judge reads it, for a clause that is about the stack.

    Two blocks, and the order is the point. What the design actually names comes
    first, already looked up, so the judge is not asked to do a two-hundred-row
    join in its head to find the thing the finding turns on. The full list comes
    second, because the other half of the question — a technology the stack has
    never heard of — can only be answered by reading the design against all of
    it.

    Facts, with no verdict in them. Whether "Hold" breaches this particular
    clause is the clause's business: one register says only Adopt may be used
    for new work, another may permit Trial behind an exception, and this module
    is not the place that decides.
    """
    if not stack:
        return ""

    parts: list[str] = []

    if hits:
        named = [
            f"- {hit.row.name} — recorded as {hit.row.status.title()}"
            + (
                f", approved versions: {hit.row.approved_versions}"
                if hit.row.approved_versions
                else ""
            )
            + (f". Stack notes: {hit.row.notes}" if hit.row.notes else "")
            + f"\n  Design says: {hit.quote}"
            for hit in hits
        ]
        parts.append(
            "Technologies this design names that appear in the organisation's "
            "technology stack, with the position the stack records:\n" + "\n".join(named)
        )
    else:
        parts.append(
            "No technology from the organisation's technology stack was found by name "
            "in this design."
        )

    if unmatched:
        lines = [f"- {hit.row.name}\n  Design says: {hit.quote}" for hit in unmatched]
        parts.append(
            "Technologies this design names that could not be matched, by name, to any "
            "entry in the organisation's technology stack below. The stack may write a "
            "name differently, so look for it in the full list before concluding it is "
            "absent:\n" + "\n".join(lines)
        )

    # Grouped and comma-separated rather than one row per line: the same facts
    # in roughly a fifth of the tokens, and a reader scanning for a name finds
    # it either way.
    groups: list[str] = []
    for status in STATUSES:
        names = [row.name for row in stack.rows if row.status == status]
        if names:
            groups.append(f"{status.title()} ({len(names)}): " + ", ".join(names))
    parts.append(
        "The organisation's full technology stack. A technology the design uses that "
        "is not named here has not been through the stack's approval:\n" + "\n".join(groups)
    )

    return "\n\n".join(parts)
