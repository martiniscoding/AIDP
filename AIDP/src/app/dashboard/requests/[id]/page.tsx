import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CircleAlert, FileText, Gauge, ShieldAlert, ShieldCheck } from "lucide-react";
import { requireWorkspace } from "@/lib/access/gate";
import {
  CHECKING,
  DRAFT,
  FAILED,
  advanceSubmitted,
  canEditRequest,
  getRequestDraft,
  whatIsMissing,
} from "@/lib/ingest/requests";
import { resultsFor } from "@/lib/significance/record";
import { PageHeader } from "@/components/ui/PageHeader";
import { IntakeWizard, type Draft } from "./IntakeWizard";

export const dynamic = "force-dynamic";

/** What each state means to the person who filed it, rather than to the queue. */
const STATE: Record<string, { label: string; blurb: string }> = {
  draft: { label: "Draft", blurb: "Not submitted yet. Nobody else is waiting on it." },
  submitted: {
    label: "Submitted",
    blurb: "Being read. The review starts as soon as it has been indexed.",
  },
  checking: { label: "Under review", blurb: "Being checked against your standards." },
  reported: { label: "Reported", blurb: "The review is done and the report is ready." },
  decided: { label: "Decided", blurb: "An outcome has been recorded." },
  failed: { label: "Stopped", blurb: "It could not be carried further." },
};

