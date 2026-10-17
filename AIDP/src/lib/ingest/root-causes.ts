/**
 * Which of a run's findings come from one fact about the design.
 *
 * A standard is a list of separate rules, so a design is judged against each of
 * them separately. That is right, and it is why one mistake arrives as several
 * findings. On one real 61-clause run, twelve contradictions came from five
 * facts — five of them from a single application reading another's database
 * directly — and three carried the same remediation sentence word for word. The
 * report counted twelve problems and the reviewer planned twelve pieces of work.
 *
 * The grouping is worked out once per run by Workers/aidp/rootcause.py, which
 * checks every group it is given before storing it. This is the reading half:
 * it trusts the shape no more than `readEvidence` trusts its own, because a run
 * from before the column existed, or one whose grouping failed, must render as
 * the report always did.
 *
 * **A lens, never a replacement.** Every finding keeps its clause reference,
 * its verdict, its evidence and its own review decision. A breached clause has
 * to stay answerable as that clause, because that is what an audit asks. So the
 * report carries two counts and says which is which: how many clauses are
 * breached, and how many things there are to fix.
 */

export type RootCause = {
  /** A short noun phrase naming the fact in the design, not the rule. */
  label: string;
  /** What the design does, or does not do, in one sentence. */
  summary: string;
  /** The single change that resolves every finding in the group. */
  fix: string;
  /** The findings this fact produced. Always two or more. */
  findingIds: string[];
};

export type RootCauseView = {
  /** "skipped" and "failed" carry a note; both mean an ungrouped report. */
  state: "complete" | "failed" | "skipped";
  note: string | null;
  causes: RootCause[];
};

/** The run's JSON, narrowed. Null for a run that has none, which is not a fault. */
export function readRootCauses(value: unknown): RootCauseView | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const causes: RootCause[] = [];
  for (const item of Array.isArray(row.groups) ? row.groups : []) {
    if (!item || typeof item !== "object") continue;
    const group = item as Record<string, unknown>;
    const findingIds = (Array.isArray(group.findings) ? group.findings : []).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    // Two is what makes it a cause rather than a finding said twice. The worker
    // enforces this as well; a group that lost a member between the two would
    // otherwise draw a heading over a single row.
    if (findingIds.length < 2 || typeof group.label !== "string" || !group.label.trim()) {
      continue;
    }
    causes.push({
      label: group.label.trim(),
      summary: typeof group.summary === "string" ? group.summary.trim() : "",
      fix: typeof group.fix === "string" ? group.fix.trim() : "",
      findingIds,
    });
  }

  const state = row.state;
  return {
    state: state === "failed" || state === "skipped" ? state : "complete",
    note: typeof row.note === "string" && row.note.trim() ? row.note.trim() : null,
    causes,
  };
}

/**
 * The cause each finding belongs to, by finding id.
 *
 * Built once per render rather than searched per row: a report of eighty
 * findings would otherwise walk every group for every row it draws.
 */
export function causeByFinding(view: RootCauseView | null): Map<string, RootCause> {
  const out = new Map<string, RootCause>();
  for (const cause of view?.causes ?? []) {
    for (const id of cause.findingIds) {
      // First claim wins, matching the worker. A finding cannot have two causes
      // and the two halves must not disagree about which one it has.
      if (!out.has(id)) out.set(id, cause);
    }
  }
  return out;
}

/**
 * How many separate things there are to fix among these findings.
 *
 * Not the number of findings, and not the number of causes either: a report is
 * some grouped findings plus some ungrouped ones, and the work is one piece per
 * cause plus one per finding that stands alone. This is the number a reviewer
 * is really asking for when they look at a list of twelve.
 */
export function workItems(
  findingIds: string[],
  view: RootCauseView | null,
): { findings: number; causes: number; work: number } {
  const byFinding = causeByFinding(view);
  const seen = new Set<RootCause>();
  let alone = 0;
  for (const id of findingIds) {
    const cause = byFinding.get(id);
    if (cause) seen.add(cause);
    else alone += 1;
  }
  return { findings: findingIds.length, causes: seen.size, work: seen.size + alone };
}
