/**
 * Verdict vocabulary and shapes — no database, no server-only imports.
 *
 * Split out from assessment.ts so the client can have it. That module reaches
 * Prisma, which reaches `node:module`, and a client component importing it
 * fails the build with a chunking error that names the component rather than
 * the import that caused it.
 *
 * Anything here must stay pure and dependency-free.
 */

export const VERDICTS = [
  "contradicts",
  "absent",
  "partial",
  "not_assessable",
  "needs_review",
  "covered",
  "not_applicable",
] as const;

export type Verdict = (typeof VERDICTS)[number];

/**
 * Ordered worst-first: the review queue should open on what matters.
 *
 * ## The five things a reviewer means by "not covered"
 *
 * These are not interchangeable, and the engine was using them as though they
 * were. One real run marked a design `absent` on "Dell + VMware Infrastructure"
 * because it runs on Google Cloud, and `covered` on "Approved Platform-Specific
 * Deployments" because it names GKE. Both are category errors, not close calls.
 *
 * | What is actually the case | Status |
 * |---|---|
 * | The clause requires a component or mechanism and the design never engages it | `absent` |
 * | The design engages it, but the evidence needed to judge it is not in the document | `not_assessable` |
 * | The wording is genuinely open to two readings, so no answer is safe | `needs_review` |
 * | The clause's own stated condition excludes this architecture | `not_applicable` |
 * | The subject needs a standard the organisation has not supplied | **not a verdict** |
 *
 * The last row is the one that has no status, deliberately. A requirement the
 * company has never written down cannot be a finding against a design — a
 * finding is always measured against a clause in the indexed framework. Those
 * belong to `run.coverage`, which reports the parts of a design no clause
 * governs and names the standards that would cover them, as a proposal to
 * whoever owns the standards library. See Workers/aidp/coverage.py, whose
 * contract puts it plainly: never a requirement on a design.
 *
 * `not_assessable` is the verdict this vocabulary was missing, and its absence
 * was the engine's worst habit. "The design names GKE but includes no approval
 * record" is not a breach of an approval requirement — it is a document that
 * does not say. Having only `absent` for it, the report called it a gap and
 * `severityOf` called the gap Critical, so a missing page of paperwork arrived
 * beside a real breach and read the same. The two are now different answers:
 * `absent` is the design never engaging the clause's mechanism, which is a real
 * gap; `not_assessable` is the mechanism being there with the evidence needed to
 * judge it missing, which is a question for whoever wrote the document.
 */
export const VERDICT_META: Record<
  Verdict,
  { label: string; tone: "bad" | "warn" | "unknown" | "neutral" | "good"; blurb: string }
> = {
  contradicts: {
    label: "Contradicts",
    tone: "bad",
    blurb: "The design states something the standard forbids.",
  },
  absent: {
    label: "Absent",
    tone: "bad",
    blurb:
      "The design never engages this requirement's mechanism — the thing it asks for is " +
      "not in the architecture, not merely undocumented.",
  },
  partial: {
    label: "Partial",
    tone: "warn",
    blurb: "Addressed, but a requirement is left unmet.",
  },
  not_assessable: {
    label: "Not assessable",
    tone: "unknown",
    blurb:
      "The architecture engages this requirement, but the record needed to judge it — an " +
      "approval, a policy, a stated figure — is not in the document. A question for its author.",
  },
  needs_review: {
    label: "Needs review",
    tone: "unknown",
    blurb:
      "No answer is safe from what is written: the wording is open to two readings, or the " +
      "engine refused a conclusion the source did not support.",
  },
  covered: { label: "Covered", tone: "good", blurb: "Every requirement is met." },
  not_applicable: {
    label: "Not applicable",
    tone: "neutral",
    blurb:
      "A condition the clause itself states excludes this architecture. Never because the " +
      "document is silent — that is Not assessable.",
  },
};

/**
 * How strongly the clause binds, as the finding recorded it.
 *
 * Mirrors `Workers/aidp/obligations.py`. `unstated` is not a synonym for
 * advisory: it means the standard did not establish the obligation, and the
 * engine will not establish one on its behalf.
 */
export const OBLIGATIONS = ["must", "should", "may", "unstated"] as const;

export type Obligation = (typeof OBLIGATIONS)[number];

