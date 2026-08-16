import ExcelJS from "exceljs";

/**
 * Reading a staff list out of whatever the customer's HR system exported.
 *
 * The realistic input is not a template we specified. It is an export with a
 * title row above the headers, a column called "E-mail Address" or "Work
 * Email", trailing blank rows, and a few people who have left. So the parser
 * finds the header row rather than assuming row 1, matches columns by meaning
 * rather than by position, and reports what it could not use instead of
 * dropping it.
 *
 * The import is deliberately *not* a grant of access. It produces rows in the
 * "imported" state, and admitting anyone is a separate, explicit act — see the
 * note on RosterEntry.
 */

export type ParsedPerson = {
  email: string;
  name: string;
  jobTitle: string;
  department: string;
  /** 1-based row in the sheet, so a rejection can name where it came from. */
  row: number;
};

export type ParseRejection = {
  row: number;
  reason: string;
  value: string;
};

export type ParsedSheet = {
  people: ParsedPerson[];
  rejected: ParseRejection[];
  /** Which column we decided was which, so the UI can show its working. */
  columns: Record<string, string>;
  sheetName: string;
  /** Rows that were entirely blank. Counted, not reported one by one. */
  blankRows: number;
};

export class SpreadsheetError extends Error {}

/**
 * Header synonyms, most specific first.
 *
 * Order matters within a field: "work email" should win over a bare "email" if
 * a sheet somehow has both, and a column called "manager email" must never be
 * mistaken for the person's own. Matching is on a normalised header, so
 * "E-Mail Address" and "email_address" are the same string by the time they
 * arrive.
 */
const FIELDS: { key: keyof Omit<ParsedPerson, "row">; patterns: string[] }[] = [
  {
    key: "email",
    patterns: ["workemail", "emailaddress", "email", "mail", "userprincipalname", "upn", "login"],
  },
  {
    key: "name",
    patterns: ["fullname", "displayname", "employeename", "name", "firstname", "givenname"],
  },
  {
    key: "jobTitle",
    patterns: ["jobtitle", "title", "position", "role", "designation"],
  },
  {
    key: "department",
    patterns: ["department", "dept", "team", "division", "businessunit", "function"],
  },
];

/** Headers that look like an email column but are somebody else's. */
const NOT_THEIRS = ["manager", "supervisor", "approver", "lineman", "reportsto", "alternate"];

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Good enough to reject a typo, deliberately not RFC 5322. Anything stricter
// rejects addresses that exist; anything looser lets "N/A" through as a person.
const EMAIL = /^[^\s@,;]+@[^\s@,;.]+\.[^\s@,;]{2,}$/;

export function looksLikeEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

/** A cell as text, whatever ExcelJS decided it was. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    // Excel stores a mailto: link as a hyperlink object whose `text` is what a
    // human sees. Formula cells carry their last computed `result`; rich text
    // arrives as runs that have to be concatenated.
    const object = value as unknown as Record<string, unknown>;
    if ("text" in object && typeof object.text === "string") return object.text.trim();
    if ("hyperlink" in object && typeof object.hyperlink === "string") {
      return object.hyperlink.replace(/^mailto:/i, "").trim();
    }
    if ("result" in object) return cellText(object.result as ExcelJS.CellValue);
    if ("richText" in object && Array.isArray(object.richText)) {
      return (object.richText as { text?: string }[])
        .map((run) => run.text ?? "")
        .join("")
        .trim();
    }
  }
  return "";
}

type Row = { cells: string[]; number: number };

/**
 * Find the row that names the columns.
 *
 * Scans the first 25 rows for the one that best matches known headers, rather
 * than trusting row 1 — exports routinely open with a report title and a blank
 * line. A row only qualifies if it names an email column, because without one
 * there is nothing to import.
 */
function findHeader(rows: Row[]): { index: number; map: Partial<Record<string, number>> } | null {
  let best: { index: number; map: Partial<Record<string, number>>; score: number } | null = null;

  for (let index = 0; index < Math.min(rows.length, 25); index += 1) {
    const cells = rows[index]!.cells;
    const map: Partial<Record<string, number>> = {};
    let score = 0;

    for (const [column, raw] of cells.entries()) {
      const header = normalise(raw);
      if (!header) continue;
      if (NOT_THEIRS.some((prefix) => header.startsWith(prefix))) continue;

      for (const field of FIELDS) {
        if (map[field.key] !== undefined) continue;
        // `startsWith` rather than equality: "emailaddressprimary" is an email
        // column. Patterns are ordered most specific first so the tightest
        // match claims the column.
        if (field.patterns.some((pattern) => header.startsWith(pattern))) {
          map[field.key] = column;
          score += field.key === "email" ? 3 : 1;
          break;
        }
      }
    }

    if (map.email !== undefined && (!best || score > best.score)) {
      best = { index, map, score };
    }
  }

  return best ? { index: best.index, map: best.map } : null;
}

/**
 * A sheet with no header we recognise.
 *
 * Rather than refusing, look for a column that is mostly email addresses. A
 * list pasted into a single column with no header at all is a real thing
 * customers send, and it is unambiguous enough to accept.
 */
