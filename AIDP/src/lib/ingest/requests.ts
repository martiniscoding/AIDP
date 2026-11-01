import { prisma } from "@/lib/prisma";
import type { Access } from "@/lib/access/gate";
import { DOCX_MIME, record, type Refusal } from "@/lib/ingest/intake";
import { renderRequest, type RenderableRequest } from "@/lib/ingest/render-request";
import { ProjectRefused, assessableDesigns, startProjectRun } from "@/lib/ingest/projects";
import { canManageStandards } from "@/lib/access/roles";
import { runCriteriaCheck } from "@/lib/significance/record";

/**
 * Architecture requests — the intake form, and the bridge from it to the engine.
 *
 * The engine assesses documents. It parses them into sections, embeds the
 * passages, and every verdict it reaches quotes the submitted text word for
 * word. A form has none of that, so submitting one renders the answers into a
 * real .docx and hands it to the ordinary upload door. Nothing downstream is
 * changed, or even aware: by the time a worker sees it, this is a document like
 * any other.
 *
 * Everything that decides *whether* a request may be submitted, and everything
 * that happens once it is, lives here — the same reasoning as intake.ts, and
 * for the same reason: there will be more than one way in (a wizard today, an
 * API for a supplier portal later) and two doors are only safe if they cannot
 * disagree.
 *
 * ## Three things this file is careful about
 *
 * **The criteria check runs here, not on a queue.** The brief's Step 2 is a few
 * comparisons over answers already in the row; Step 3 is the one that waits for
 * a document to index and a hundred model calls to return. "In parallel" means
 * neither gates the other, not that both need a worker.
 *
 * **Submitting is idempotent, explicitly.** It would be neater to lean on
 * `record()` being content-addressed — render the same answers, hash to the
 * same bytes, resolve to the same document. That does not work here: the
 * `docx` library stamps `dcterms:created` into every package it writes and
 * offers no way to fix it, so two renderings of one request are never byte
 * identical and the content hash can never match. Idempotency is therefore
 * handled in the open: a request that already has a document returns it, an
 * earlier attempt's document is found and adopted, and a lost race deletes the
 * copy it created rather than leaving a second design for the assessment to
 * read twice. See `submitRequest`.
 *
 * **Indexing happens by itself; the assessment is pressed.** The worker chain
 * stops at embed — `NEXT_STAGE["embed"]` is None — so nothing downstream opens
 * an analyse job on its own. The work is split in two here: `advanceSubmitted`
 * notices that a submission has finished indexing and moves it to "ready", and
 * `startAssessment` opens the run — which somebody calls by pressing a button.
 *
 * It used to be one step. Indexing finished and the run began in the same
 * breath, which was right while the only thing being assessed was the rendered
 * intake form. The flow now puts the designs inside the request: the requestor
 * uploads them, finishes, and presses "Start assessing" when the request is
 * whole. A run that opened itself the moment the first upload indexed would
 * assess half a submission. So the half that cannot wait for a person stays
 * automatic, and it is reached two ways.
 *
 * The embed worker calls it the moment a document lands `ready`
 * (Workers/aidp/notify.py). That is the fast path and nearly always the only
 * one that runs.
 *
 * The screens call it too, before they draw. A ping sent while the app was
 * redeploying is not retried — the worker swallows it on purpose — so without a
 * second route in, such a request waits in "submitted" for ever with a document
 * that is ready and a button that never turns on. Sweeping on the two screens somebody
 * waits on costs an indexed lookup that almost always matches nothing, and puts
 * the repair where the problem is noticed. See the note on
 * src/app/dashboard/requests/page.tsx.
 *
 * **A request that cannot proceed says so.** A document that failed to parse
 * ends in "failed" with a reason — never in "submitted" for ever while somebody
 * waits for a report.
 *
 * An organisation with no standards indexed is no longer one of these. It used
 * to fail the request, which was the only option while the run opened itself
 * with nobody watching. Now that somebody presses the button, they are told on
 * the press and the request stays where it is, so that the same press works
 * once the library is filled. Failing it outright would have closed a
 * submission over a library its requestor may not even be allowed to fill.
 */

export class RequestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestRefused";
  }
}

export const DRAFT = "draft";
export const SUBMITTED = "submitted";
/**
 * Indexed, and waiting for somebody to press "Start assessing".
 *
 * The state a pressed assessment made necessary. "submitted" used to carry two
 * meanings at once — "rendered, still indexing" and "indexed, about to run" —
 * and the second never lasted long enough to need a name, because the run
 * opened by itself the moment indexing finished. Now that a person opens it,
 * the difference between the two is the whole question the screen has to
 * answer: a request still being read has nothing to offer, and one that is
 * ready offers a button.
 */
export const READY = "ready";
export const CHECKING = "checking";
export const REPORTED = "reported";
export const DECIDED = "decided";
export const FAILED = "failed";

/** How a reference reads: AR-0001. Four digits carries ten thousand requests,
 *  which is further than any customer's governance process will get before
 *  somebody asks for a different format. */
const REFERENCE_PREFIX = "AR-";
const REFERENCE_DIGITS = 4;

