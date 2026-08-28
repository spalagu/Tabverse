import type { Terminal } from "@xterm/xterm";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";


/** Which half of the judgement a sample feeds. */
export type GraphemeWidthKind =
  /** Must CHANGE columns vs the Unicode11 baseline — the upgrade's evidence. */
  | "multiCodepoint"
  /** Must NOT change — a combining sequence already took one column. */
  | "combining"
  /** Must NOT change — double width is the one thing both providers agree on. */
  | "cjkDoubleWidth"
  /** Must NOT change — plain ASCII is not anybody's to move. */
  | "ascii";

/** One probe sample. */
export interface GraphemeWidthSample {
  id: string;
  /** The string exactly as it is written into the terminal. */
  text: string;
  /** Columns it must occupy under the grapheme provider (product state). */
  graphemeColumns: number;
  /**
   * Columns it DID occupy under `@xterm/addon-unicode11` with
   * `activeVersion = "11"`, measured 2026-08-17 on @xterm/xterm 5.5.0 +
   * addon-unicode11 0.8.0 before the swap. Kept as data so the before/after
   * comparison is repeatable, and so a rollback can be verified against the
   * numbers the old provider actually produced rather than a memory of them.
   */
  baselineUnicode11Columns: number;
  kind: GraphemeWidthKind;
}

/**
 * The expectation table: combining sequences, multi-codepoint emoji families,
 * CJK double-width characters and plain ASCII.
 *
 * Every emoji row is a single grapheme that a wcwidth-style provider cuts
 * into several columns: the family emoji was six, the skin-tone pair four,
 * the keycap and the VS16 heart one (a monochrome tofu-narrow cell), the
 * rainbow flag three. The regional-indicator flag already summed to two
 * under Unicode11 — kept here as a same-total row, not evidence.
 */
export const GRAPHEME_WIDTH_SAMPLES: readonly GraphemeWidthSample[] = [
  {
    id: "ascii",
    text: "abc",
    graphemeColumns: 3,
    baselineUnicode11Columns: 3,
    kind: "ascii",
  },
  {
    id: "cjk-single",
    text: "\u8a9e",
    graphemeColumns: 2,
    baselineUnicode11Columns: 2,
    kind: "cjkDoubleWidth",
  },
  {
    id: "cjk-pair",
    text: "\u4e2d\u6587",
    graphemeColumns: 4,
    baselineUnicode11Columns: 4,
    kind: "cjkDoubleWidth",
  },
  {
    id: "combining-acute",
    text: "é",
    graphemeColumns: 1,
    baselineUnicode11Columns: 1,
    kind: "combining",
  },
  {
    id: "combining-double",
    text: "ä́",
    graphemeColumns: 1,
    baselineUnicode11Columns: 1,
    kind: "combining",
  },
  {
    id: "emoji-family",
    text: "\u{1F468}‍\u{1F469}‍\u{1F467}",
    graphemeColumns: 2,
    baselineUnicode11Columns: 6,
    kind: "multiCodepoint",
  },
  {
    id: "emoji-flag",
    text: "\u{1F1FA}\u{1F1F8}",
    graphemeColumns: 2,
    baselineUnicode11Columns: 2,
    kind: "multiCodepoint",
  },
  {
    id: "emoji-skin",
    text: "\u{1F44D}\u{1F3FD}",
    graphemeColumns: 2,
    baselineUnicode11Columns: 4,
    kind: "multiCodepoint",
  },
  {
    id: "emoji-keycap",
    text: "1️⃣",
    graphemeColumns: 2,
    baselineUnicode11Columns: 1,
    kind: "multiCodepoint",
  },
  {
    id: "emoji-heart-vs16",
    text: "❤️",
    graphemeColumns: 2,
    baselineUnicode11Columns: 1,
    kind: "multiCodepoint",
  },
  {
    id: "emoji-rainbow",
    text: "\u{1F3F3}️‍\u{1F308}",
    graphemeColumns: 2,
    baselineUnicode11Columns: 3,
    kind: "multiCodepoint",
  },
];

/**
 * Columns `text` actually occupies in this terminal, measured from the
 * buffer the parser produced.
 *
 * `\r` puts the cursor at column 0 of the current line; when the write
 * callback fires the parse is complete and `cursorX` IS the advance in
 * columns — one per narrow cell, two per double-width one, zero for anything
 * folded into the cell before it. Samples must stay well under the terminal's
 * width (the longest is six columns against eighty) or the advance would
 * wrap and stop meaning anything.
 */
export function measureColumns(term: Terminal, text: string): Promise<number> {
  return new Promise((resolve) => {
    term.write(`\r${text}`, () => resolve(term.buffer.active.cursorX));
  });
}

export function loadGraphemeWidths(term: Terminal): void {
  term.loadAddon(new UnicodeGraphemesAddon());
}
