"use client";

import { CircleAlert, FileText, Loader2 } from "lucide-react";
import { ReadyTick, UploadZone } from "@/app/dashboard/documents/UploadZone";

/** One design already attached to this request, as the server sees it. */
export type RequestDesign = {
  id: string;
  title: string;
  status: string;
  chunks: number;
};

/**
 * The designs a request carries, and the way to add one.
 *
 * This is where a requestor's own drawings and documents go in. It used to be
 * somewhere else entirely: a design was uploaded to a *project* from the
 * library screens, and the request was a form that happened to be filed
 * against the same project. Two screens, two mental models, and no way to tell
 * from the request whether the thing it would be judged on had been attached.
 *
 * So it sits inside the intake wizard, in the Architecture step, beside the
 * questions about what the solution runs on — which is the moment somebody has
 * the diagram open anyway.
 *
 * ## Why the upload zone is the library's own
 *
 * `UploadZone` is reused rather than rewritten. It already holds everything
 * that is easy to get wrong and expensive to get wrong twice: the type sniff
 * before anything is sent, the size ceiling, the batch limit, sequential
 * uploads so eight files do not race, per-file receipts, and the direct-to-
 * storage path that exists because a serverless function cannot accept a body
 * over 4.5MB. A second dropzone written for this screen would have been a
 * second set of those decisions, drifting.
 *
 * It is handed a request id instead of a project id. The request owns a project
 * nobody is shown, and the server is what resolves one to the other — see
 * `designTarget`, which is also what refuses a design aimed at somebody else's
 * draft or at a request that has already been submitted.
 *
 * ## What the list is for
 *
 * A document is not assessable the moment it finishes uploading: it has to be
 * parsed, chunked and embedded first, and until that is done there is nothing
 * for retrieval to find in it. "Start assessing" refuses while any of them is
 * still being read, deliberately — a run started early would quietly leave a
 * design out of its own report. This list is how somebody knows which document
 * they are waiting on, instead of meeting a refusal with no explanation.
 */
export function RequestDesigns({
  requestId,
  designs,
  canEdit,
}: {
  requestId: string;
  designs: RequestDesign[];
  canEdit: boolean;
}) {
  return (
    <div className="sm:col-span-2">
      <div className="mb-2">
        <p className="text-[13px] font-medium text-ink/78">Design documents</p>
        <p className="mt-0.5 text-[12.5px] text-ink/64">
          Diagrams, design notes, a solution deck — whatever describes this
          architecture. They are assessed against your standards alongside the
          answers on these pages.
        </p>
      </div>

      {canEdit && (
        <UploadZone role="assessed" label="Add a design" requestId={requestId} />
      )}

      {designs.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink/55">
          Nothing attached yet. The answers on their own can still be submitted and
          assessed.
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {designs.map((design) => {
            // Three cases, and they are the same three `advanceSubmitted` works
            // from: in and readable, never going to be readable, or still on its
            // way through the stages. Anything that is not "ready" or "failed"
            // is the third — naming the individual stages here would be a second
            // copy of the engine's vocabulary, kept up to date by nobody.
            const ready = design.status === "ready" && design.chunks > 0;
            const failed = design.status === "failed";

            return (
              <li
                key={design.id}
                className="flex items-start gap-2 rounded-xl border border-line bg-canvas-sunk/50 px-3 py-2"
              >
                <FileText
                  size={14}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-ink/45"
                />
                <span className="min-w-0 flex-1 text-[12.5px] text-ink/80">
                  {design.title}
                </span>

                {ready ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-ink/60">
                    <ReadyTick />
                    Read
                  </span>
                ) : failed ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-warn">
                    <CircleAlert size={13} aria-hidden="true" />
                    Could not be read
                  </span>
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-ink/55">
                    <Loader2 size={13} aria-hidden="true" className="animate-spin" />
                    Being read
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
