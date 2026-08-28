import { describe, expect, it } from "vitest";
import {
  OUTPUT_TEXT_CAP,
  normalizeCells,
  parseNotebook,
  stripAnsi,
} from "./notebook";

/** Minimal nbformat 4 wrapper around a cell list. */
function nb(cells: unknown[], metadata: unknown = {}) {
  return { nbformat: 4, nbformat_minor: 5, metadata, cells };
}

describe("normalizeCells sources", () => {
  it("keeps a plain string source as-is", () => {
    const doc = normalizeCells(
      nb([{ cell_type: "markdown", source: "# Title\ntext" }])
    );
    expect(doc?.cells).toHaveLength(1);
    expect(doc?.cells[0].source).toBe("# Title\ntext");
  });

  it("joins a string-array source without inserting separators", () => {
    const doc = normalizeCells(
      nb([{ cell_type: "code", source: ["a = 1\n", "b = 2"] }])
    );
    expect(doc?.cells[0].source).toBe("a = 1\nb = 2");
  });

  it("tolerates missing fields: no source, no outputs, no execution_count", () => {
    const doc = normalizeCells(nb([{ cell_type: "code" }, {}]));
    expect(doc?.cells[0]).toEqual({
      type: "code",
      source: "",
      executionCount: null,
      outputs: [],
    });
    // A cell with no cell_type at all still surfaces, as a raw cell.
    expect(doc?.cells[1].type).toBe("raw");
  });

  it("reads the kernel language from metadata", () => {
    const doc = normalizeCells(
      nb([], { language_info: { name: "python" } })
    );
    expect(doc?.language).toBe("python");
    expect(normalizeCells(nb([]))?.language).toBeNull();
  });
});

describe("error outputs and ANSI stripping", () => {
  it("strips color escape codes from tracebacks", () => {
    const doc = normalizeCells(
      nb([
        {
          cell_type: "code",
          outputs: [
            {
              output_type: "error",
              ename: "ValueError",
              evalue: "boom",
              traceback: [
                "\u001b[0;31mValueError\u001b[0m",
                "\u001b[1;32m  line 2\u001b[0m: boom",
              ],
            },
          ],
        },
      ])
    );
    expect(doc?.cells[0].outputs).toEqual([
      { kind: "error", text: "ValueError\n  line 2: boom", truncated: false },
    ]);
  });

  it("falls back to ename/evalue when there is no traceback", () => {
    const doc = normalizeCells(
      nb([
        {
          cell_type: "code",
          outputs: [{ output_type: "error", ename: "E", evalue: "v" }],
        },
      ])
    );
    expect(doc?.cells[0].outputs[0]).toMatchObject({
      kind: "error",
      text: "E: v",
    });
  });

  it("stripAnsi removes CSI sequences beyond colors, e.g. cursor moves", () => {
    expect(stripAnsi("a\u001b[2Kb\u001b[1;31mc\u001b[0m")).toBe("abc");
  });
});

describe("output capping", () => {
  it("caps a stream output at the limit and flags it", () => {
    const doc = normalizeCells(
      nb([
        {
          cell_type: "code",
          outputs: [
            { output_type: "stream", name: "stdout", text: "x".repeat(OUTPUT_TEXT_CAP + 5) },
          ],
        },
      ])
    );
    const out = doc?.cells[0].outputs[0];
    expect(out).toMatchObject({ kind: "text", truncated: true });
    expect(out?.kind === "text" && out.text.length).toBe(OUTPUT_TEXT_CAP);
  });

  it("is exact at the boundary: a cap-sized output is not truncated", () => {
    const doc = normalizeCells(
      nb([
        {
          cell_type: "code",
          outputs: [
            { output_type: "stream", name: "stdout", text: "x".repeat(OUTPUT_TEXT_CAP) },
          ],
        },
      ])
    );
    expect(doc?.cells[0].outputs[0]).toMatchObject({ truncated: false });
  });
});

describe("rich data outputs", () => {
  it("passes PNG base64 through, joining wrapped lines", () => {
    const doc = normalizeCells(
      nb([
        {
          cell_type: "code",
          outputs: [
            {
              output_type: "display_data",
              data: { "image/png": ["iVBORw0K\n", "Ggo=\n"], "text/plain": "<Figure>" },
            },
          ],
        },
      ])
    );
    // PNG wins over the text/plain sibling, and the base64 has no newlines.
    expect(doc?.cells[0].outputs).toEqual([
      { kind: "image", base64: "iVBORw0KGgo=" },
    ]);
  });

  it("prefers HTML over plain text, and falls back to plain text", () => {
    const doc = normalizeCells(
      nb([
        {
          cell_type: "code",
          outputs: [
            {
              output_type: "execute_result",
              data: { "text/html": "<table></table>", "text/plain": "df" },
            },
            {
              output_type: "execute_result",
              data: { "text/plain": ["4", "2"] },
            },
          ],
        },
      ])
    );
    expect(doc?.cells[0].outputs).toEqual([
      { kind: "html", html: "<table></table>" },
      { kind: "text", text: "42", truncated: false },
    ]);
  });
});

describe("parseNotebook failure paths", () => {
  it("returns an error value for malformed JSON instead of throwing", () => {
    const r = parseNotebook("{not json");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.title).toBe("Couldn't read the notebook.");
    expect(!r.ok && r.error.detail).toMatch(/JSON/);
  });

  it("returns an error value for JSON that is not a notebook", () => {
    expect(parseNotebook('{"foo": 1}').ok).toBe(false);
    expect(parseNotebook("[1,2,3]").ok).toBe(false);
  });

  it("accepts a well-formed notebook", () => {
    const r = parseNotebook(JSON.stringify(nb([{ cell_type: "markdown", source: "hi" }])));
    expect(r.ok).toBe(true);
    expect(r.ok && r.notebook.cells).toHaveLength(1);
  });
});