/** Attempts at a free reference before giving up. Each collision means another
 *  request was created between the count and the insert, so this is a
 *  concurrency bound, not a retry-until-it-works. */
const REFERENCE_ATTEMPTS = 5;

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "23505";
}

/**
 * The next free reference for this customer.
 *
 * Counted rather than sequenced, and the unique constraint is what makes that
 * safe: two people filing at the same moment both compute AR-0008, one insert
 * wins, and the loser counts again. A Postgres sequence would avoid the retry
 * and cost a per-organisation sequence object plus the gaps a rolled-back
 * transaction leaves — and a governance register with holes in its numbering is
 * a question somebody will eventually have to answer.
 */
async function reference(organisationId: string): Promise<string> {
  const used = await prisma.architectureRequest.count({ where: { organisationId } });
  return `${REFERENCE_PREFIX}${String(used + 1).padStart(REFERENCE_DIGITS, "0")}`;
}

export type CreateInput = {
  title: string;
  summary?: string;
  team?: string;
};

/**
 * Open a request. Draft, and deliberately undemanding: the wizard saves as the
 * requestor goes, and a half-filled form is a normal state for one to be in.
 * What a *submission* has to carry is `whatIsMissing`'s problem.
 *
 * ## Why this creates a project nobody asked for
 *
 * A request used to name one, which meant opening a project before filing
 * anything — and a requestor who had not done that was shown nothing to press
 * at all, because `NewRequest` had no projects to offer and returned null. The
 * request is the unit of work now. It is opened, filled in, has its designs
 * uploaded into it, and is assessed, and the word "project" appears on none of
 * those screens.
 *
 * The row cannot simply go, because an assessment's scope *is* a project.
 * `AssessmentRun` carries exactly one of `documentId` or `projectId` — the
 * `assessment_run_one_scope` check constraint — the analyse job identifies
 * itself by run id over a project's designs, and the worker's own `designs()`
 * reads the project. A request holds several documents between them: the
 * rendered intake answers, every design its requestor uploads, a diagram. So
 * it is a project run or it is nothing, and teaching a run to name a request
 * instead would be a change to the engine, which is not ours to make.
 *
 * One project per request, therefore, written here and never shown. Its name
 * carries the reference because `Project` holds `@@unique([organisationId,
 * name])` while two requests called "Portal Upgrade" are entirely ordinary: the
 * reference is already unique per customer, so it is what keeps the name unique
 * too — and what makes the row recognisable in the one place these are still
 * visible, which is the assessment history.
 *
 * Both rows go in one transaction. A reference that collides has to roll the
 * project back with it; without that, every retry would leave behind a project
 * belonging to a request that was never created, accumulating where nobody is
 * looking.
 *
 * `designRelationship` is left at its default, "components", which is the right
 * answer here: the designs in one request describe a single solution between
 * them, not rival candidates to be judged against each other. A request whose
 * designs genuinely are alternatives is a question for the brief, not a default
 * to guess at.
 */
