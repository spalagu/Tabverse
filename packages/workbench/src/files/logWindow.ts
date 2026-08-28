
/** Bytes fetched per load. Well under the server's 1 MiB range cap. */
export const LOG_WINDOW = 256 * 1024;

/** In-memory ceiling for the assembled text, to keep the DOM bounded. */
export const LOG_TEXT_CAP = 2 * 1024 * 1024;

const LF = 0x0a;

/**
 * A window that starts mid-file almost always starts mid-line; drop through
 * the first newline so the view begins on a real line. Two deliberate
 * exceptions keep bytes visible: a window at the very start of the file is
 * already line-aligned, and a window with no newline at all is one giant
 * partial line — showing it beats showing nothing.
 */
export function alignToLineStart(
  chunk: Uint8Array,
  atFileStart: boolean
): { bytes: Uint8Array; droppedBytes: number } {
  if (atFileStart) return { bytes: chunk, droppedBytes: 0 };
  const nl = chunk.indexOf(LF);
  if (nl < 0) return { bytes: chunk, droppedBytes: 0 };
  return { bytes: chunk.subarray(nl + 1), droppedBytes: nl + 1 };
}

/** Lossy UTF-8: invalid sequences become U+FFFD instead of throwing. */
export function decodeLossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Prepend an older chunk to the text on screen, enforcing the cap by cutting
 * whole lines off the far (newest) end — the reader who asked for earlier
 * bytes is at the top, so the bottom is what can go. Returns the removed
 * suffix so the caller can shrink its byte range to match.
 */
export function prependCapped(
  older: string,
  current: string,
  cap: number
): { text: string; cut: string } {
  const joined = older + current;
  if (joined.length <= cap) return { text: joined, cut: "" };
  // Cut on a line boundary at or before the cap so no partial line lingers
  // at the bottom; a single line longer than the cap gets a hard cut.
  const nl = joined.lastIndexOf("\n", cap - 1);
  const end = nl >= 0 ? nl + 1 : cap;
  return { text: joined.slice(0, end), cut: joined.slice(end) };
}
