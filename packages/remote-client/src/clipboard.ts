
/** One clip frame's ceiling, bytes — the same cap the host refuses its
 * own board's changes at. */
export const CLIP_MAX_BYTES = 256 * 1024;

/** The newest host clip this page has seen. */
interface HostClip {
  seq: number;
  text: string;
}

let last: HostClip | null = null;

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

/**
 * One ClipSync from the host: remember it, then try the local board.
 * Over-cap and stale frames never land — not on the board, not in the
 * memory reconciliation trusts.
 */
export function receiveClip(seq: number, text: string): void {
  // The host numbers its clips monotonically; a stale or replayed frame
  // cannot displace newer knowledge.
  if (last !== null && seq <= last.seq) return;
  // Bytes, not UTF-16 units: the cap means what it means on the wire.
  if (byteLength(text) > CLIP_MAX_BYTES) return;
  last = { seq, text };
  const board = navigator.clipboard;
  if (board)
    void board.writeText(text).catch(() => {
      manual = { seq, text };
      for (const fn of manualSubs) fn(text);
    });
}

/** The newest clip the board refused, awaiting a gesture. Null once
 * retried or dismissed. */
let manual: HostClip | null = null;
const manualSubs = new Set<(text: string) => void>();

/** The page's panel subscription: called with the text a refused write
 * leaves stranded. */
export function onManualClipNeeded(cb: (text: string) => void): () => void {
  manualSubs.add(cb);
  return () => {
    manualSubs.delete(cb);
  };
}

/** Retry the stranded write behind the click's gesture. Resolves true
 * when the board took it this time. */
export async function manualCopy(): Promise<boolean> {
  if (manual === null) return true;
  const ok = await navigator.clipboard
    .writeText(manual.text)
    .then(() => true)
    .catch(() => false);
  if (ok) manual = null;
  return ok;
}

/** Drop the stranded clip — the user said the panel is not needed. */
export function dismissManualClip(): void {
  manual = null;
}
export function reconcilePaste(
  local: string,
  push: (text: string) => void
): void {
  if (local && last !== null && local !== last.text) push(local);
}

/**
 * Drop everything remembered. The share is over, and residue from one
 * must not shape the next: a terminal share joined in the same page has
 * no clip channel, and its pastes have nothing to reconcile against.
 */
export function resetHostClip(): void {
  last = null;
}
