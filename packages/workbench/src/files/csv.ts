
export const CSV_ROW_LIMIT = 1000;

export interface CsvParseResult {
  /** First record of the file; empty for an empty file. */
  header: string[];
  /** Data records (header excluded), at most `limit` of them. */
  rows: string[][];
  /** Data records in the whole file, including those beyond the cap. */
  totalDataRows: number;
  /** True when `rows` holds fewer records than the file. */
  truncated: boolean;
}

export function parseCsv(
  text: string,
  delimiter: "," | "\t",
  limit: number = CSV_ROW_LIMIT
): CsvParseResult {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  /** Set on any character that belongs to a record — including a quote that
   *  opens an empty field — so blank lines and the trailing newline do not
   *  become phantom empty records, in or out of counting mode. */
  let recordHasContent = false;
  /** While true we materialize fields; past the cap we only count. */
  let collecting = true;
  let total = 0;

  const endRecord = () => {
    total++;
    if (collecting) {
      row.push(field);
      field = "";
      records.push(row);
      row = [];
      // Header + `limit` data rows collected — stop building, keep counting.
      if (records.length > limit) collecting = false;
    }
    recordHasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          if (collecting) field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (collecting) {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      recordHasContent = true;
    } else if (ch === delimiter) {
      if (collecting) {
        row.push(field);
        field = "";
      }
      recordHasContent = true;
    } else if (ch === "\n") {
      if (recordHasContent) endRecord();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      if (recordHasContent) endRecord();
    } else {
      if (collecting) field += ch;
      recordHasContent = true;
    }
  }
  // A file not ending in a newline still owes us its last record. An
  // unterminated quote also lands here: the partial field is kept as-is.
  if (recordHasContent) endRecord();

  const [header = [], ...rows] = records;
  const totalDataRows = Math.max(total - 1, 0);
  return { header, rows, totalDataRows, truncated: totalDataRows > rows.length };
}

export function serializeCsv(
  header: string[],
  rows: string[][],
  delimiter: "," | "\t"
): string {
  const serializeField = (field: string): string =>
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes("\r") ||
    field.includes("\n")
      ? `"${field.replace(/"/g, '""')}"`
      : field;
  return [header, ...rows]
    .map((record) => record.map(serializeField).join(delimiter) + "\n")
    .join("");
}


/** Insert an empty data row at `at` (the clicked row's index). */
export function insertCsvRow(
  header: string[],
  rows: string[][],
  at: number
): { header: string[]; rows: string[][] } {
  const width = Math.max(header.length, ...rows.map((r) => r.length), 0);
  const blank = new Array(width).fill("");
  const next = rows.map((r) => [...r]);
  next.splice(Math.min(Math.max(at, 0), next.length), 0, blank);
  return { header: [...header], rows: next };
}

/** Remove the data row at `at`. */
export function deleteCsvRow(
  header: string[],
  rows: string[][],
  at: number
): { header: string[]; rows: string[][] } {
  if (at < 0 || at >= rows.length) return { header: [...header], rows };
  const next = rows.filter((_, i) => i !== at);
  return { header: [...header], rows: next };
}

/**
 * Insert an empty column at `at`. Every row long enough to have that index
 * gets the gap; shorter rows are untouched (their gap at `at` persists).
 */
export function insertCsvColumn(
  header: string[],
  rows: string[][],
  at: number
): { header: string[]; rows: string[][] } {
  const nextHeader = [...header];
  if (at >= 0 && at <= nextHeader.length) nextHeader.splice(at, 0, "");
  const nextRows = rows.map((r) => {
    const copy = [...r];
    if (at >= 0 && at <= copy.length) copy.splice(at, 0, "");
    return copy;
  });
  return { header: nextHeader, rows: nextRows };
}

/**
 * Remove the column at `at`: the same index out of the header and out of
 * every row that has one. A row whose gap sits at `at` (a ragged row
 * shorter than the index) is unchanged — deleting an empty field removes
 * nothing, and re-parsing the result still lines up.
 */
export function deleteCsvColumn(
  header: string[],
  rows: string[][],
  at: number
): { header: string[]; rows: string[][] } {
  const cut = (record: string[]): string[] =>
    at >= 0 && at < record.length
      ? record.filter((_, i) => i !== at)
      : [...record];
  return {
    header: cut(header),
    rows: rows.map(cut),
  };
}
