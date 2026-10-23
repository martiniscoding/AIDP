/**
 * An architecture request, rendered as the document the engine assesses.
 *
 * The engine reads documents. It parses them into sections, embeds the
 * passages, and every verdict it reaches has to quote the submitted text word
 * for word. A form has none of that, so the answers are written into a real
 * .docx and taken in through the ordinary upload door — after which nothing
 * downstream knows or cares that a person typed this instead of attaching it.
 *
 * Why .docx rather than PDF. Workers/aidp/parsing/docs.py puts it plainly: a
 * Word document is "the only format that still *has* its structure when it
 * reaches us", and that path infers nothing. A PDF would be this same content
 * with its structure destroyed at export, rebuilt afterwards by guessing at
 * font sizes. Generating the format the parser trusts most is free here, since
 * we are the author.
 *
 * ## The two things this file has to get right
 *
 * **Headings have to be headings.** `_depth` in docs.py resolves a heading from
 * three sources, most authoritative first: `w:outlineLvl` on the paragraph,
 * then on its style following the base chain, then the style's name. This sets
 * the heading style *and* the explicit outline level, so the answer comes from
 * the first source and never depends on how a library happened to name a style
 * in its stylesheet. Get this wrong and the whole document parses as one
 * section, every finding cites "§1", and nothing is traceable.
 *
 * **Two identical submissions must not be one document.** `record()` in
 * ./intake.ts is content-addressed: the same bytes resolve to the existing
 * document and never start a second pipeline. Rendering is deterministic, so a
 * resubmission with unchanged answers would hash to the same bytes and vanish
 * into the first one — silently, with no error and no run. The provenance line
 * carries the request's id and the moment it was submitted, which makes every
 * submission's bytes its own.
 *
 * Nothing here calls a model. The document says what the requestor said, in the
 * order the brief asks for it, and nothing else.
 */
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

/** What the renderer needs. A structural subset of ArchitectureRequest, so
 *  this stays testable without a database row. */
export type RenderableRequest = {
  id: string;
  reference: string;
  title: string;
  summary: string;
  requestedByName: string;
  team: string;
  plannedStart: Date | null;
  submittedAt: Date | null;

  problemStatement: string;
  solutionOverview: string;

  technologies: string[];
  newTechnologyComponent: boolean;
  newTechnologyComponentName: string;
  replacesTechnologyComponent: boolean;
  replacedTechnologyComponentName: string;
  integrationPoints: string;
  authMechanism: string;
  dataStores: string;
  dataClassification: string;
  newOrDuplicatedStorage: boolean;
  hostingEnvironment: string;

  estimatedCost: string | null;
  newLicenceRequired: boolean;
  newLicenceVendor: string;
  linesOfBusiness: string[];
  newBusinessCapability: boolean;
  regulatoryImpact: boolean;
  regulatoryImpactDetail: string;
  securityDomainChange: boolean;
  securityDomainChangeDetail: string;
  applicationDecommissioned: boolean;
  applicationDecommissionedName: string;
  applicationCriticality: string;
  newApplicationStandard: boolean;
  dataGovernanceEscalation: boolean;
  standardsChangeProposed: boolean;
  standardsChangeDetail: string;
};

/**
 * Heading levels, by the depth docs.py will read back.
 *
 * `outlineLevel` is zero-based where the parser's depth is one-based, which is
 * the off-by-one this map exists to state once rather than at each call.
 */
const HEADINGS = {
  1: { heading: HeadingLevel.HEADING_1, outlineLevel: 0 },
  2: { heading: HeadingLevel.HEADING_2, outlineLevel: 1 },
} as const;

/**
 * The document's name for itself.
 *
 * Styled Title, not Heading 1, because `read` in docs.py takes the document
 * title from the Title-styled paragraph and takes nothing otherwise — "no Title
 * style means no title, rather than borrowing the first heading". Without it
 * the stored title falls back to the uploaded file's name, and the section tree
 * and the structure pass are handed that instead of what this request is.
 *
 * The outline level is set as well, so the *depth* still comes from the
 * authoritative source and does not rest on a library having spelled a style
 * name the way the parser hopes.
 */
function documentTitle(text: string): Paragraph {
  return new Paragraph({
    text,
    heading: HeadingLevel.TITLE,
    outlineLevel: 0,
    spacing: { after: 120 },
  });
}

function heading(text: string, depth: 1 | 2): Paragraph {
  return new Paragraph({
    text,
    ...HEADINGS[depth],
    spacing: { before: 240, after: 120 },
  });
}

function body(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun(text)],
    spacing: { after: 120 },
  });
}

/**
 * A yes/no answer, written as a sentence rather than a label.
 *
 * "New technology component: Yes" is a form field; the judge is reading prose
 * and quoting it. A sentence is what it can cite, and what a reviewer reading
 * the rendered document would expect to find.
 */
function answer(question: string, yes: boolean, detail: string): string {
  const head = yes ? `${question}: yes.` : `${question}: no.`;
  const tail = yes && detail.trim() ? ` ${detail.trim()}` : "";
  return `${head}${tail}`;
}

/** Only the sections with something in them. An empty heading is a section the
 *  parser will raise as an ingest issue, and it would be right to: the engine
 *  must not be handed a heading that promises content and delivers none. */
