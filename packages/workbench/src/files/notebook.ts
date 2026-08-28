
import { stripTerminalEscapeSequences } from "../controlSequences";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";

/** Rendered characters per textual output before an explicit cut. */
export const OUTPUT_TEXT_CAP = 10_000;

export type NotebookOutput =
  /** stdout/stderr stream or a plain-text result. */
  | { kind: "text"; text: string; truncated: boolean }
  /** Exception traceback, ANSI escape codes stripped. */
  | { kind: "error"; text: string; truncated: boolean }
  /** Inline PNG, base64 as stored in the notebook. */
  | { kind: "image"; base64: string }
  /** Rich HTML output — the component must sanitize before rendering. */
  | { kind: "html"; html: string };

export interface NotebookCell {
  type: "markdown" | "code" | "raw";
  source: string;
  /** Code cells only: the `In [n]` counter, null when never executed. */
  executionCount: number | null;
  outputs: NotebookOutput[];
}

export interface Notebook {
  /** Kernel language from notebook metadata, null when absent. */
  language: string | null;
  cells: NotebookCell[];
}

export type NotebookParse =
  | { ok: true; notebook: Notebook }
  | { ok: false; error: ErrorDescription };

/** Parse notebook text; a malformed file becomes an error value, never a throw. */
export function parseNotebook(text: string): NotebookParse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: describeError(e, STR.errors.actions.readNotebook) };
  }
  const notebook = normalizeCells(json);
  if (notebook === null) {
    return {
      ok: false,
      error: {
        title: `Couldn't ${STR.errors.actions.readNotebook}.`,
        next: "No cell list found — not an nbformat notebook.",
        detail: "",
      },
    };
  }
  return { ok: true, notebook };
}

/**
 * Shape already-parsed notebook JSON into a typed cell list, or null when the
 * document carries no cell array at all. Unknown cell types are kept as raw
 * cells so their source stays visible instead of vanishing.
 */
export function normalizeCells(json: unknown): Notebook | null {
  if (typeof json !== "object" || json === null) return null;
  const doc = json as Record<string, unknown>;
  if (!Array.isArray(doc.cells)) return null;

  return {
    language: kernelLanguage(doc.metadata),
    cells: doc.cells.map(normalizeCell),
  };
}

function kernelLanguage(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const md = metadata as Record<string, unknown>;
  for (const holder of [md.language_info, md.kernelspec]) {
    if (typeof holder !== "object" || holder === null) continue;
    const h = holder as Record<string, unknown>;
    const name = h.name ?? h.language;
    if (typeof name === "string" && name) return name;
  }
  return null;
}

function normalizeCell(cell: unknown): NotebookCell {
  if (typeof cell !== "object" || cell === null) {
    return { type: "raw", source: "", executionCount: null, outputs: [] };
  }
  const c = cell as Record<string, unknown>;
  const type =
    c.cell_type === "markdown" || c.cell_type === "code" ? c.cell_type : "raw";
  return {
    type,
    source: joinSource(c.source),
    executionCount:
      type === "code" && typeof c.execution_count === "number"
        ? c.execution_count
        : null,
    outputs:
      type === "code" && Array.isArray(c.outputs)
        ? c.outputs.flatMap(normalizeOutput)
        : [],
  };
}

/** nbformat stores multi-line text as a string array; join it verbatim. */
function joinSource(source: unknown): string {
  if (typeof source === "string") return source;
  if (Array.isArray(source)) {
    return source.filter((s): s is string => typeof s === "string").join("");
  }
  return "";
}

export function stripAnsi(text: string): string {
  return stripTerminalEscapeSequences(text);
}

function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_TEXT_CAP) return { text, truncated: false };
  return { text: text.slice(0, OUTPUT_TEXT_CAP), truncated: true };
}

function normalizeOutput(output: unknown): NotebookOutput[] {
  if (typeof output !== "object" || output === null) return [];
  const o = output as Record<string, unknown>;

  switch (o.output_type) {
    case "stream":
      return [{ kind: "text", ...cap(joinSource(o.text)) }];
    case "error": {
      const trace = Array.isArray(o.traceback)
        ? o.traceback.filter((l): l is string => typeof l === "string").join("\n")
        : [o.ename, o.evalue].filter((v) => typeof v === "string").join(": ");
      return [{ kind: "error", ...cap(stripAnsi(trace)) }];
    }
    case "execute_result":
    case "display_data":
      return normalizeData(o.data);
    default:
      return [];
  }
}

/** One representation per output, richest first: PNG, then HTML, then text. */
function normalizeData(data: unknown): NotebookOutput[] {
  if (typeof data !== "object" || data === null) return [];
  const d = data as Record<string, unknown>;

  const png = joinSource(d["image/png"]);
  // Notebook writers wrap base64 across lines; the data: URL must not.
  if (png) return [{ kind: "image", base64: png.replace(/\s+/g, "") }];

  const html = joinSource(d["text/html"]);
  if (html) return [{ kind: "html", html }];

  const plain = joinSource(d["text/plain"]);
  if (plain) return [{ kind: "text", ...cap(plain) }];

  return [];
}
