/**
 * The seam this whole phase rests on: does the engine read a rendered request?
 *
 * An intake form becomes an assessment by being written into a .docx and taken
 * in through the ordinary upload door. That only works if the engine's Word
 * parser finds the structure the renderer wrote — and if it does not, nothing
 * announces it. The document parses "successfully" as one undifferentiated
 * section, every finding cites §1, and no citation leads anywhere. So this is
 * checked explicitly, against the real parser rather than a description of it.
 *
 * Needs no database and no API key: it renders a document and reads it back.
 *
 * Run with:  npx tsx scripts/verify-request-document.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderRequest, type RenderableRequest } from "../src/lib/ingest/render-request";

const WORKERS = resolve(import.meta.dirname, "../../Workers");
const PYTHON = join(WORKERS, ".venv/bin/python");

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

if (!existsSync(PYTHON)) {
  console.log(
    `The workers' virtualenv is not at ${PYTHON}.\n` +
      "This check reads the rendered document with the engine's own parser, so it " +
      "needs that environment. Create it with `uv sync` in Workers/, then run this again.",
  );
  process.exit(2);
}

const sample: RenderableRequest = {
  id: "clsampleRequest01",
  reference: "AR-0007",
  title: "Customer Portal Upgrade",
  summary: "Replace the ageing customer portal with a modern web application.",
  requestedByName: "A. Requestor",
  team: "Digital Channels",
  plannedStart: new Date("2028-03-01"),
  submittedAt: new Date("2026-10-23T09:00:00Z"),
  problemStatement:
    "The current portal runs on an unsupported framework and cannot meet the new accessibility obligations.",
  solutionOverview:
    "A React single-page application served by a Node API, backed by PostgreSQL. Sessions are held in application memory with sticky load balancing across two instances.",
  technologies: ["React", "Node.js", "PostgreSQL 11", "NGINX"],
  newTechnologyComponent: true,
  newTechnologyComponentName: "Redis cache",
  replacesTechnologyComponent: true,
  replacedTechnologyComponentName: "the legacy ColdFusion portal",
  integrationPoints:
    "The portal calls the billing system over a REST API and reads the customer master directly from its Oracle database.",
  authMechanism:
    "Users sign in with a username and password. There is no second factor for administrative accounts.",
  dataStores:
    "PostgreSQL holds customer profiles and order history. Backups are written to the same storage array.",
  dataClassification: "Confidential",
  newOrDuplicatedStorage: true,
  hostingEnvironment: "On-premises VMware cluster in the primary data centre.",
  estimatedCost: "7,500,000",
  newLicenceRequired: true,
  newLicenceVendor: "Redis Ltd",
  linesOfBusiness: ["Retail", "Wholesale"],
  newBusinessCapability: true,
  regulatoryImpact: true,
  regulatoryImpactDetail: "The portal processes personal data subject to the data protection act.",
  securityDomainChange: true,
  securityDomainChangeDetail: "A new internet-facing entry point is introduced.",
  applicationDecommissioned: true,
  applicationDecommissionedName: "the legacy ColdFusion portal",
  applicationCriticality: "business_critical",
  newApplicationStandard: false,
  dataGovernanceEscalation: false,
  standardsChangeProposed: false,
  standardsChangeDetail: "",
};

type Parsed = {
  title: string | null;
  headings: number;
  sections: {
    ordinal: number;
    number: string | null;
    title: string;
    depth: number;
    path: string;
    text: string;
  }[];
};

function readBack(request: RenderableRequest, bytes: Buffer): Parsed {
  const dir = mkdtempSync(join(tmpdir(), "aidp-request-"));
  const file = join(dir, `${request.reference}.docx`);
  writeFileSync(file, bytes);
  const out = execFileSync(
    PYTHON,
    [join(import.meta.dirname, "request-document-structure.py"), file, WORKERS],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  // PyMuPDF prints a deprecation warning to stdout on import, from deep inside
  // the parser's own dependency chain. The payload is the last line; taking it
  // rather than silencing the warning keeps this honest about what it ran.
  const json = out.trimEnd().split("\n").at(-1) ?? "";
  if (!json.startsWith("{")) {
    throw new Error(`the parser printed no JSON:\n${out}`);
  }
  return JSON.parse(json) as Parsed;
}

const bytes = await renderRequest(sample);
const parsed = readBack(sample, bytes);
const find = (number: string) => parsed.sections.find((s) => s.number === number);

console.log("\nThe document names itself");
ok(
  "the title is read from the document, not the filename",
  parsed.title === "AR-0007 — Customer Portal Upgrade",
  String(parsed.title),
);

console.log("\nEvery heading is a heading");
// The failure this exists for: a document whose headings the parser does not
// recognise still parses, as one section. Sixteen is the count this renderer
// writes for a fully-answered request.
ok("sixteen headings are recognised", parsed.headings === 16, `got ${parsed.headings}`);
ok("and each becomes a section", parsed.sections.length === 16, `got ${parsed.sections.length}`);

console.log("\nSection numbers survive, so a finding can cite one");
for (const number of ["1", "2", "3", "4", "4.1", "4.3", "4.5", "5", "5.2", "5.6"]) {
  ok(`§${number} is addressable`, find(number) !== undefined);
}

console.log("\nDepth, so the heading path reads as a path");
ok("a top-level section is depth 1", find("4")?.depth === 1, String(find("4")?.depth));
ok("a nested one is depth 2", find("4.3")?.depth === 2, String(find("4.3")?.depth));
ok(
  "and the path carries its ancestry",
  find("4.3")?.path ===
    "AR-0007 — Customer Portal Upgrade › 4 Architecture Details › 4.3 Authentication and Authorisation",
  find("4.3")?.path,
);

console.log("\nThe answers land in the sections that asked for them");
// The check that matters most. A verdict quotes the design, and a quote is only
// evidence if the engine can find it in the section the finding names.
ok(
  "the solution overview is under §3",
  find("3")?.text.includes("Sessions are held in application memory") === true,
);
ok(
  "the authentication answer is under §4.3",
  find("4.3")?.text.includes("no second factor for administrative accounts") === true,
);
ok(
  "the data stores answer is under §4.4",
  find("4.4")?.text.includes("Backups are written to the same storage array") === true,
);
ok(
  "a yes/no answer reads as a sentence, not a form field",
  find("5.2")?.text.includes("A major change in the security domain is identified: yes") === true,
  find("5.2")?.text,
);

console.log("\nContainer headings are not reported as empty sections");
// `_empty_sections` in the parse stage skips a heading whose next section is
// deeper. If that ever changed, every request would raise two review issues
// nobody can act on, and reviewers would learn to ignore the ones that matter.
const container = find("4");
ok("§4 carries its substance in its children", container?.text.trim() === "", container?.text);
const next = parsed.sections.find((s) => s.ordinal === (container?.ordinal ?? 0) + 1);
ok("and the section after it is deeper", (next?.depth ?? 0) > (container?.depth ?? 0));

console.log("\nRendering is not byte-stable, and submitRequest knows it");
// Worth pinning down, because the obvious design rests on the opposite. If two
// renderings of one request were byte-identical, `record()` being
// content-addressed would make resubmission idempotent for free. They are not:
// the docx library stamps dcterms:created into every package it writes and
// exposes no way to fix it. So `submitRequest` handles idempotency in the open
// instead, and this is the assumption that would quietly invalidate it.
const sameAgain = await renderRequest(sample);
ok(
  "the same request does NOT render to identical bytes",
  !bytes.equals(sameAgain),
  "it now does — submitRequest could be simplified to rely on the content hash",
);

// What the document *says* is stable, which is what the engine reads. Only the
// package metadata moves.
const reparsed = readBack(sample, sameAgain);
ok(
  "but the parsed content is identical",
  JSON.stringify(reparsed) === JSON.stringify(parsed),
);

const otherRequest = await renderRequest({ ...sample, id: "clsampleRequest02", reference: "AR-0008" });
const otherParsed = readBack({ ...sample, reference: "AR-0008" }, otherRequest);
ok(
  "a different request produces a different document",
  otherParsed.title !== parsed.title,
  String(otherParsed.title),
);

console.log("\nA half-filled request still produces a readable document");
const sparse = await renderRequest({
  ...sample,
  technologies: [],
  integrationPoints: "",
  authMechanism: "",
  dataStores: "",
  dataClassification: "",
  hostingEnvironment: "",
  regulatoryImpactDetail: "",
  securityDomainChangeDetail: "",
});
const sparseParsed = readBack({ ...sample, reference: "AR-0009" }, sparse);
ok("it still names itself", sparseParsed.title === "AR-0007 — Customer Portal Upgrade");
ok("it still has its answered sections", sparseParsed.sections.length > 0);
ok(
  "and no section promises content it does not have",
  sparseParsed.sections.every(
    (s) => s.text.trim() !== "" || sparseParsed.sections.some((o) => o.depth > s.depth && o.ordinal === s.ordinal + 1),
  ),
  sparseParsed.sections.filter((s) => !s.text.trim()).map((s) => s.number).join(", "),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
