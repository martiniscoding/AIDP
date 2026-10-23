/**
 * A diagram, from the upload door to what the engine made of it.
 *
 * The two halves are checked separately — `verify-image-intake.mts` for the
 * door, `Workers/tests/test_image_submission.py` for the parser — and this is
 * the seam between them: that a real image taken in through `record()` is
 * stored as something the parse stage will recognise as an image and read.
 *
 * It stops short of running the parse, which needs a worker, a model key and
 * money. What it proves is that the row the worker would pick up says the right
 * things: the type, the role, the project, and a queued parse job — and that
 * the parse stage, asked in Python rather than imitated here, agrees it is an
 * image.
 *
 * Needs the app's database. Queues no work: the job is checked and removed.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-image-end-to-end.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prisma } from "../src/lib/prisma";
import { identify, record } from "../src/lib/ingest/intake";
import { remove } from "../src/lib/ingest/storage";

const WORKERS = resolve(import.meta.dirname, "../../Workers");
const PYTHON = join(WORKERS, ".venv/bin/python");
const TAG = `zz-image-${Date.now()}`;

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra: unknown = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`, extra);
  }
};

if (!existsSync(PYTHON)) {
  console.log(`The workers' virtualenv is not at ${PYTHON}; this needs it to draw a diagram.`);
  process.exit(2);
}

/** A real PNG, drawn by the same library the parser reads it with. */
function diagram(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "aidp-diagram-"));
  const file = join(dir, "diagram.png");
  const script = join(dir, "draw.py");
  writeFileSync(
    script,
    [
      "import pymupdf as fitz, sys",
      "doc = fitz.open(); page = doc.new_page(width=800, height=450)",
      "page.draw_rect(fitz.Rect(40, 40, 200, 100), width=2)",
      "page.insert_textbox(fitz.Rect(46, 60, 200, 100), 'Customer Portal', fontsize=11)",
      "page.draw_rect(fitz.Rect(300, 40, 460, 100), width=2)",
      "page.insert_textbox(fitz.Rect(306, 60, 460, 100), 'Billing (Oracle)', fontsize=11)",
      "page.draw_line(fitz.Point(200, 70), fitz.Point(300, 70))",
      "page.get_pixmap(matrix=fitz.Matrix(2, 2)).save(sys.argv[1])",
    ].join("\n"),
  );
  execFileSync(PYTHON, [script, file], { stdio: ["ignore", "pipe", "pipe"] });
  return readFileSync(file);
}

const org = await prisma.organisation.create({ data: { name: "ZZ Image", slug: TAG } });
const user = await prisma.user.create({
  data: {
    id: `${TAG}-user`,
    name: "Image Tester",
    email: `${TAG}@test.invalid`,
    company: "ZZ Image",
    country: "GB",
    phone: "",
  },
});

try {
  const project = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} project` },
  });

  const png = diagram();
  console.log("\nThe door");

  const format = identify(png);
  ok("a drawn diagram is recognised as a PNG", "mimeType" in format && format.mimeType === "image/png", format);
  if (!("mimeType" in format)) throw new Error("identify refused the diagram");

  const { document, duplicate } = await record({
    organisationId: org.id,
    userId: user.id,
    role: "assessed",
    projectId: project.id,
    bytes: png,
    fileName: "Context Diagram.png",
    format,
  });
  ok("it is taken in", Boolean(document.id) && !duplicate);

  console.log("\nThe row the worker will pick up");

  const row = await prisma.document.findUniqueOrThrow({
    where: { id: document.id },
    include: { jobs: true },
  });
  // The recorded type is the authority, and under UploadThing it is the *only*
  // thing that can be: the key is theirs to issue and carries no extension at
  // all. `_is_image` checks the type first for exactly this reason, and its key
  // fallback is there for the local backend and for rows written before images
  // were supported — never for the deployed case.
  ok("stored as an image", row.mimeType === "image/png", row.mimeType);
  ok(
    "and the type is what the parser will have to go on",
    row.mimeType === "image/png",
    `key is ${row.storageKey.includes(".") ? "a path" : "opaque"}: ${row.storageKey}`,
  );
  ok("as a design, not a standard", row.role === "assessed", row.role);
  ok("in the project it was filed against", row.projectId === project.id);
  ok("attributed to whoever submitted it", row.uploadedById === user.id);
  ok("and the pipeline is queued", row.jobs.some((j) => j.stage === "parse"));

  // Checked, then removed before a worker claims it: a worker runs against this
  // database and would parse and describe this diagram at a model's expense.
  await prisma.job.deleteMany({ where: { organisationId: org.id } });

  console.log("\nAnd the parser agrees it is an image");

  // The decision is made in Python, so it is asked in Python rather than
  // restated here — a second copy of `_is_image` would eventually disagree with
  // the first, and this seam is exactly where that would not be noticed.
  const verdict = execFileSync(
    PYTHON,
    [
      "-c",
      [
        "import sys, json",
        `sys.path.insert(0, ${JSON.stringify(WORKERS)})`,
        "from aidp.stages import parse",
        "row = json.loads(sys.argv[1])",
        "print(json.dumps({",
        "  'image': parse._is_image(row),",
        "  'filetype': parse._image_filetype(row),",
        "  'word': parse._is_word(row), 'deck': parse._is_deck(row),",
        "  'workbook': parse._is_workbook(row),",
        "}))",
      ].join("\n"),
      JSON.stringify({ mimeType: row.mimeType, storageKey: row.storageKey }),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const read = JSON.parse(verdict.trimEnd().split("\n").at(-1)!);
  ok("the parse stage reads it as an image", read.image === true, read);
  ok("and knows the format to open it with", read.filetype === "png", read.filetype);
  ok("and no other parser claims it", !read.word && !read.deck && !read.workbook, read);

  console.log("\nThe same bytes twice");
  const again = await record({
    organisationId: org.id,
    userId: user.id,
    role: "assessed",
    projectId: project.id,
    bytes: png,
    fileName: "Context Diagram.png",
    format,
  });
  ok("resolve to the one document", again.document.id === document.id && again.duplicate);
  const designs = await prisma.document.count({
    where: { organisationId: org.id, role: "assessed" },
  });
  ok("and no second design is created", designs === 1, designs);
  await prisma.job.deleteMany({ where: { organisationId: org.id } });
} finally {
  const stored = await prisma.document.findMany({
    where: { organisationId: org.id },
    select: { storageKey: true },
  });
  await remove(stored.map((d) => d.storageKey)).catch(() => 0);
  await prisma.job.deleteMany({ where: { organisationId: org.id } });
  await prisma.document.deleteMany({ where: { organisationId: org.id } });
  await prisma.project.deleteMany({ where: { organisationId: org.id } });
  await prisma.organisation.delete({ where: { id: org.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: user.id } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
