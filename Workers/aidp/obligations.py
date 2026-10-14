"""How strongly a clause binds: must, should, may, or not stated at all.

The standards parser already works this out. A model reads each rule's lines and
says whether each requirement is a "must" (must, shall, required, prohibited), a
"should" or a "may", and it is stored on the clause as
`sourceRefs.requirements[].strength` — see `Workers/aidp/parsing/rules.py`.

Nothing then used it. The clause query did not select `sourceRefs`, the judge
was handed a flat bullet list of requirements with no obligation on them, and
severity was a function of the verdict and the model's own confidence. So a
design that breached an advisory "may" and one that breached a mandatory "shall"
produced the same finding at the same severity, and a report could not answer
the first question an architecture board asks: which of these do we have to fix.

Two rules govern everything here:

- **Never invent mandatory language.** Where the source does not establish that
  a rule is binding, the answer is `unstated`, and `unstated` is not `must`.
  A reviewer may still decide it is mandatory; the engine will not decide it for
  them.
- **Say where the answer came from.** `parsed` is the standard's own structure.
  `read` is this module finding a modal verb in the clause's own words, which is
  reading the source rather than guessing at it, but is an interpretation and is
  labelled as one. A finding shows which, so a reviewer can disagree with the
  weaker kind.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Strongest first. The clause's obligation is the strongest of its
# requirements': a clause holding one "shall" among three "may"s is a mandatory
# clause, and reporting it as advisory would be the expensive direction to err.
STRENGTHS = ("must", "should", "may")
UNSTATED = "unstated"

# Where an obligation came from, weakest claim last.
PARSED = "parsed"
READ = "read"

# The same vocabulary the parser's own prompt uses (see `_STRUCTURE_PROMPT` in
# ai/llm.py), so a clause read here and a clause read there agree. Word
# boundaries throughout: "may" must not match "maybe", and "must" must not match
# "mustard" — which sounds silly until a clause about condiment supply chains
# turns up in a food manufacturer's standards.
_MODALS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("must", ("must", "shall", "required", "require", "requires", "mandatory", "prohibited",
              "forbidden", "may not", "must not", "shall not")),
    ("should", ("should", "recommended", "expected", "ought")),
    ("may", ("may", "can", "optional", "permitted", "encouraged")),
)

# "may not" and "must not" are prohibitions, not permissions, so they are listed
# under "must" above and have to be taken off the text before "may" is looked
# for — otherwise "may not be stored outside the region" reads as advisory.
_NEGATED = re.compile(r"\b(?:may|can|might)\s+not\b", re.IGNORECASE)


@dataclass(frozen=True)
class Obligation:
    """How strongly a clause binds, and how confidently that is known."""

    strength: str
    source: str

    @property
    def is_mandatory(self) -> bool:
        return self.strength == "must"

    @property
    def is_advisory(self) -> bool:
        return self.strength in ("should", "may")

    @property
    def is_known(self) -> bool:
        return self.strength != UNSTATED

    def describe(self) -> str:
        """One phrase for a prompt or a finding."""
        if not self.is_known:
            return "obligation not stated in the standard"
        if self.source == READ:
            return f"{self.strength} (read from the clause's own wording)"
        return self.strength


UNKNOWN = Obligation(UNSTATED, UNSTATED)


def _strongest(found: list[str]) -> str | None:
    for strength in STRENGTHS:
        if strength in found:
            return strength
    return None


def _from_refs(clause: dict) -> list[str] | None:
    """The strengths the parser recorded, one per requirement, or None.

    None when they cannot be trusted to line up. `sourceRefs.requirements` is
    built from every requirement the model pointed at, while the clause's
    `requirements` text array drops any that rendered empty — so the two lists
    are usually parallel and occasionally are not. Zipping them regardless would
    attach one requirement's obligation to another's words, which is worse than
    having none: a report would call an advisory rule mandatory and cite the
    wrong sentence for it.
    """
    refs = clause.get("sourceRefs")
    if not isinstance(refs, dict):
        return None
    rows = refs.get("requirements")
    if not isinstance(rows, list) or not rows:
        return None

    strengths = [
        str((row or {}).get("strength") or "").strip().lower() if isinstance(row, dict) else ""
        for row in rows
    ]
    if any(s not in STRENGTHS for s in strengths):
        return None

    requirements = clause.get("requirements") or []
    if len(requirements) != len(strengths):
        return None
    return strengths


def _read(text: str) -> str | None:
    """The strongest modal verb in some words, or None.

    Reading the source, not guessing: these are the words the standard itself
    uses. Still labelled `read` rather than `parsed`, because a sentence can
    carry a modal verb that is not the clause's own obligation — "systems that
    must be internet-facing" describes a condition, not a requirement — and a
    reviewer should be able to see which kind of answer they are looking at.
    """
    lowered = _NEGATED.sub(" must not ", text.lower())
    for strength, words in _MODALS:
        for word in words:
            if re.search(rf"\b{re.escape(word)}\b", lowered):
                return strength
    return None


def per_requirement(clause: dict) -> list[tuple[str, str]]:
    """Each requirement with its obligation, for the judge's prompt.

    Falls back per requirement rather than for the clause as a whole, so a
    clause the parser only partly resolved still says what it knows about the
    rest instead of discarding all of it.
    """
    requirements = [str(r) for r in (clause.get("requirements") or [])]
    parsed = _from_refs(clause)
    out: list[tuple[str, str]] = []
    for index, text in enumerate(requirements):
        if parsed is not None:
            out.append((text, parsed[index]))
            continue
        out.append((text, _read(text) or UNSTATED))
    return out


def of(clause: dict) -> Obligation:
    """How strongly this clause binds, and where that was established.

    The strongest of its requirements', falling back to the clause's own
    statement and title — a one-line clause with no separate requirements is the
    common shape in these documents, and its obligation is in the sentence
    itself.
    """
    parsed = _from_refs(clause)
    if parsed is not None:
        strongest = _strongest(parsed)
        if strongest is not None:
            return Obligation(strongest, PARSED)

    # Requirements first, then the statement. A statement introduces the subject
    # and the requirements bind — "Data retention" as a statement over "Records
    # shall be kept for seven years" is a mandatory clause, and reading only the
    # statement would call it unstated.
    requirements = [str(r) for r in (clause.get("requirements") or [])]
    read = [s for s in (_read(text) for text in requirements) if s]
    strongest = _strongest(read)
    if strongest is not None:
        return Obligation(strongest, READ)

    for key in ("statement", "title"):
        found = _read(str(clause.get(key) or ""))
        if found is not None:
            return Obligation(found, READ)

    return UNKNOWN


# The model's reading of the clause it was judging. Weaker than either of the
# other two: it is not the standard's own structure and it is not a rule applied
# to the standard's words, it is an opinion about them. Asked for anyway, because
# in practice the parser records a strength only for model-read rules and almost
# every real clause came from the rule-based parser — so without this the great
# majority of findings would carry no obligation at all and severity would have
# nothing to weigh.
JUDGE = "judge"


def resolve(clause: dict, judged: str = "") -> Obligation:
    """The obligation to record on a finding.

    This module's own reading comes first wherever it has one, because it is
    verifiable: the strengths the parser recorded are in the clause row, and a
    modal verb is either in the clause's words or it is not. The judge's reading
    fills in the rest rather than overriding anything — a model that calls a
    "may" a "must" would otherwise promote an advisory clause's breach to
    Critical, which is the direction that costs a reviewer their trust.

    `judged` arriving as "unstated" is a real answer and the honest one for a
    descriptive clause. It is treated as no answer, which is the same thing.
    """
    own = of(clause)
    if own.is_known:
        return own

    candidate = str(judged or "").strip().lower()
    if candidate in STRENGTHS:
        return Obligation(candidate, JUDGE)
    return UNKNOWN
