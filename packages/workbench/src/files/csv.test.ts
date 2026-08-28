import { describe, expect, it } from "vitest";
import {
  deleteCsvColumn,
  deleteCsvRow,
  insertCsvColumn,
  insertCsvRow,
  parseCsv,
  serializeCsv,
} from "./csv";

describe("parseCsv field grammar", () => {
  it("splits plain records on the delimiter", () => {
    const r = parseCsv("a,b,c\n1,2,3\n", ",");
    expect(r.header).toEqual(["a", "b", "c"]);
    expect(r.rows).toEqual([["1", "2", "3"]]);
    expect(r.totalDataRows).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("keeps a delimiter inside a quoted field", () => {
    const r = parseCsv('name,notes\nwidget,"cheap, cheerful"\n', ",");
    expect(r.rows).toEqual([["widget", "cheap, cheerful"]]);
  });

  it("unescapes doubled quotes inside a quoted field", () => {
    const r = parseCsv('q\n"she said ""hi"""\n', ",");
    expect(r.rows).toEqual([['she said "hi"']]);
  });

  it("treats CRLF as one record boundary, same as LF", () => {
    const r = parseCsv("a,b\r\n1,2\r\n3,4\r\n", ",");
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(r.totalDataRows).toBe(2);
  });

  it("keeps a newline inside a quoted field instead of splitting", () => {
    const r = parseCsv('a,b\n"line1\nline2",x\n', ",");
    expect(r.rows).toEqual([["line1\nline2", "x"]]);
    expect(r.totalDataRows).toBe(1);
  });

  it("emits the last record of a file without a trailing newline", () => {
    const r = parseCsv("a,b\n1,2", ",");
    expect(r.rows).toEqual([["1", "2"]]);
  });

  it("does not turn the trailing newline or blank lines into records", () => {
    const r = parseCsv("a,b\n1,2\n\n\n", ",");
    expect(r.rows).toEqual([["1", "2"]]);
    expect(r.totalDataRows).toBe(1);
  });

  it("keeps empty fields, including a trailing one", () => {
    const r = parseCsv("a,b,c\n1,,\n", ",");
    expect(r.rows).toEqual([["1", "", ""]]);
  });

  it("keeps an explicitly quoted empty record", () => {
    const r = parseCsv('a\n""\n', ",");
    expect(r.rows).toEqual([[""]]);
  });

  it("parses tab-separated input when told to", () => {
    const r = parseCsv('a\tb\n"x\ty"\t2\n', "\t");
    expect(r.header).toEqual(["a", "b"]);
    expect(r.rows).toEqual([["x\ty", "2"]]);
  });
});

describe("parseCsv truncation", () => {
  it("caps materialized rows at the limit but counts every record", () => {
    const body = Array.from({ length: 25 }, (_, i) => `${i},x`).join("\n");
    const r = parseCsv(`id,v\n${body}\n`, ",", 10);
    expect(r.rows).toHaveLength(10);
    expect(r.rows[9]).toEqual(["9", "x"]);
    expect(r.totalDataRows).toBe(25);
    expect(r.truncated).toBe(true);
  });

  it("counts records beyond the cap through quoted newlines, not raw lines", () => {
    // Each record past the cap spans two physical lines; a line counter
    // would report 6 data rows, the record counter must say 3.
    const rec = '"a\nb",1';
    const r = parseCsv(`h1,h2\n${rec}\n${rec}\n${rec}\n`, ",", 1);
    expect(r.rows).toHaveLength(1);
    expect(r.totalDataRows).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it("is exact at the boundary: limit rows is not truncated", () => {
    const body = Array.from({ length: 10 }, (_, i) => `${i}`).join("\n");
    const r = parseCsv(`id\n${body}\n`, ",", 10);
    expect(r.rows).toHaveLength(10);
    expect(r.totalDataRows).toBe(10);
    expect(r.truncated).toBe(false);
  });

  it("handles an empty input", () => {
    const r = parseCsv("", ",");
    expect(r.header).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.totalDataRows).toBe(0);
    expect(r.truncated).toBe(false);
  });
});

describe("serializeCsv quoting", () => {
  it("leaves plain fields unquoted, joins with newlines, ends with one", () => {
    expect(serializeCsv(["a", "b"], [["1", "2"]], ",")).toBe("a,b\n1,2\n");
  });

  it("quotes only the field containing the delimiter", () => {
    expect(serializeCsv(["name", "notes"], [["widget", "cheap, cheerful"]], ",")).toBe(
      'name,notes\nwidget,"cheap, cheerful"\n'
    );
  });

  it("quotes a field with an embedded quote and doubles it", () => {
    expect(serializeCsv(["q"], [['she said "hi"']], ",")).toBe(
      'q\n"she said ""hi"""\n'
    );
  });

  it("quotes a field containing a newline", () => {
    expect(serializeCsv(["a", "b"], [["line1\nline2", "x"]], ",")).toBe(
      'a,b\n"line1\nline2",x\n'
    );
  });

  it("quotes a field containing a bare CR", () => {
    expect(serializeCsv(["a"], [["x\ry"]], ",")).toBe('a\n"x\ry"\n');
  });

  it("keeps empty fields as empty, unquoted", () => {
    expect(serializeCsv(["a", "b", "c"], [["1", "", ""]], ",")).toBe(
      "a,b,c\n1,,\n"
    );
  });

  it("normalizes CRLF input to LF output through a parse → serialize trip", () => {
    const r = parseCsv("a,b\r\n1,2\r\n3,4\r\n", ",");
    expect(serializeCsv(r.header, r.rows, ",")).toBe("a,b\n1,2\n3,4\n");
  });
});

describe("serializeCsv TSV", () => {
  it("joins with tabs; quotes embedded tabs but not commas", () => {
    expect(serializeCsv(["a", "b"], [["x\ty", "p,q"]], "\t")).toBe(
      'a\tb\n"x\ty"\tp,q\n'
    );
  });
});

describe("parse ↔ serialize round trip", () => {
  it("parse → serialize → parse preserves every field of a gnarly file", () => {
    const text =
      'id,"na""me",notes\r\n' +
      '1,"comma, inside","line1\nline2"\r\n' +
      '2,plain,""\r\n' +
      '3,"tab\there",trailing\r\n' +
      "4,ragged\r\n";
    const first = parseCsv(text, ",");
    const rebuilt = serializeCsv(first.header, first.rows, ",");
    const second = parseCsv(rebuilt, ",");
    expect(second.header).toEqual(first.header);
    expect(second.rows).toEqual(first.rows);
    // The canonical text form is a fixed point: serializing the reparse
    // changes nothing, so repeated edits cannot drift the file.
    expect(serializeCsv(second.header, second.rows, ",")).toBe(rebuilt);
  });

  it("round-trips a gnarly grid built directly from fields", () => {
    const header = ["plain", 'quo"te', "com,ma", "nl\nfield"];
    const rows = [
      ["", "  spaced  ", 'mix,"of\nall"', "\t"],
      ["ragged"],
      ['""', "trailing\n", ",", 'end"'],
    ];
    const text = serializeCsv(header, rows, ",");
    const r = parseCsv(text, ",");
    expect(r.header).toEqual(header);
    expect(r.rows).toEqual(rows);
    expect(r.truncated).toBe(false);
  });
});

describe("row and column edits", () => {
  const header = ["id", "name", "note"];
  const rows = [
    ["1", "ada", "x"],
    ["2", "bob"],
    ["3", "eve", "z"],
  ];

  it("inserts an empty row above the clicked one, sized to the grid", () => {
    const g = insertCsvRow(header, rows, 1);
    expect(g.rows).toHaveLength(4);
    expect(g.rows[1]).toEqual(["", "", ""]);
    expect(g.rows[2]).toEqual(["2", "bob"]);
    expect(g.header).toEqual(header);
    // At the end, `at` clamps to append.
    const tail = insertCsvRow(header, rows, 99);
    expect(tail.rows[3]).toEqual(["", "", ""]);
  });

  it("deletes the clicked row and refuses nothing (out-of-range is a no-op)", () => {
    const g = deleteCsvRow(header, rows, 0);
    expect(g.rows).toEqual([
      ["2", "bob"],
      ["3", "eve", "z"],
    ]);
    expect(deleteCsvRow(header, rows, 7).rows).toEqual(rows);
  });

  it("inserts a column at the index for header and every row that has one", () => {
    const g = insertCsvColumn(header, rows, 1);
    expect(g.header).toEqual(["id", "", "name", "note"]);
    // The ragged row (length 2) gets the insert at its end index too, so
    // its "name" value still lines up under the right header.
    expect(g.rows[0]).toEqual(["1", "", "ada", "x"]);
    expect(g.rows[1]).toEqual(["2", "", "bob"]);
    expect(g.rows[2]).toEqual(["3", "", "eve", "z"]);
  });

  it("deletes a column at the SAME index everywhere; a ragged row's gap removes nothing", () => {
    const g = deleteCsvColumn(header, rows, 2);
    expect(g.header).toEqual(["id", "name"]);
    // Row 2 (["2","bob"]) has no index 2 — its gap is deleted as the empty
    // string it is, and the row is unchanged.
    expect(g.rows).toEqual([["1", "ada"], ["2", "bob"], ["3", "eve"]]);
  });

  it("a grid edit serializes through the same channel a cell edit uses", () => {
    // The full pipeline the view runs: transform → serializeCsv → onEdit,
    // and the result re-parses to exactly the transformed grid.
    const g = deleteCsvColumn(header, rows, 0);
    const text = serializeCsv(g.header, g.rows, ",");
    const back = parseCsv(text, ",");
    expect(back.header).toEqual(g.header);
    expect(back.rows).toEqual(g.rows);
  });
});