export async function createRequest(
  access: Access,
  input: CreateInput,
): Promise<{ id: string; reference: string }> {
  const title = input.title.trim();
  if (!title) throw new RequestRefused("Give the request a title.");
  if (title.length > 200) throw new RequestRefused("That title is too long.");

  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
    const next = await reference(access.organisation.id);
    try {
      return await prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: {
            organisationId: access.organisation.id,
            // Both halves on purpose: the reference is what keeps this unique,
            // the title is what makes it legible to whoever meets it later.
            name: `${next} ${title}`.slice(0, 120),
            createdById: access.user.id,
            createdByName: access.user.name || access.user.email,
          },
          select: { id: true },
        });

        return tx.architectureRequest.create({
          data: {
            organisationId: access.organisation.id,
            reference: next,
            projectId: project.id,
            title,
            summary: (input.summary ?? "").trim().slice(0, 2000),
            team: (input.team ?? "").trim().slice(0, 200),
            requestedById: access.user.id,
            requestedByName: access.user.name || access.user.email,
          },
          select: { id: true, reference: true },
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new RequestRefused("Too many requests were filed at once. Try again.");
}



/** What the list and the detail screen read. The wizard's own fields are read
 *  from the row directly; this is the shape of a request as a *reader* meets
 *  it. */
export type RequestSummary = {
  id: string;
  reference: string;
  title: string;
  summary: string;
  state: string;
  significance: string | null;
  failureReason: string | null;
  requestedByName: string;
  projectId: string;
  projectName: string;
  documentId: string | null;
  runId: string | null;
  submittedAt: Date | null;
  createdAt: Date;
};

const SUMMARY_SELECT = {
  id: true,
  reference: true,
  title: true,
  summary: true,
  state: true,
  significance: true,
  failureReason: true,
  requestedByName: true,
  projectId: true,
  documentId: true,
  runId: true,
  submittedAt: true,
  createdAt: true,
  project: { select: { name: true } },
} as const;

function toSummary(
  row: { project: { name: string } } & Omit<RequestSummary, "projectName">,
): RequestSummary {
  const { project, ...rest } = row;
  return { ...rest, projectName: project.name };
}

/**
 * Every request in the organisation, newest first.
 *
 * Everyone sees every one, for the same reason everyone sees every project: a
 * workspace is shared, and an architect asked to review a submission should not
 * have to be invited to it first.
 */
export async function listRequests(organisationId: string): Promise<RequestSummary[]> {
  const rows = await prisma.architectureRequest.findMany({
    where: { organisationId },
    select: SUMMARY_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toSummary);
}

/** One request, scoped to the caller's organisation. Null rather than a
 *  refusal when it belongs to another customer: saying "forbidden" would
 *  confirm it exists. */
export async function getRequest(
  organisationId: string,
  id: string,
): Promise<RequestSummary | null> {
  const row = await prisma.architectureRequest.findFirst({
    where: { id, organisationId },
    select: SUMMARY_SELECT,
  });
  return row ? toSummary(row) : null;
}

/** The whole row, for the wizard, which writes every field it reads. */
export async function getRequestDraft(organisationId: string, id: string) {
  return prisma.architectureRequest.findFirst({ where: { id, organisationId } });
}

/** The criticality answers the brief offers. A value outside this is a form
 *  that has drifted from the significance criterion reading it. */
export const CRITICALITIES = ["standard", "business_critical", "mission_critical"] as const;

export type Criticality = (typeof CRITICALITIES)[number];

/** Clamps, so a pasted essay cannot become a column nobody can render. Generous
 *  on the two fields the compliance check actually reads. */
const LIMITS = {
  title: 200,
  short: 200,
  line: 2000,
  prose: 20_000,
  listItem: 200,
  list: 40,
} as const;

/** The most a cost can be before it is certainly a typo. The column is
 *  Decimal(18,2); this is the number a person could have meant. */
const MAX_COST = 1e15;

function text(value: unknown, limit: number): string | undefined {
  if (value === undefined) return undefined;
  return String(value ?? "").trim().slice(0, limit);
}

function flag(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  return value === true || value === "true" || value === "on" || value === "yes";
}

/** A list of short strings: trimmed, blanks dropped, duplicates dropped, capped.
 *
 *  Order is kept rather than sorted — the requestor listed their technologies in
 *  the order they think about them, and the rendered document reads better for
 *  it. */
function list(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,\n]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const item = String(entry ?? "").trim().slice(0, LIMITS.listItem);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= LIMITS.list) break;
  }
  return out;
}

function date(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new RequestRefused("That is not a date this form can read.");
  }
  return parsed;
}

/**
 * The estimated cost, as a string Prisma will store as Decimal.
 *
 * Grouping separators are stripped, because a person typing a large number
 * types them and a form that refuses "7,500,000" is a form that teaches people
 * to distrust it. Everything else is refused rather than coerced: the Cost
 * Impact criterion compares this against the organisation's governance
 * threshold, and a number nobody meant is a classification nobody meant.
 */
function cost(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const cleaned = String(value).replace(/[\s,_]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new RequestRefused("Give the estimated cost as a number, or leave it blank.");
  }
  if (parsed > MAX_COST) {
    throw new RequestRefused("That estimated cost is too large to be a real figure.");
  }
  return parsed.toFixed(2);
}

function criticality(value: unknown): Criticality | undefined {
  if (value === undefined) return undefined;
  const given = String(value ?? "");
  return (CRITICALITIES as readonly string[]).includes(given)
    ? (given as Criticality)
    : "standard";
}

/** Every field the wizard can write. All optional: it saves as the requestor
 *  goes, one group at a time, and a group they have not reached yet must not
 *  blank the one they have. */
export type UpdateInput = {
  // Group A
  title?: string;
  summary?: string;
  team?: string;
  plannedStart?: string | Date | null;
  // Group B
  problemStatement?: string;
  solutionOverview?: string;
  // Group C
  technologies?: string[] | string;
  newTechnologyComponent?: unknown;
  newTechnologyComponentName?: string;
  replacesTechnologyComponent?: unknown;
  replacedTechnologyComponentName?: string;
  integrationPoints?: string;
  authMechanism?: string;
  dataStores?: string;
  dataClassification?: string;
  newOrDuplicatedStorage?: unknown;
  hostingEnvironment?: string;
  // Group D
  estimatedCost?: string | number | null;
  newLicenceRequired?: unknown;
  newLicenceVendor?: string;
  linesOfBusiness?: string[] | string;
  newBusinessCapability?: unknown;
  regulatoryImpact?: unknown;
  regulatoryImpactDetail?: string;
  securityDomainChange?: unknown;
  securityDomainChangeDetail?: string;
  applicationDecommissioned?: unknown;
  applicationDecommissionedName?: string;
  applicationCriticality?: string;
  newApplicationStandard?: unknown;
  dataGovernanceEscalation?: unknown;
  standardsChangeProposed?: unknown;
  standardsChangeDetail?: string;
};

/**
 * May this person change the request?
 *
 * Whoever raised it, or an administrator. The same reasoning as
 * `canEditProject`: a request is somebody's piece of work and they must be able
 * to finish filling it in, but one employee should not be able to rewrite
 * another's submission — least of all after it has been assessed, which is why
 * `updateRequest` also refuses anything that is no longer a draft.
 */