export const OBLIGATION_META: Record<Obligation, { label: string; blurb: string }> = {
  must: { label: "Mandatory", blurb: "The standard requires this." },
  should: { label: "Recommended", blurb: "The standard recommends this." },
  may: { label: "Optional", blurb: "The standard permits this." },
  /**
   * No label, on purpose.
   *
   * This read "Obligation unstated", which is jargon for a fact the reader
   * cannot act on, and it appeared on every finding from a standard written in
   * declarative prose — which is most of them, since enterprise standards say
   * "All external APIs are exposed through Apigee" rather than "APIs MUST be
   * exposed through Apigee". A badge on every card saying a word nobody uses
   * is noise, and a reader learns to skip the line it sits on.
   *
   * The fact underneath is still worth having, so the sentence stays and the
   * label goes: anywhere the UI shows a label it now shows nothing for this
   * case, and the explanation carries itself. `label: ""` rather than a
   * removed key so every consumer keeps working and none of them has to know
   * which obligations have labels.
   */
  unstated: {
    label: "",
    blurb:
      "This standard states the rule without saying whether it is mandatory, so how serious a breach would be is a judgement for a reviewer.",
  },
};

export function readObligation(value: unknown): Obligation {
  return OBLIGATIONS.includes(value as Obligation) ? (value as Obligation) : "unstated";
}

/**
 * How much a finding should worry the person reading it.
 *
 * Distinct from the verdict, and the distinction is the point. The verdict says
 * what the engine concluded; this says where to start. A reviewer with eighty
 * findings open is not asking "what category is this" — they are asking "which
 * of these do I have to deal with before the design ships".
 *
 * It replaced the model's confidence percentage on the row. That number was
 * answering a question nobody had: it is the model's opinion of itself, it does
 * not mean the gap is serious, and 87% next to "Contradicts" invited a reader
 * to treat a breach as 13% fine. The confidence is still there, inside the
 * finding, where somebody doubting a verdict will look for it.
 */
export const SEVERITIES = ["critical", "moderate", "check"] as const;

export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_META: Record<
  Severity,
  { label: string; tone: "bad" | "warn" | "unknown"; blurb: string }
> = {
  critical: {
    label: "Critical",
    tone: "bad",
    blurb: "A mandatory requirement is breached or unaddressed. Fix before this ships.",
  },
  moderate: {
    label: "Moderate",
    tone: "warn",
    blurb: "Worth resolving, but it does not have to block the design.",
  },
  check: {
    label: "Check",
    tone: "unknown",
    blurb: "Severity cannot be settled from the document. A person has to look.",
  },
};

/**
 * How serious this finding is, from what the finding already carries.
 *
 * Null for `covered` — there is nothing to act on, and a row that says
 * "Covered · Low" reads as a problem when it is the opposite.
 *
 * `contradicts` is never softened by confidence. The analyse stage is already
 * asymmetric about it: a contradiction with no evidence behind it is demoted
 * rather than reported, so one that reaches a screen has been through a
 * stricter gate than any other verdict, and the design actively stating
 * something the standard forbids is the worst thing this tool can find.
 */
export function severityOf(
  verdict: string,
  obligation: Obligation = "unstated",
): Severity | null {
  // Nothing to act on. A row reading "Covered · Low" reads as a problem when it
  // is the opposite, and the same is true of a clause that does not apply.
  if (verdict === "covered" || verdict === "not_applicable") return null;

  // An evidence gap is never Critical, whatever the obligation. The document
  // does not say; that is a question for its author, not a defect in the
  // architecture, and this is the single rule the brief is most insistent on.
  // A mandatory clause still earns priority over an advisory one, so the gaps
  // worth chasing first are the ones that block a mandatory judgement.
  if (verdict === "not_assessable") return obligation === "must" ? "moderate" : "check";

  // A breach is a breach. Softened only where the standard itself is explicit
  // that the rule is advisory — and never on `unstated`, because treating an
  // unclassified clause as advisory would be inventing permission.
  if (verdict === "contradicts") {
    return obligation === "should" || obligation === "may" ? "moderate" : "critical";
  }

  if (verdict === "absent") {
    // Critical needs two things: the design does not engage the mechanism, and
    // the standard says it has to. Without a stated obligation the impact
    // cannot be established, so this says so rather than inventing a level —
    // which is also what stops a missing section from outranking a real breach.
    if (obligation === "must") return "critical";
    if (obligation === "should" || obligation === "may") return "moderate";
    return "check";
  }

  if (verdict === "partial") return obligation === "may" ? "check" : "moderate";

  // needs_review, and anything a future engine adds that this has not been
  // taught: "a person has to look" is the safe answer, never "critical".
  return "check";
}