/** A date input needs YYYY-MM-DD and nothing else. */
function asDateInput(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

export default async function RequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const access = await requireWorkspace();

  // A request in another customer is indistinguishable from one that does not
  // exist, for the same reason a document is — saying "forbidden" would confirm
  // it is real.
  const first = await getRequestDraft(access.organisation.id, id);
  if (!first) notFound();

  // The other place somebody waits for a report, and so the other place a ping
  // that never arrived has to be recoverable from. Scoped to this one document,
  // and skipped unless this request is actually waiting on one — see the note
  // on the list page for why a page does this at all.
  const stuck = first.state === "submitted" && first.documentId && !first.runId;
  const request = stuck
    ? ((await advanceSubmitted({ documentId: first.documentId! })),
      (await getRequestDraft(access.organisation.id, id)) ?? first)
    : first;

  const editable = request.state === DRAFT || request.state === FAILED;
  const mayEdit = canEditRequest(access, request);

  // The server's own answer, not a copy of it. The wizard shows what this says
  // and the submit action enforces it; a second opinion in the browser would
  // eventually disagree with the one that matters.
  const missing = whatIsMissing({
    ...request,
    estimatedCost: request.estimatedCost === null ? null : String(request.estimatedCost),
  });

  const state = STATE[request.state] ?? {
    label: request.state,
    blurb: "",
  };

  // The brief's Step 2, which runs on submission. Null means it has not run —
  // a draft, or a check that could not be completed — and reads as "not yet"
  // rather than as "not significant", which are very different answers.
  const significance = request.significance;
  const criteria = significance ? await resultsFor(request.id) : [];
  const triggered = criteria.filter((result) => result.triggered);

  const draft: Draft = {
    id: request.id,
    reference: request.reference,
    title: request.title,
    summary: request.summary,
    team: request.team,
    plannedStart: asDateInput(request.plannedStart),
    problemStatement: request.problemStatement,
    solutionOverview: request.solutionOverview,
    technologies: request.technologies,
    newTechnologyComponent: request.newTechnologyComponent,
    newTechnologyComponentName: request.newTechnologyComponentName,
    replacesTechnologyComponent: request.replacesTechnologyComponent,
    replacedTechnologyComponentName: request.replacedTechnologyComponentName,
    integrationPoints: request.integrationPoints,
    authMechanism: request.authMechanism,
    dataStores: request.dataStores,
    dataClassification: request.dataClassification,
    newOrDuplicatedStorage: request.newOrDuplicatedStorage,
    hostingEnvironment: request.hostingEnvironment,
    estimatedCost: request.estimatedCost === null ? "" : String(request.estimatedCost),
    newLicenceRequired: request.newLicenceRequired,
    newLicenceVendor: request.newLicenceVendor,
    linesOfBusiness: request.linesOfBusiness,
    newBusinessCapability: request.newBusinessCapability,
    regulatoryImpact: request.regulatoryImpact,
    regulatoryImpactDetail: request.regulatoryImpactDetail,
    securityDomainChange: request.securityDomainChange,
    securityDomainChangeDetail: request.securityDomainChangeDetail,
    applicationDecommissioned: request.applicationDecommissioned,
    applicationDecommissionedName: request.applicationDecommissionedName,
    applicationCriticality: request.applicationCriticality,
    newApplicationStandard: request.newApplicationStandard,
    dataGovernanceEscalation: request.dataGovernanceEscalation,
    standardsChangeProposed: request.standardsChangeProposed,
    standardsChangeDetail: request.standardsChangeDetail,
  };

  return (
    <>
      <Link
        href="/dashboard/requests"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink/60 hover:text-ink"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Architecture requests
      </Link>

      <PageHeader
        eyebrow={request.reference}
        title={request.title || "Untitled request"}
        lede={state.blurb}
        meta={
          <span className="inline-flex items-center gap-1.5">
            <Gauge size={13} aria-hidden="true" />
            {state.label}
          </span>
        }
      />

      {request.state === FAILED && request.failureReason && (
        <div className="mb-5 flex gap-2 rounded-xl border border-warn-line bg-warn-tint px-4 py-3">
          <CircleAlert size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <div>
            <p className="text-[13px] font-medium text-ink">This request stopped</p>
            <p className="mt-0.5 text-[12.5px] text-ink/75">{request.failureReason}</p>
            {mayEdit && (
              <p className="mt-1 text-[12.5px] text-ink/60">
                Correct it below and submit it again.
              </p>
            )}
          </div>
        </div>
      )}

      {significance && (
        <div
          className={`mb-5 rounded-xl border px-4 py-3 ${
            significance === "significant"
              ? "border-warn-line bg-warn-tint"
              : "border-ok-line bg-ok-tint"
          }`}
        >
          <div className="flex gap-2">
            {significance === "significant" ? (
              <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
            ) : (
              <ShieldCheck size={15} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-ink">
                {significance === "significant"
                  ? "Architecturally significant"
                  : "Not architecturally significant"}
              </p>
              <p className="mt-0.5 text-[12.5px] text-ink/75">
                {significance === "significant"
                  ? `${triggered.length} of ${criteria.length} categories triggered. This needs a person before it proceeds.`
                  : `None of the ${criteria.length} categories checked were triggered. It can proceed on its findings alone.`}
              </p>

              {triggered.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {triggered.map((result) => {
                    // The working, as the check recorded it. "Cost Impact
                    // triggered because 7,500,000 is at least 5,000,000" is a
                    // line a review board can act on; "Cost Impact: triggered"
                    // is one they have to come back and ask about.
                    const why = (result.triggeredBy as { text?: string; actual?: string }[]) ?? [];
                    return (
                      <li key={result.id} className="text-[12.5px] text-ink/80">
                        <span className="font-medium">{result.categoryLabel}</span>
                        {why.length > 0 && (
                          <span className="text-ink/65">
                            {" — "}
                            {why
                              .map((entry) =>
                                entry.actual ? `${entry.text} The request says ${entry.actual}.` : entry.text,
                              )
                              .join(" ")}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {editable ? (
        <>
          {!mayEdit && (
            <p className="mb-3 text-[12.5px] text-ink/60">
              Raised by {request.requestedByName || "somebody else"}. Only they, or an
              administrator, can change it.
            </p>
          )}
          {missing.length > 0 && (
            <div className="mb-4 rounded-xl border border-line bg-canvas-sunk px-4 py-3">
              <p className="text-[12.5px] font-medium text-ink">
                Still needed before this can be submitted
              </p>
              <p className="mt-0.5 text-[12.5px] text-ink/70">
                {missing.join(", ")}.
              </p>
            </div>
          )}
          <IntakeWizard draft={draft} missing={missing.length} canEdit={mayEdit} />
        </>
      ) : (
        <div className="rounded-xl border border-line bg-card px-4 py-4">
          <p className="text-[13px] text-ink/80">
            This request has been submitted, so its answers are now the thing that was
            assessed. A changed design is a new request.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {request.runId && (
              <Link
                href={`/dashboard/requests/${request.id}/report`}
                className="inline-flex items-center gap-1.5 rounded-full bg-royal px-4 py-1.5 text-[13px] font-medium text-white"
              >
                <FileText size={14} aria-hidden="true" />
                Open the report
              </Link>
            )}
            {request.documentId && (
              <Link
                href={`/dashboard/documents/${request.documentId}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-1.5 text-[13px] text-ink/80 hover:text-ink"
              >
                What was submitted
              </Link>
            )}
          </div>
          {request.state === CHECKING && (
            <p className="mt-3 text-[12.5px] text-ink/55">
              The report fills in as each standard is checked.
            </p>
          )}
        </div>
      )}
    </>
  );
}