export function canEditRequest(
  access: Access,
  request: { requestedById: string | null },
): boolean {
  return (
    canManageStandards(access.organisation.role) || request.requestedById === access.user.id
  );
}

/**
 * Where a design uploaded "into a request" actually goes, and whether this
 * person may put it there.
 *
 * The upload doors store a design against a project, because that is what a
 * `Document` carries and what an assessment reads. A requestor has no project:
 * they have a request, which owns one they are never shown. So the id that
 * arrives from the browser is a request's, and this is the only thing that
 * turns one into a project id.
 *
 * It lives here, with the rest of the request's rules, rather than in
 * intake.ts — a request's own module is where "may this person touch this
 * request, in this state" belongs, and putting it in intake.ts would have meant
 * intake.ts importing this module while this module already imports intake.ts.
 * Both doors call this one function, so neither can be the lenient one; see the
 * note on `authorise`, which they call straight afterwards with what comes back.
 *
 * ## Why only a draft
 *
 * Designs are part of what is being submitted. Once a request is submitted, its
 * answers and its designs are the thing that was assessed: the findings quote
 * them, the significance result was reached from them, and the report explains
 * *those* documents. A design added afterwards would be read by the next run
 * and by nothing that has already been written down — a report that silently
 * stops describing its own submission.
 *
 * A failed request is editable again, and so takes designs again, for the same
 * reason `updateRequest` lets one be corrected: it never got as far as a
 * verdict, so there is nothing yet for a late upload to contradict.
 *
 * Statuses rather than thrown refusals, because both callers are HTTP doors and
 * the shape is intake.ts's `Refusal` — 404 for a request in another customer
 * (saying "forbidden" would confirm it exists), 403 for somebody else's draft,
 * 409 for a request that has moved past taking designs.
 */
export async function designTarget(
  access: Access,
  requestId: string,
): Promise<{ projectId: string } | Refusal> {
  const request = await prisma.architectureRequest.findFirst({
    where: { id: requestId, organisationId: access.organisation.id },
    select: { id: true, state: true, projectId: true, requestedById: true },
  });
  if (!request) return { error: "That request no longer exists.", status: 404 };

  if (!canEditRequest(access, request)) {
    return {
      error:
        "Only the person who raised this request, or an administrator, can add designs to it.",
      status: 403,
    };
  }

  if (request.state !== DRAFT && request.state !== FAILED) {
    return {
      error:
        "This request has been submitted, so its designs are now the thing that was assessed. A changed design is a new request.",
      status: 409,
    };
  }

  return { projectId: request.projectId };
}

/**
 * Fill in a draft, one group at a time.
 *
 * Only a draft, or one that failed and is being corrected. Once a request has
 * been submitted its answers are the thing that was assessed: the rendered
 * document, the findings and the significance result all describe *these*
 * words, and editing them afterwards would leave a report explaining a
 * submission that no longer exists. A changed design is a new request, which is
 * also what the brief's revise-and-resubmit path says.
 *
 * Every field is optional and `undefined` means "not on this step", not
 * "clear it" — a four-step wizard saving as it goes would otherwise blank
 * Group D every time somebody corrected Group A.
 */
export async function updateRequest(
  access: Access,
  id: string,
  input: UpdateInput,
): Promise<void> {
  const request = await prisma.architectureRequest.findFirst({
    where: { id, organisationId: access.organisation.id },
    select: { id: true, state: true, requestedById: true },
  });
  if (!request) throw new RequestRefused("That request no longer exists.");
  if (!canEditRequest(access, request)) {
    throw new RequestRefused(
      "Only an administrator, or whoever raised it, can change this request.",
    );
  }
  if (request.state !== DRAFT && request.state !== FAILED) {
    throw new RequestRefused(
      "This request has been submitted. Raise a new one rather than changing what was assessed.",
    );
  }

  const title = text(input.title, LIMITS.title);
  if (title !== undefined && !title) throw new RequestRefused("Give the request a title.");

  const data = {
    title,
    summary: text(input.summary, LIMITS.line),
    team: text(input.team, LIMITS.short),
    plannedStart: date(input.plannedStart),

    problemStatement: text(input.problemStatement, LIMITS.prose),
    solutionOverview: text(input.solutionOverview, LIMITS.prose),

    technologies: list(input.technologies),
    newTechnologyComponent: flag(input.newTechnologyComponent),
    newTechnologyComponentName: text(input.newTechnologyComponentName, LIMITS.short),
    replacesTechnologyComponent: flag(input.replacesTechnologyComponent),
    replacedTechnologyComponentName: text(input.replacedTechnologyComponentName, LIMITS.short),
    integrationPoints: text(input.integrationPoints, LIMITS.prose),
    authMechanism: text(input.authMechanism, LIMITS.prose),
    dataStores: text(input.dataStores, LIMITS.prose),
    dataClassification: text(input.dataClassification, LIMITS.short),
    newOrDuplicatedStorage: flag(input.newOrDuplicatedStorage),
    hostingEnvironment: text(input.hostingEnvironment, LIMITS.prose),

    estimatedCost: cost(input.estimatedCost),
    newLicenceRequired: flag(input.newLicenceRequired),
    newLicenceVendor: text(input.newLicenceVendor, LIMITS.short),
    linesOfBusiness: list(input.linesOfBusiness),
    newBusinessCapability: flag(input.newBusinessCapability),
    regulatoryImpact: flag(input.regulatoryImpact),
    regulatoryImpactDetail: text(input.regulatoryImpactDetail, LIMITS.line),
    securityDomainChange: flag(input.securityDomainChange),
    securityDomainChangeDetail: text(input.securityDomainChangeDetail, LIMITS.line),
    applicationDecommissioned: flag(input.applicationDecommissioned),
    applicationDecommissionedName: text(input.applicationDecommissionedName, LIMITS.short),
    applicationCriticality: criticality(input.applicationCriticality),
    newApplicationStandard: flag(input.newApplicationStandard),
    dataGovernanceEscalation: flag(input.dataGovernanceEscalation),
    standardsChangeProposed: flag(input.standardsChangeProposed),
    standardsChangeDetail: text(input.standardsChangeDetail, LIMITS.line),
  };

  // Prisma treats an explicit `undefined` as "leave alone", which is exactly
  // what a per-step save wants — but only because every helper above returns
  // `undefined` for a field the step did not carry. Stripping them makes that
  // contract visible here rather than resting on a Prisma behaviour.
  const changes = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(changes).length === 0) return;

  await prisma.architectureRequest.update({ where: { id: request.id }, data: changes });
}