export type VerdictCounts = Record<Verdict, number>;

/**
 * Which findings a report is showing.
 *
 * "attention" is what a report opens on: everything except covered. A covered
 * finding is the evidence that a clause was checked and passed — an audit asks
 * for exactly that, and a wrong one is the most expensive mistake this tool can
 * make, so they are folded rather than dropped and the count stays on screen.
 */
export type Lens = Verdict | "attention" | "all";

/**
 * Apply a lens. Pure, and separate from the component, so the rule can be
 * tested as a rule — the component is a Client Component, and every finding
 * reaches the browser in its props whether or not it is drawn, which makes
 * "is it on the page?" unanswerable from the HTML.
 */
export function applyLens<T extends { verdict: string }>(findings: T[], lens: Lens): T[] {
  if (lens === "all") return findings;
  // Covered and not-applicable are both "nothing to do here", and a review
  // queue that opens on them buries the findings that need a decision. Both
  // stay counted and both stay reachable by their own lens.
  if (lens === "attention") {
    return findings.filter(
      (finding) => finding.verdict !== "covered" && finding.verdict !== "not_applicable",
    );
  }
  return findings.filter((finding) => finding.verdict === lens);
}

export function emptyCounts(): VerdictCounts {
  return Object.fromEntries(VERDICTS.map((v) => [v, 0])) as VerdictCounts;
}

export type EvidenceItem = {
  chunkId: string;
  headingPath: string;
  page: number | null;
  excerpt: string;
  /** "clause" | "table_row" | "figure" | … — where the passage came from. */
  sourceKind: string;
  /**
   * Set only when the passage is a model's reading of a diagram. The finding
   * renders the diagram beside it, so the claim can be checked against the
   * thing it was made about.
   */
  figureId: string | null;
  /**
   * Which design the passage is from, on a run over a whole project. A page
   * number is not an address when four designs each have a page 12, so the
   * finding names the file. Empty on a design run, and on findings from before
   * projects could be assessed.
   */
  documentId: string;
  documentTitle: string;
};

/**
 * The rationale with the model's extract ids taken out of it.
 *
 * The clause prompt makes a verdict cite the extracts it rests on, and the ids
 * it returns in `evidence` are what the finding's evidence cards are built
 * from. The model writes them into its prose as well — "lacks documented or
 * approved modular design exception (extracts cmvb8kzz94ba8da8bc2704870,
 * cmvb8l0404df309f3719faaf6)" — and a reviewer can do nothing with that. It is
 * an internal key, in the first sentence they read, on 58 of the 1,157
 * findings in this workspace.
 *
 * Stripped at read rather than at write, so the reports already stored lose
 * them too. The citation itself is not lost: it is the cards below the prose.
 */
export function withoutExtractIds(rationale: string): string {
  return (
    rationale
      // A bracket holding ids and nothing else but the words joining them:
      // "(extracts a, b)", "(extract a)", and the bare "(a, b)".
      .replace(ID_BRACKET, "")
      // An id the model ran into its own sentence, with the label it gave it.
      .replace(LABELLED_ID, "")
      // The phrase that introduced the reference, left pointing at nothing.
      // "...to avoid point-to-point silos, as shown in extracts a, b and c."
      // loses its object with the ids, and "as shown in." is not a sentence.
      // Only ever immediately before the punctuation that ended it, so a
      // "shown in" with something real after it is untouched.
      .replace(
        /[,;]?\s*\b(?:as\s+)?(?:shown|seen|described|evidenced|documented|listed)\s+(?:in|at|by)\s*(?=[.,;:)]|$)/gi,
        "",
      )
      .replace(/[,;]?\s*\bsee\s*(?=[.,;:)]|$)/gi, "")
      // Whatever the removal left behind: a doubled space, or a space pushed
      // up against the punctuation that followed the bracket.
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([.,;:)])/g, "$1")
      .replace(/\(\s*\)/g, "")
      .trim()
  );
}

/**
 * A cuid as Prisma writes one: `c` and 24 more, at least one of them a digit.
 *
 * The length is a range rather than the exact 25 every id in the database
 * actually has, because the model does not always copy one correctly. It
 * writes "cmuxvob4a36660c2633538f6" — 24 characters, an id that matches no
 * chunk — beside three that are real. A miscopied id is still an internal key
 * in a reviewer's sentence, and leaving it there because it is malformed
 * would show them the one reference they definitely cannot follow.
 *
 * The digit is what keeps this off English. A 21-letter lowercase word is not
 * something these rationales contain, but "c" plus twenty letters is a shape a
 * regex can find in a long compound noun, and a rationale with a word silently
 * removed is worse than one with an id left in.
 */