function section(title: string, depth: 1 | 2, lines: string[]): Paragraph[] {
  const written = lines.map((l) => l.trim()).filter(Boolean);
  if (written.length === 0) return [];
  return [heading(title, depth), ...written.map(body)];
}

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const CRITICALITY: Record<string, string> = {
  standard: "Standard",
  business_critical: "Business-Critical",
  mission_critical: "Mission-Critical",
};

/**
 * The request as a Word document.
 *
 * Section numbers are written into the headings rather than left to Word's
 * automatic numbering, which lives in the numbering definition and not in the
 * text — a finding has to be able to cite "§3.3", and it can only do that if
 * those characters are in the heading the parser read.
 */
export function renderRequest(request: RenderableRequest): Promise<Buffer> {
  const submitted = request.submittedAt ?? new Date();

  const children: Paragraph[] = [
    documentTitle(`${request.reference} — ${request.title}`),

    // Provenance, and the reason two identical submissions are two documents.
    // Also genuinely useful: whoever opens the stored file can tell what it is
    // and when it was said.
    body(
      `Architecture request ${request.reference}, submitted ${DATE.format(submitted)}` +
        `${request.requestedByName ? ` by ${request.requestedByName}` : ""}` +
        `${request.team ? ` (${request.team})` : ""}. Reference ${request.id}.`,
    ),

    ...section("1. Request Summary", 1, [
      request.summary,
      request.plannedStart
        ? `Implementation is planned to begin on ${DATE.format(request.plannedStart)}.`
        : "",
    ]),

    ...section("2. Problem Statement", 1, [request.problemStatement]),

    ...section("3. Solution Overview", 1, [request.solutionOverview]),
  ];

  // --- 4. Architecture details ---------------------------------------------
  const architecture: Paragraph[] = [
    ...section("4.1 Technologies and Platforms", 2, [
      request.technologies.length > 0
        ? `The solution uses ${request.technologies.join(", ")}.`
        : "",
      answer(
        "A new technology component is introduced",
        request.newTechnologyComponent,
        request.newTechnologyComponentName
          ? `The component is ${request.newTechnologyComponentName}.`
          : "",
      ),
      answer(
        "An existing technology component is being replaced",
        request.replacesTechnologyComponent,
        request.replacedTechnologyComponentName
          ? `The component being replaced is ${request.replacedTechnologyComponentName}.`
          : "",
      ),
    ]),
    ...section("4.2 Integration Points", 2, [request.integrationPoints]),
    ...section("4.3 Authentication and Authorisation", 2, [request.authMechanism]),
    ...section("4.4 Data Stores and Classification", 2, [
      request.dataStores,
      request.dataClassification
        ? `The data is classified ${request.dataClassification}.`
        : "",
      answer(
        "New or duplicated data storage is introduced",
        request.newOrDuplicatedStorage,
        "",
      ),
    ]),
    ...section("4.5 Hosting and Deployment", 2, [request.hostingEnvironment]),
  ];
  if (architecture.length > 0) {
    children.push(heading("4. Architecture Details", 1), ...architecture);
  }

  // --- 5. Business and governance impact -----------------------------------
  const governance: Paragraph[] = [
    ...section("5.1 Business Impact", 2, [
      request.linesOfBusiness.length > 0
        ? `The lines of business affected are ${request.linesOfBusiness.join(", ")}.`
        : "",
      answer("A new business capability is introduced", request.newBusinessCapability, ""),
      answer(
        "A regulatory impact is identified",
        request.regulatoryImpact,
        request.regulatoryImpactDetail,
      ),
    ]),
    ...section("5.2 Security Impact", 2, [
      answer(
        "A major change in the security domain is identified",
        request.securityDomainChange,
        request.securityDomainChangeDetail,
      ),
    ]),
    ...section("5.3 Application Impact", 2, [
      answer(
        "An existing application is decommissioned or replaced",
        request.applicationDecommissioned,
        request.applicationDecommissionedName
          ? `The application affected is ${request.applicationDecommissionedName}.`
          : "",
      ),
      `The criticality of the affected application is ${
        CRITICALITY[request.applicationCriticality] ?? request.applicationCriticality
      }.`,
      answer("A new application standard is required", request.newApplicationStandard, ""),
    ]),
    ...section("5.4 Data Governance", 2, [
      answer(
        "This request follows an escalation from Data and Information Governance",
        request.dataGovernanceEscalation,
        "",
      ),
    ]),
    ...section("5.5 Cost and Licensing", 2, [
      request.estimatedCost ? `The estimated cost is ${request.estimatedCost}.` : "",
      answer(
        "A new software licence is required",
        request.newLicenceRequired,
        request.newLicenceVendor ? `The vendor is ${request.newLicenceVendor}.` : "",
      ),
    ]),
    ...section("5.6 Standards Change", 2, [
      answer(
        "A change to an existing principle or standard is proposed",
        request.standardsChangeProposed,
        request.standardsChangeDetail,
      ),
    ]),
  ];
  if (governance.length > 0) {
    children.push(heading("5. Business and Governance Impact", 1), ...governance);
  }

  return Packer.toBuffer(new Document({ sections: [{ children }] })) as Promise<Buffer>;
}
