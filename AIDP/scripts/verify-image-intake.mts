/**
 * Images at the door: what `identify` recognises, and what it refuses.
 *
 * A diagram submitted on its own is a first-class submission — the brief asks
 * for it, and `_parse_image` in Workers/aidp/stages/parse.py reads it. This is
 * the other half: the door has to recognise one from its bytes, and has to go
 * on recognising every format it already took.
 *
 * Signatures, never extensions. A file is what its first bytes say it is: a
 * .png that is really a PDF is a PDF, and the name it arrived under is the one
 * thing here that cannot be trusted.
 *
 * Nothing here reaches the database. The env file is still needed because
 * `intake.ts` imports the Prisma client for its other exports, and that module
 * refuses to load without a connection string.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-image-intake.mts
 */
import {
  DOCX_MIME,
  JPEG_MIME,
  PNG_MIME,
  PPTX_MIME,
  WEBP_MIME,
  XLSX_MIME,
  identify,
} from "../src/lib/ingest/intake";

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

const bytes = (...parts: (string | number[])[]): Uint8Array => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") out.push(...Buffer.from(part, "latin1"));
    else out.push(...part);
  }
  // Padded, because real files are not eight bytes long and some checks read
  // past the signature.
  while (out.length < 64) out.push(0);
  return new Uint8Array(out);
};

const format = (result: ReturnType<typeof identify>) =>
  "mimeType" in result ? result.mimeType : `REFUSED: ${result.error}`;

console.log("\nImages, by signature");

const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
ok("a PNG is recognised", format(identify(png)) === PNG_MIME, format(identify(png)));
ok(
  "and gets the right extension",
  "extension" in identify(png) && (identify(png) as { extension: string }).extension === "png",
);

const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0]);
ok("a JPEG is recognised", format(identify(jpeg)) === JPEG_MIME, format(identify(jpeg)));

// JFIF, Exif and raw JPEGs differ at the fourth byte; all three start FF D8 FF.
const exif = bytes([0xff, 0xd8, 0xff, 0xe1]);
ok("including one from a camera", format(identify(exif)) === JPEG_MIME, format(identify(exif)));

const webp = bytes("RIFF", [0, 0, 0, 0], "WEBP");
ok("a WebP is recognised", format(identify(webp)) === WEBP_MIME, format(identify(webp)));

// RIFF is a container: .wav and .avi share the first four bytes. Only the ones
// that name themselves WEBP at byte eight are images.
const wav = bytes("RIFF", [0, 0, 0, 0], "WAVE");
ok("but a .wav sharing its container is not", format(identify(wav)).startsWith("REFUSED"));

console.log("\nEvery format that already worked, still does");

ok("PDF", format(identify(bytes("%PDF-1.7"))) === "application/pdf");

const zip = (entry: string) => bytes("PK\x03\x04", [0, 0, 0, 0, 0, 0], entry);
ok("PowerPoint", format(identify(zip("ppt/presentation.xml"))) === PPTX_MIME);
ok("Excel", format(identify(zip("xl/workbook.xml"))) === XLSX_MIME);
ok("Word", format(identify(zip("word/document.xml"))) === DOCX_MIME);

const ole2 = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
ok("and a pre-2007 Office file is still named", format(identify(ole2)).includes("pre-2007"));

console.log("\nWhat is still refused");

const refused = identify(bytes("this is just some text"));
ok("plain text", "error" in refused);
ok(
  "and the message now offers images too",
  "error" in refused && refused.error.includes("image"),
  "error" in refused ? refused.error : "",
);
ok("a GIF is not accepted", format(identify(bytes("GIF89a"))).startsWith("REFUSED"));
ok("nor a BMP", format(identify(bytes("BM"))).startsWith("REFUSED"));

console.log("\nThe name is never the authority");

// The whole point of reading signatures: a PDF renamed .png is a PDF, and an
// image renamed .pdf is an image. `identify` is handed bytes and nothing else,
// so this is less a behaviour than a property of the design — worth pinning
// down because an extension check is the obvious thing to add later.
ok("a PDF's bytes win", format(identify(bytes("%PDF-1.4"))) === "application/pdf");
ok("a PNG's bytes win", format(identify(png)) === PNG_MIME);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