const EXTRACT_ID = String.raw`\bc(?=[a-z0-9]{20,28}\b)(?=[a-z0-9]*\d)[a-z0-9]{20,28}\b`;

const ID_BRACKET = new RegExp(
  String.raw`\s*\((?:\s*(?:extracts?|see|ids?)\b[:\s]*)?` +
    EXTRACT_ID +
    String.raw`(?:[\s,;]*(?:and\s+)?` +
    EXTRACT_ID +
    String.raw`)*\s*\)`,
  "gi",
);

const LABELLED_ID = new RegExp(
  String.raw`\s*\b(?:extracts?|ids?)\b[:\s]+` + EXTRACT_ID + String.raw`(?:[\s,;]*(?:and\s+)?` + EXTRACT_ID + String.raw`)*`,
  "gi",
);

// ------------------------------------------------- the rationale's shape
//
// Pure, and about the vocabulary of a verdict, so it lives here rather
// than in the component that used to own it — which also lets it be run
// against the stored findings without a JSX toolchain.

export const RATIONALE_PARTS = ["Gap", "Impact", "Fix"] as const;

/**
 * The same three sentences, named for a clause that passed.
 *
 * A covered finding has no gap and nothing to fix, so labelling its three
 * sentences "Gap / Impact / Fix" tells the reader the opposite of the verdict
 * directly above them. The judge writes the same shape either way — what the
 * clause wanted, what the design does about it, why that satisfies it — so only
 * the labels change.
 */
export const RATIONALE_PARTS_COVERED = ["Requirement", "Evidence", "Alignment"] as const;

/** Labels for a verdict: a passing clause is described, not remediated. */
export function rationaleLabels(verdict: string): readonly string[] {
  return verdict === "covered" || verdict === "not_applicable"
    ? RATIONALE_PARTS_COVERED
    : RATIONALE_PARTS;
}

/**
 * A rationale split into gap, impact and fix.
 *
 * The judge is now told to write exactly those three, in that order, for any
 * verdict that is not "covered" (rules 8 and 11 in Workers/aidp/ai/llm.py). Run
 * together as one paragraph they read as the wall of text the whole change was
 * meant to remove — the three facts are there but the reader has to find the
 * boundaries, which is most of the work of skimming eighty findings.
 *
 * Split on sentence ends rather than on a delimiter the model was asked to
 * emit: a format token is one more instruction to disobey, and the sentences
 * are what the prompt actually constrains. Exactly three sentences is the
 * shape being labelled, so anything else — a one-line "covered", an older
 * finding written before the rule, a model that ignored it — is returned
 * unsplit and rendered as the paragraph it is. That is the honest fallback:
 * labelling two sentences "Gap" and "Impact" would promise a fix that was
 * never written.
 */