function findEmailColumn(rows: Row[]): number | null {
  const width = Math.max(...rows.map((row) => row.cells.length), 0);
  let bestColumn: number | null = null;
  let bestHits = 0;

  for (let column = 0; column < width; column += 1) {
    let hits = 0;
    for (const row of rows) {
      if (looksLikeEmail(row.cells[column] ?? "")) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestColumn = column;
    }
  }
  return bestHits >= 1 ? bestColumn : null;
}

function splitCsv(text: string): Row[] {
  // Hand-rolled because the alternative is a dependency for one delimiter.
  // Handles quoted fields, escaped quotes, and newlines inside quotes, which is
  // the whole of what a spreadsheet export produces.
  const rows: Row[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(field.trim());
      field = "";
    } else if (char === "\n") {
      cells.push(field.trim());
      rows.push({ cells, number: line });
      cells = [];
      field = "";
      line += 1;
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || cells.length > 0) {
    cells.push(field.trim());
    rows.push({ cells, number: line });
  }
  return rows;
}

async function readRows(file: Buffer, filename: string): Promise<{ rows: Row[]; sheetName: string }> {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    // Strip a UTF-8 BOM: Excel writes one, and it would otherwise glue itself
    // to the first header and stop it matching.
    return { rows: splitCsv(file.toString("utf8").replace(/^﻿/, "")), sheetName: "CSV" };
  }

  if (lower.endsWith(".xls")) {
    throw new SpreadsheetError(
      "That is the old .xls format, which cannot be read here. Open it in Excel and save as .xlsx or .csv.",
    );
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw new SpreadsheetError(
      "That file could not be opened as a spreadsheet. Upload a .xlsx or .csv export.",
    );
  }

  const sheet = workbook.worksheets.find((worksheet) => worksheet.rowCount > 0);
  if (!sheet) throw new SpreadsheetError("That workbook has no rows in it.");

  const rows: Row[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, number) => {
    const cells: string[] = [];
    // `row.values` is 1-based with a hole at index 0 — an ExcelJS quirk that
    // shifts every column left if it is spread naively.
    const values = row.values as ExcelJS.CellValue[];
    for (let column = 1; column < values.length; column += 1) {
      cells.push(cellText(values[column]));
    }
    rows.push({ cells, number });
  });

  return { rows, sheetName: sheet.name };
}

/**
 * Parse an uploaded staff list.
 *
 * Never throws on a bad row — a single malformed line must not cost the other
 * two hundred. Rows that cannot be used come back in `rejected` with a reason,
 * and the caller shows them.
 */
export async function parseSheet(file: Buffer, filename: string): Promise<ParsedSheet> {
  const { rows, sheetName } = await readRows(file, filename);
  if (rows.length === 0) throw new SpreadsheetError("That file is empty.");

  const blankRows = rows.filter((row) => row.cells.every((cell) => !cell)).length;
  const filled = rows.filter((row) => row.cells.some((cell) => cell));

  const header = findHeader(filled);
  const columns: Record<string, string> = {};
  let emailColumn: number;
  let map: Partial<Record<string, number>>;
  let body: Row[];

  if (header) {
    map = header.map;
    emailColumn = header.map.email!;
    body = filled.slice(header.index + 1);
    const headerCells = filled[header.index]!.cells;
    for (const [key, column] of Object.entries(map)) {
      if (column !== undefined) columns[key] = headerCells[column] || `Column ${column + 1}`;
    }
  } else {
    const column = findEmailColumn(filled);
    if (column === null) {
      throw new SpreadsheetError(
        "No email column found. The sheet needs a column of email addresses, ideally headed \"Email\".",
      );
    }
    map = { email: column };
    emailColumn = column;
    body = filled;
    columns.email = `Column ${column + 1} (no header found)`;
  }

  const people: ParsedPerson[] = [];
  const rejected: ParseRejection[] = [];
  const seen = new Set<string>();

  for (const row of body) {
    const raw = (row.cells[emailColumn] ?? "").trim();
    if (!raw) {
      // A row with other content but no address is worth reporting; a row that
      // is blank in every column is not, and was counted above.
      if (row.cells.some((cell) => cell)) {
        rejected.push({ row: row.number, reason: "No email address", value: row.cells.find(Boolean) ?? "" });
      }
      continue;
    }

    const email = raw.toLowerCase();
    if (!looksLikeEmail(email)) {
      rejected.push({ row: row.number, reason: "Not an email address", value: raw });
      continue;
    }
    if (seen.has(email)) {
      rejected.push({ row: row.number, reason: "Duplicate of an earlier row", value: raw });
      continue;
    }
    seen.add(email);

    const at = (key: string) => {
      const column = map[key];
      return column === undefined ? "" : (row.cells[column] ?? "").trim();
    };

    people.push({
      email,
      // Falling back to the local part gives the owner something to recognise
      // in a list where only addresses were supplied.
      name: at("name") || raw.split("@")[0]!.replace(/[._-]+/g, " "),
      jobTitle: at("jobTitle"),
      department: at("department"),
      row: row.number,
    });
  }

  if (people.length === 0) {
    throw new SpreadsheetError(
      rejected.length > 0
        ? `No usable rows. ${rejected.length} row${rejected.length === 1 ? "" : "s"} had no valid email address.`
        : "No rows with an email address were found.",
    );
  }

  return { people, rejected, columns, sheetName, blankRows };
}