/** The fields a submission has to carry, beyond a title. Group A and B of the
 *  brief's intake model, and then either a diagram or the whole of Group C. */
const GROUP_C: { field: keyof RenderableRequest; label: string }[] = [
  { field: "technologies", label: "the technologies and platforms used" },
  { field: "integrationPoints", label: "the integration points" },
  { field: "authMechanism", label: "the authentication and authorisation mechanism" },
  { field: "dataStores", label: "the data stores used" },
  { field: "dataClassification", label: "the data classification" },
  { field: "hostingEnvironment", label: "the hosting and deployment environment" },
];

type Submittable = RenderableRequest & { diagramDocumentId: string | null };

/**
 * What stops this being submitted, in the requestor's words. Empty when nothing
 * does.
 *
 * This is the brief's own v2 revision, and the whole reason it was revised: the
 * original intake listed the solution description and the diagram as optional,
 * which cannot work when the point is to run a compliance check against them.
 * There has to be something to check.
 *
 * The diagram-or-Group-C rule is the one piece of real conditional logic. A
 * diagram is the faster path for the requestor; without one, every structured
 * field becomes a required manual entry, and the platform never proceeds with
 * an incomplete picture of the architecture.
 */
export function whatIsMissing(request: Submittable): string[] {
  const missing: string[] = [];
  if (!request.title.trim()) missing.push("a title");
  if (!request.plannedStart) missing.push("the planned implementation start date");
  if (!request.problemStatement.trim()) missing.push("the problem statement");
  if (!request.solutionOverview.trim()) missing.push("the solution overview");

  if (!request.diagramDocumentId) {
    for (const { field, label } of GROUP_C) {
      const value = request[field];
      const empty = Array.isArray(value) ? value.length === 0 : !String(value ?? "").trim();
      if (empty) missing.push(label);
    }
  }
  return missing;
}

/** A filename a person would recognise in the document library, and that
 *  `record()` can derive a readable title from if it ever needs to. */