export function rationaleParts(rationale: string): string[] | null {
  const trimmed = rationale.trim();
  // A decimal or an abbreviation would split a sentence in the wrong place, so
  // require a space and a capital after the stop.
  const sentences = trimmed
    // A stop ends a sentence only when a space and a capital follow, which
    // keeps "TLS 1.2", "1.0" and "section 4.2" intact.
    //
    // The lookbehind then excludes the abbreviations that *do* take a capital
    // after them — "e.g. Kafka", "i.e. Apigee", "Acme Inc. Payments" — because
    // the budget is now 600 characters rather than 280, and a sentence with
    // room for an aside will contain one. Each is listed with its trailing dot,
    // since the split point sits after that dot and that is what the lookbehind
    // sees. A rationale that splits wrongly loses its labels and renders as a
    // paragraph, so this is worth being exact about.
    //
    // "etc." is deliberately absent: it ends a sentence at least as often as it
    // sits inside one, and guarding it broke the commoner case.
    .split(
      /(?<!\be\.g\.|\bi\.e\.|\bvs\.|\bcf\.|\bapprox\.|\bno\.|\bfig\.|\bincl\.|\bInc\.|\bLtd\.|\bDept\.)(?<=[.!?])\s+(?=[A-Z0-9"“'])/,
    )
    .map((part) => part.trim())
    .filter(Boolean);
  return sentences.length === RATIONALE_PARTS.length ? sentences : null;
}

/** The sentences of a rationale, by the rule `rationaleParts` splits on. */
function splitSentences(rationale: string): string[] {
  return (
    rationale
      .trim()
      .split(
        /(?<!\be\.g\.|\bi\.e\.|\bvs\.|\bcf\.|\bapprox\.|\bno\.|\bfig\.|\bincl\.|\bInc\.|\bLtd\.|\bDept\.)(?<=[.!?])\s+(?=[A-Z0-9"\u201C'])/,
      )
      .map((part) => part.trim())
      .filter(Boolean)
  );
}

/**
 * A sentence that tells the reviewer what to do, rather than what is wrong.
 *
 * Where the judge writes two sentences instead of three it is almost always
 * the impact it dropped, not the fix: "No extract addresses naming
 * conventions… The design must specify naming conventions for tables,
 * columns, keys, indexes, and views as per the clause." Labelling that second
 * sentence "Fix" is right, and labelling a second sentence that merely goes on
 * describing the gap "Fix" is a lie about what the reviewer is reading — so
 * the label is offered only to a sentence shaped like a remedy.
 */
const FIX_OPENING =
  /^(?:to\s+(?:satisfy|comply|close|remediate|address)\b|(?:the\s+)?(?:design|document|team|project)\s+(?:must|should|needs\s+to|will\s+need)\b|(?:add|define|document|specify|implement|provide|establish|include|record|align|obtain|introduce|apply|create|update|replace|restrict|migrate|remediate|remove|enable|configure|capture|publish|approve|extend)\b)/i;

function looksLikeFix(sentence: string): boolean {
  return FIX_OPENING.test(sentence.trim());
}

/**
 * The rationale as labelled sections, or null when it cannot be labelled.
 *
 * Rule 8 of the clause prompt asks for GAP, IMPACT and FIX as three sentences
 * on a breach, and rule 7 asks for one sentence everywhere else — so a single
 * sentence is usually the judge doing as it was told, not a failure. What the
 * stored findings show is that the three-part shape mostly does not arrive:
 * of 851 findings on verdicts that ask for it, 69 have three sentences. The
 * rest are one or two, and no amount of splitting invents an impact the judge
 * never wrote.
 *
 * So this labels what is genuinely there and refuses to guess at the rest.
 * Nothing is dropped either way: a rationale with no labels is rendered as the
 * paragraph it is.
 */
export function rationaleSections(
  rationale: string,
  verdict: string,
): { label: string; text: string }[] | null {
  const sentences = splitSentences(rationale);
  const labels = rationaleLabels(verdict);
  const [gap, impact, fix] = labels;

  if (sentences.length === 3) {
    return sentences.map((text, i) => ({ label: labels[i], text }));
  }

  // A passing clause is described rather than remediated, so its labels name
  // parts of an argument that only reads in order. Two of those three, or five
  // of them, is not that argument, and guessing which two would misdescribe it.
  if (verdict === "covered" || verdict === "not_applicable") return null;

  // More than three: the judge overran its sentence budget rather than
  // changing shape. The first is still the gap and the last is still the fix,
  // and what sits between them is the impact however many sentences it took.
  if (sentences.length > 3 && looksLikeFix(sentences[sentences.length - 1])) {
    return [
      { label: gap, text: sentences[0] },
      { label: impact, text: sentences.slice(1, -1).join(" ") },
      { label: fix, text: sentences[sentences.length - 1] },
    ];
  }

  // Two: the impact is the part that goes missing, so this is a gap and a
  // remedy — but only when the second sentence actually reads as one.
  if (sentences.length === 2 && looksLikeFix(sentences[1])) {
    return [
      { label: gap, text: sentences[0] },
      { label: fix, text: sentences[1] },
    ];
  }

  return null;
}

/** `evidence` is Json in the schema; narrow it before rendering. */
export function readEvidence(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.chunkId !== "string") return [];
    return [
      {
        chunkId: row.chunkId,
        headingPath: typeof row.headingPath === "string" ? row.headingPath : "",
        page: typeof row.page === "number" ? row.page : null,
        excerpt: typeof row.excerpt === "string" ? row.excerpt : "",
        sourceKind: typeof row.sourceKind === "string" ? row.sourceKind : "clause",
        figureId: typeof row.figureId === "string" ? row.figureId : null,
        documentId: typeof row.documentId === "string" ? row.documentId : "",
        documentTitle: typeof row.documentTitle === "string" ? row.documentTitle : "",
      },
    ];
  });
}
