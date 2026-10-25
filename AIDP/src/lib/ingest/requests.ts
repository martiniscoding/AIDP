import { prisma } from "@/lib/prisma";
import type { Access } from "@/lib/access/gate";
import { DOCX_MIME, record } from "@/lib/ingest/intake";
import { renderRequest, type RenderableRequest } from "@/lib/ingest/render-request";
import { ProjectRefused, startProjectRun } from "@/lib/ingest/projects";
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
 * **Nothing starts the assessment on its own.** The worker chain stops at
 * embed — `NEXT_STAGE["embed"]` is None — and a person presses "Assess". The
 * brief requires the opposite: the review runs immediately after intake with no
 * further step. `advanceSubmitted` is that step, and it is reached two ways.
 *
 * The embed worker calls it the moment a document lands `ready`
 * (Workers/aidp/notify.py). That is the fast path, it is nearly always the only
 * one that runs, and it starts the assessment within the second.
 *
 * The screens call it too, before they draw. A ping sent while the app was
 * redeploying is not retried — the worker swallows it on purpose — so without a
 * second route in, such a request waits in "submitted" for ever with a document
 * that is ready and no run against it. Sweeping on the two screens somebody
 * waits on costs an indexed lookup that almost always matches nothing, and puts
 * the repair where the problem is noticed. See the note on
 * src/app/dashboard/requests/page.tsx.
 *
 * **A request that cannot proceed says so.** An organisation with no standards
 * indexed, or a document that failed to parse, ends in "failed" with a reason —
 * never in "submitted" for ever while somebody waits for a report.
 */

export class RequestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestRefused";
  }
}

export const DRAFT = "draft";
export const SUBMITTED = "submitted";
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
  projectId: string;
  title: string;
  summary?: string;
  team?: string;
};

/**
 * Open a request. Draft, and deliberately undemanding: the wizard saves as the
 * requestor goes, and a half-filled form is a normal state for one to be in.
 * What a *submission* has to carry is `whatIsMissing`'s problem.
 */
export async function createRequest(
  access: Access,
  input: CreateInput,
): Promise<{ id: string; reference: string }> {
  const title = input.title.trim();
  if (!title) throw new RequestRefused("Give the request a title.");
  if (title.length > 200) throw new RequestRefused("That title is too long.");

  const project = await prisma.project.findFirst({
    where: { id: input.projectId, organisationId: access.organisation.id },
    select: { id: true, status: true },
  });
  if (!project) throw new RequestRefused("That project no longer exists.");
  if (project.status !== "active") {
    throw new RequestRefused("Reopen this project before filing a request against it.");
  }

  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.architectureRequest.create({
        data: {
          organisationId: access.organisation.id,
          reference: await reference(access.organisation.id),
          projectId: project.id,
          title,
          summary: (input.summary ?? "").trim().slice(0, 2000),
          team: (input.team ?? "").trim().slice(0, 200),
          requestedById: access.user.id,
          requestedByName: access.user.name || access.user.email,
        },
        select: { id: true, reference: true },
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
 * Start the assessment for every submitted request whose document has finished
 * indexing.
 *
 * This exists because the worker chain stops at embed and nothing downstream
 * starts an analyse job on its own — a person presses "Assess". The brief
 * requires the review to run immediately after intake with no further step, and
 * changing `NEXT_STAGE` would mean changing the engine, so the step lives here
 * and runs on a schedule.
 *
 * Takes no `Access`: there is no session behind a scheduled run. Every query is
 * scoped by the request's own organisation id, which is read from the row
 * rather than supplied by a caller, so there is no id here that could have come
 * from a URL.
 *
 * Never throws. One request that cannot be started must not stop the others,
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
  started: number;
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

  let started = 0;
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

      const { runId } = await startProjectRun(
        // Only `organisation.id` is read; see startProjectRun. Built from the
        // request's own row rather than a session, because there isn't one.
        { organisation: { id: request.organisationId } } as Access,
        request.projectId,
      );

      await prisma.architectureRequest.update({
        where: { id: request.id },
        data: { runId, state: CHECKING, failureReason: null },
      });
      started += 1;
    } catch (error) {
      // A refusal is a condition the requestor can act on — most often that
      // their standards library is empty, which no amount of retrying fixes.
      if (error instanceof ProjectRefused) {
        await stop(request.id, error.message);
        failed += 1;
        continue;
      }

      // A project may hold one live run at a time, enforced by the partial
      // unique index "assessment_run_live_project_idx". Two requests filed
      // against the same project therefore cannot both be assessed at once,
      // and the second arrives here as Postgres's 23505 rather than as a
      // refusal — Prisma cannot see a partial index, so it is not a P2002
      // either. See `isUniqueViolation`.
      //
      // Waiting is the right answer and not a workaround: the run in progress
      // is over the same project, and this request's design will be judged by
      // the next one. Left to the generic branch below it would have been the
      // right answer by accident, which is the kind of thing that gets
      // "cleaned up" later by somebody who cannot see why it mattered.
      if (isUniqueViolation(error)) {
        waiting += 1;
        continue;
      }

      // Anything else — a dropped connection, a provider blip — is left in
      // "submitted" to be tried again, because a transient fault should not
      // close a submission.
      waiting += 1;
    }
  }

  return { started, waiting, failed };
}

async function stop(id: string, reason: string): Promise<void> {
  await prisma.architectureRequest.update({
    where: { id },
    data: { state: FAILED, failureReason: reason.slice(0, 1000) },
  });
}