function fileName(reference: string, title: string): string {
  const clean = title.replace(/[^\w\s-]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${reference} ${clean}.docx`;
}

/**
 * Submit a request: render it, take it in, and let it index.
 *
 * The assessment is *not* started here. The document has to finish parsing,
 * chunking and embedding first — `startProjectRun` refuses a design that is
 * still indexing, and rightly: a clause judged against an empty search comes
 * back absent. `advanceSubmitted` picks it up once it is ready.
 */
export async function submitRequest(
  access: Access,
  id: string,
): Promise<{ documentId: string; reference: string }> {
  const request = await prisma.architectureRequest.findFirst({
    where: { id, organisationId: access.organisation.id },
  });
  if (!request) throw new RequestRefused("That request no longer exists.");

  // Already through. A retry after the link was written has nothing left to do,
  // and saying so is not an error — it is the answer.
  if (request.documentId) {
    return { documentId: request.documentId, reference: request.reference };
  }

  // "submitted" with no document is an attempt that did not finish. It is
  // allowed back in, and the search below is what stops it rendering a second
  // copy of a document the first attempt already got in.
  if (![DRAFT, FAILED, SUBMITTED].includes(request.state)) {
    throw new RequestRefused("This request has already been submitted.");
  }

  const missing = whatIsMissing(toRenderable(request));
  if (missing.length > 0) {
    throw new RequestRefused(
      `This request cannot be submitted yet. It still needs ${missing.join(", ")}.`,
    );
  }

  // Fixed on the first attempt and never rewritten, so the document says when
  // the request was filed rather than when a retry happened to succeed.
  const submittedAt = request.submittedAt ?? new Date();
  if (!request.submittedAt) {
    await prisma.architectureRequest.update({
      where: { id: request.id },
      data: { submittedAt, state: SUBMITTED, failureReason: null },
    });
  }

  const adopted = await findRendered(
    access.organisation.id,
    request.projectId,
    request.reference,
  );
  if (adopted) {
    const linked = await link(request.id, adopted, request.reference);
    // An adopted document is still a submission, and still has to be classified.
    await checkCriteria(request.id);
    return linked;
  }

  const bytes = await renderRequest({ ...toRenderable(request), submittedAt });

  const { document } = await record({
    organisationId: access.organisation.id,
    userId: access.user.id,
    // A design under review, not a standard. This is what makes the pipeline
    // carry it towards analyse rather than treating it as part of the library.
    role: "assessed",
    projectId: request.projectId,
    bytes,
    fileName: fileName(request.reference, request.title),
    format: { mimeType: DOCX_MIME, extension: "docx" },
  });

  // Conditional, so a simultaneous second submission cannot overwrite the link
  // the first one wrote.
  const linked = await prisma.architectureRequest.updateMany({
    where: { id: request.id, documentId: null },
    data: { documentId: document.id, state: SUBMITTED, failureReason: null },
  });

  if (linked.count === 0) {
    // Another submission of this request won. Ours is a second copy of the same
    // answers that nothing points at, and leaving it in the project would mean
    // the assessment reading the same design twice and reporting it twice.
    // Deleting it takes its queued parse job with it.
    await prisma.document.delete({ where: { id: document.id } }).catch(() => {});
    const winner = await prisma.architectureRequest.findUniqueOrThrow({
      where: { id: request.id },
      select: { documentId: true },
    });
    return { documentId: winner.documentId!, reference: request.reference };
  }

  await checkCriteria(request.id);
  return { documentId: document.id, reference: request.reference };
}

/**
 * The brief's Step 2, run as the submission is accepted.
 *
 * "In parallel with Step 3" means neither gates the other, not that this needs
 * a worker. It is a few comparisons over answers already in the row and takes
 * about a millisecond; Step 3 is the one that waits, first for the document to
 * index and then for a hundred model calls.
 *
 * Never throws. A classification that could not be reached must not refuse a
 * submission whose document is already in and already being read. The request
 * simply has no significance yet — `significance` stays null, which the screen
 * reads as "not checked" rather than as "not significant" — and a resubmission
 * sets it. Losing an assessment over an arithmetic problem would be the worse
 * trade by a distance.
 */
async function checkCriteria(requestId: string): Promise<void> {
  try {
    await runCriteriaCheck(requestId);
  } catch {
    // Deliberately swallowed; see above.
  }
}

/**
 * A document already rendered for this request, if an earlier attempt got one
 * in and failed before it could be linked.
 *
 * Matched on the title, because nothing else about the document can be known
 * in advance: the content hash is unpredictable by design, and the storage key
 * is the storage service's to issue — under UploadThing it is theirs, not the
 * one we suggested.
 *
 * Two forms, and both are needed. `record()` normalises separators when it
 * derives a title from a filename, so "AR-0001 Portal.docx" is stored as
 * "AR 0001 Portal"; the parse stage then replaces that with the document's own
 * Title paragraph, which carries the reference as written. A request can be
 * retried on either side of that, so both spellings are looked for.
 *
 * The trailing space is what makes this exact: "AR-0010 " does not start with
 * "AR-0001 ". Together with a reference that is unique per customer and a scope
 * of one project and `assessed` only, the sole thing this can find is another
 * rendering of this same request.
 */
async function findRendered(
  organisationId: string,
  projectId: string,
  reference: string,
): Promise<string | null> {
  const spelt = `${reference} `;
  const normalised = `${reference.replace(/[_-]+/g, " ")} `;
  const document = await prisma.document.findFirst({
    where: {
      organisationId,
      projectId,
      role: "assessed",
      OR: [{ title: { startsWith: spelt } }, { title: { startsWith: normalised } }],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return document?.id ?? null;
}

async function link(
  requestId: string,
  documentId: string,
  reference: string,
): Promise<{ documentId: string; reference: string }> {
  await prisma.architectureRequest.updateMany({
    where: { id: requestId, documentId: null },
    data: { documentId, state: SUBMITTED, failureReason: null },
  });
  return { documentId, reference };
}

/** The stored row, in the shape the renderer and the validator read. Decimal
 *  is formatted here rather than in the renderer, so the document says what a
 *  person would write and the renderer never meets a Prisma type. */
function toRenderable(
  request: Awaited<ReturnType<typeof prisma.architectureRequest.findFirstOrThrow>>,
): Submittable {
  return {
    ...request,
    estimatedCost:
      request.estimatedCost === null
        ? null
        : Number(request.estimatedCost).toLocaleString("en-GB"),
  };
}

/**
 * Move every submitted request whose document has finished indexing to
 * "ready", so its screen can offer "Start assessing".
 *
 * This exists because the worker chain stops at embed and nothing downstream
 * reports back on its own. It does not open the run — that is
 * `startAssessment`, and a person calls it. What this owns is the part a button
 * cannot answer for itself: whether the document is in, whether it was
 * readable, and whether there is anything indexed to assess yet.
 *
 * Takes no `Access`: there is no session behind a scheduled run. Every query is
 * scoped by the request's own organisation id, which is read from the row
 * rather than supplied by a caller, so there is no id here that could have come
 * from a URL.
 *
 * Never throws. One request that cannot be moved on must not stop the others,
 * and the scheduler has nobody to report an exception to.
 */
export async function advanceSubmitted(
  options: {
    limit?: number;
    /** One customer instead of all of them. The timer passes nothing; this
     *  exists so a deployment can advance a single tenant, and so a test can
     *  exercise the sweep without reaching rows it does not own. */
    organisationId?: string;
    /** One document, which is what the embed worker asks for the moment it has
     *  finished indexing one — see Workers/aidp/notify.py. The ordinary case is
     *  that it belongs to no request at all (somebody uploaded a design by
     *  hand), and the answer is zero of everything. */
    documentId?: string;
  } = {},
): Promise<{
  /** How many were moved to "ready" — not how many were assessed. Nothing here
   *  starts an assessment any more; see `startAssessment`. */
  ready: number;
  waiting: number;
  failed: number;
}> {
  const { limit = 25, organisationId, documentId } = options;
  const pending = await prisma.architectureRequest.findMany({
    where: {
      state: SUBMITTED,
      documentId: documentId ? documentId : { not: null },
      runId: null,
      ...(organisationId ? { organisationId } : {}),
    },
    select: { id: true, organisationId: true, projectId: true, documentId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let ready = 0;
  let waiting = 0;
  let failed = 0;

  for (const request of pending) {
    try {
      const document = await prisma.document.findFirst({
        where: { id: request.documentId!, organisationId: request.organisationId },
        select: { status: true, failureReason: true, _count: { select: { chunks: true } } },
      });

      if (!document) {
        await stop(request.id, "The submitted document is no longer in the library.");
        failed += 1;
        continue;
      }
      if (document.status === "failed") {
        await stop(
          request.id,
          document.failureReason
            ? `The submitted document could not be read: ${document.failureReason}`
            : "The submitted document could not be read.",
        );
        failed += 1;
        continue;
      }
      // Still parsing, chunking or embedding. Ready with no chunks is the same
      // answer — there is nothing for retrieval to find yet.
      if (document.status !== "ready" || document._count.chunks === 0) {
        waiting += 1;
        continue;
      }

      // And nor is the rendered form the only thing being assessed any more.
      // The requestor uploads designs into the request, each of which indexes
      // on its own schedule, and the embed worker pings once per document — so
      // the form can easily be in while a design is still three stages behind.
      //
      // "Ready" has to mean the whole submission is ready, not the form. A
      // button offered early gets pressed early, and `startProjectRun` takes
      // whichever designs happen to be indexed and files the rest under
      // `unreadyDesignIds` — a request assessed without the design its author
      // thought they were submitting, with nothing on the screen to say so.
      const unindexed = await prisma.document.count({
        where: {
          projectId: request.projectId,
          organisationId: request.organisationId,
          role: "assessed",
          status: { notIn: ["ready", "failed"] },
        },
      });
      if (unindexed > 0) {
        waiting += 1;
        continue;
      }

      // Indexed, readable, and that is as far as this goes. Opening the run is
      // somebody's decision now rather than a consequence of indexing
      // finishing — see `startAssessment`.
      //
      // `updateMany` with the state in the filter, not `update` by id: the
      // sweep is reached from the worker's ping and from two screens, so two
      // callers can arrive on the same row at the same moment. Naming the state
      // it must still be in means the second one writes nothing, instead of
      // dragging a request that has since been started back to "ready" and
      // offering a button for a run already in flight.
      const moved = await prisma.architectureRequest.updateMany({
        where: { id: request.id, state: SUBMITTED },
        data: { state: READY, failureReason: null },
      });
      if (moved.count > 0) ready += 1;
    } catch {
      // A dropped connection, a provider blip. Left in "submitted" to be tried
      // again, because a transient fault should not close a submission.
      //
      // There used to be two named branches above this one, for the refusals
      // `startProjectRun` raises and for the partial unique index that stops a
      // project holding two live runs. Neither can be reached from here any
      // more: this function no longer opens a run. Both now live in
      // `startAssessment`, where the person who pressed the button is standing
      // there to be told.
      waiting += 1;
    }
  }

  return { ready, waiting, failed };
}

/**
 * Open the assessment of one request, because somebody pressed the button.
 *
 * The step the flow now ends on. A requestor opens a request, answers the
 * intake questions, uploads the designs into it, submits, and — once the
 * screen says its documents are in — presses "Start assessing". Nothing in
 * between happens on its own any more, and that is the point: the person who
 * assembled the submission is the one who knows it is finished.
 *
 * ## Who may press it
 *
 * The same rule as editing a draft: the person who raised it, or somebody who
 * administers the workspace. Deliberately not the submission-decision rule —
 * starting an assessment is asking for the request to be read, which is the
 * requestor's own business, while *deciding* what happens to it afterwards is
 * the one thing a requestor must never do for their own submission. See
 * `canDecideSubmissions` and `ownSubmission` in src/lib/ingest/outcomes.ts.
 *
 * ## Why it refuses while anything is still indexing
 *
 * `startProjectRun` assesses the designs that are ready and records the others
 * in `unreadyDesignIds`. For a project that was the right behaviour: designs
 * arrive over days and an assessment should not wait for the slowest. For a
 * request it is a trap. Every document here was uploaded minutes ago as one
 * submission, so a design that is still embedding is not a straggler — it is
 * part of what was being submitted, and assessing without it produces a report
 * that reads as complete and is not.
 *
 * So this refuses, with the count, rather than quietly narrowing the scope.
 * `advanceSubmitted` will not offer the button until they are all in; this is
 * the same rule enforced where it cannot be raced, because a page can be sitting
 * open from before the last upload landed.
 *
 * A document that *failed* is a different matter and does not block: it will
 * never be ready, and the request would otherwise be unassessable for ever.
 * The run records it under `unreadyDesignIds`, which is where a reader of the
 * report can find out what was not read.
 */
export async function startAssessment(
  access: Access,
  id: string,
): Promise<{ runId: string; scope: string }> {
  const request = await prisma.architectureRequest.findFirst({
    where: { id, organisationId: access.organisation.id },
    select: {
      id: true,
      reference: true,
      state: true,
      projectId: true,
      runId: true,
      requestedById: true,
    },
  });
  if (!request) throw new RequestRefused("That request no longer exists.");

  if (!canEditRequest(access, request)) {
    throw new RequestRefused(
      "Only the person who raised this request, or an administrator, can start its assessment.",
    );
  }

  // Already run. Not an error worth a stack trace — the answer is the report,
  // and a second run over the same designs would cost a hundred model calls to
  // reach the same findings.
  if (request.runId) {
    throw new RequestRefused("This request has already been assessed — open its report.");
  }
  if (request.state === DRAFT) {
    throw new RequestRefused("Finish this request and submit it first.");
  }
  if (request.state === FAILED) {
    throw new RequestRefused(
      "This request stopped before it could be assessed. Correct it and submit it again.",
    );
  }
  if (request.state !== READY) {
    throw new RequestRefused(
      "Its documents are still being read. This turns on by itself once they are in.",
    );
  }

  const designs = await assessableDesigns(access.organisation.id, request.projectId);
  const indexed = designs.filter(
    (design) => design.status === "ready" && design._count.chunks > 0,
  );
  const stillReading = designs.filter(
    (design) => design.status !== "failed" && !indexed.includes(design),
  );

  if (stillReading.length > 0) {
    const count =
      stillReading.length === 1
        ? "One of this request's documents is"
        : `${stillReading.length} of this request's documents are`;
    throw new RequestRefused(
      `${count} still being read. Wait for them, so none is left out of the assessment.`,
    );
  }
  if (indexed.length === 0) {
    throw new RequestRefused(
      "None of this request's documents could be read, so there is nothing to assess.",
    );
  }

  try {
    const started = await startProjectRun(access, request.projectId);

    // `updateMany` with `runId: null` in the filter: two presses land here at
    // once and only the first writes. The second's run is the one that loses,
    // which is why the index that keeps a project to one live run matters below
    // — without it the loser's run would sit queued for ever, attached to
    // nothing a screen reads.
    await prisma.architectureRequest.updateMany({
      where: { id: request.id, runId: null },
      data: { runId: started.runId, state: CHECKING, failureReason: null },
    });
    return started;
  } catch (error) {
    // The refusals `startProjectRun` raises are conditions the person pressing
    // can act on — above all an empty standards library, which is why this is
    // told rather than failed: the request stays in "ready" and the same press
    // works once the standards are in.
    //
    // Their wording is a project's, and three of the four cannot be reached
    // from here: a request's project is created with the request, is never
    // archived because nothing in the product can archive it, and its designs
    // were checked above. The one that can — no reference standards indexed —
    // says so without mentioning a project. If one of the others ever does
    // surface, it means something outside this flow has been editing a
    // request's hidden project, and the project's own words are then the most
    // useful thing it could say.
    if (error instanceof ProjectRefused) throw new RequestRefused(error.message);

    // A project holds one live run at a time, by the partial unique index
    // "assessment_run_live_project_idx". Prisma cannot see a partial index, so
    // this arrives as Postgres's 23505 and never as P2002 — see
    // `isUniqueViolation`. Reachable here only by two presses racing past the
    // `runId` check above.
    if (isUniqueViolation(error)) {
      throw new RequestRefused("An assessment of this request is already starting.");
    }
    throw error;
  }
}

async function stop(id: string, reason: string): Promise<void> {
  await prisma.architectureRequest.update({
    where: { id },
    data: { state: FAILED, failureReason: reason.slice(0, 1000) },
  });
}
