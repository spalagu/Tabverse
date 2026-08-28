
export type DiffKind = "same" | "del" | "add";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * Above this many cells (old lines × new lines) the exact LCS matrix stops
 * being worth building in a settings dialog, and the diff degrades to
 * "everything removed, everything added" — coarse, but honest: it shows
 * the full old text and the full new text and never mislabels a changed
 * line as unchanged. Real scripts sit far under it either way (a minified
 * body is one line; a readable one is a few thousand).
 */
export const MAX_DIFF_CELLS = 4_000_000;

/** Split the way the diff sees a script: on line breaks, CRLF included,
 *  with one trailing line break ignored — a source ending in "\n" and one
 *  not ending in it are the same script to a reader, and a whole added
 *  line of nothing is noise, not a reviewable change. */
function toLines(text: string): string[] {
  const body = text.replace(/\r?\n$/, "");
  return body === "" ? [] : body.split(/\r?\n/);
}

/**
 * Longest-common-subsequence diff over lines, walked back into a list of
 * kept / removed / added lines. Within each changed run the removed lines
 * come first, the added ones after — the order a reader of a unified diff
 * expects, so the view and the computation agree without the view
 * reshuffling anything.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  if (oldText === newText) {
    return oldLines.map((text) => ({ kind: "same", text }));
  }
  if (oldLines.length * newLines.length > MAX_DIFF_CELLS) {
    return [
      ...oldLines.map((text): DiffLine => ({ kind: "del", text })),
      ...newLines.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }

  // lcs[a][b] = LCS length of oldLines[a..] and newLines[b..].
  const width = newLines.length + 1;
  const lcs = new Uint32Array((oldLines.length + 1) * width);
  for (let a = oldLines.length - 1; a >= 0; a--) {
    for (let b = newLines.length - 1; b >= 0; b--) {
      lcs[a * width + b] =
        oldLines[a] === newLines[b]
          ? lcs[(a + 1) * width + b + 1] + 1
          : Math.max(lcs[(a + 1) * width + b], lcs[a * width + b + 1]);
    }
  }
  const out: DiffLine[] = [];
  let a = 0;
  let b = 0;
  while (a < oldLines.length && b < newLines.length) {
    if (oldLines[a] === newLines[b]) {
      out.push({ kind: "same", text: oldLines[a] });
      a++;
      b++;
    } else if (lcs[(a + 1) * width + b] >= lcs[a * width + b + 1]) {
      out.push({ kind: "del", text: oldLines[a] });
      a++;
    } else {
      out.push({ kind: "add", text: newLines[b] });
      b++;
    }
  }
  while (a < oldLines.length) {
    out.push({ kind: "del", text: oldLines[a] });
    a++;
  }
  while (b < newLines.length) {
    out.push({ kind: "add", text: newLines[b] });
    b++;
  }
  return out;
}
