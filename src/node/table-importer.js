import { readFile } from "node:fs/promises";
import path from "node:path";

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const [headers = [], ...records] = rows;
  return records.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export async function importTable(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const raw = await readFile(filePath, "utf8");
  let records;
  if (extension === ".json") records = JSON.parse(raw);
  else if (extension === ".csv") records = parseDelimited(raw, ",");
  else if (extension === ".tsv") records = parseDelimited(raw, "\t");
  else throw new Error(`Unsupported table format: ${extension}`);
  if (!Array.isArray(records)) throw new TypeError("Imported table must contain an array of records");
  return { records, report: { read: records.length, errors: [], skipped: 0, unknownFields: [] } };
}
