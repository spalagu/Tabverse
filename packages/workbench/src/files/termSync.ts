import {
  collapseRepeatedSlashes,
  trimTrailingSlashes,
} from "./pathStrings";


/** What one side's change should cause on the other. */
export type SyncAction =
  /** Write a `cd` into the shell: the tab moved and the shell has not. */
  | "send-cd"
  /** Move the tab's directory: the shell moved and the tab has not. */
  | "follow"
  /** Both sides already agree, or the change is one we caused ourselves. */
  | "ignore";

/** Which side just changed. */
export type SyncSource = "tab" | "shell";

/**
 * One directory in the single form both sides are compared in. The two
 * sources spell the same place differently — the location bar accepts a
 * trailing slash and a doubled separator, the shell prints $PWD without
 * either — and a comparison on the raw strings would call "/work/" and
 * "/work" different places and cd back and forth between them forever.
 */
export function normalizeDir(dir: string | null | undefined): string | null {
  if (typeof dir !== "string") return null;
  const collapsed = collapseRepeatedSlashes(dir);
  const trimmed =
    collapsed.length > 1 ? trimTrailingSlashes(collapsed) : collapsed;
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * What to do about a directory change.
 *
 * @param source   which side moved
 * @param current  where the OTHER side already is (the shell's reported cwd
 *                 when the tab moved; the tab's directory when the shell did),
 *                 or null when it has never said
 * @param incoming where the side that moved now is
 * @param lastSent the directory of the cd we have written and not yet seen
 *                 come back, or null when nothing is in flight
 *
 * The echo dies on the `current` comparison, in both directions, because the
 * side that caused the change is by definition already there: the OSC 7 that
 * our own cd produces arrives when the tab is already at that directory, so
 * it is not a new place to follow. `lastSent` covers the one window that
 * comparison cannot see — between writing a cd and the shell reporting it,
 * the shell's known cwd is still the old one, so a second look at the same
 * tab directory would send the identical cd again.
 *
 * Deliberately NOT symmetric: a shell report is followed whenever the tab is
 * somewhere else, even when it matches the cd we sent. Suppressing that case
 * too would leave the two permanently apart whenever the tab moved twice
 * while the first cd was still travelling — the tab would sit at the older
 * directory and the shell at the newer one with nothing left to reconcile
 * them. Following always converges, at worst through one visible step.
 */
export function syncDecision(
  source: SyncSource,
  current: string | null,
  incoming: string | null,
  lastSent: string | null
): SyncAction {
  const to = normalizeDir(incoming);
  if (!to) return "ignore";
  const here = normalizeDir(current);
  if (to === here) return "ignore";
  if (source === "shell") return "follow";
  return to === normalizeDir(lastSent) ? "ignore" : "send-cd";
}

/**
 * Characters that mean only themselves to every shell, in every position of
 * an argument. Everything else — a space, a quote, a $, a *, a ~, a ! — is
 * either syntax or expansion, and has to be taken out of the shell's hands.
 */
const BARE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * A path as one shell word.
 *
 * Quoting is added only where it changes the meaning, because this command is
 * written into a terminal the user is watching: `cd /Users/me/project` is what
 * they would have typed, and dressing every path in quotes makes the panel
 * look like it is talking to a machine rather than doing what they asked.
 *
 * When quoting is needed, single quotes are the form every shell we can land
 * in (zsh, bash, fish, dash) reads identically — inside them a space, a $, a
 * backtick and a backslash are all literal — and the one character they
 * cannot contain is closed, escaped and reopened. This is not paranoia:
 * `Don't Panic` is a legal folder name, and unquoted it would leave the shell
 * waiting for a quote that never comes.
 */
export function quoteShellPath(path: string): string {
  if (BARE_WORD.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The exact bytes that move the shell, newline included — it is a command. */
export function cdCommand(path: string): string {
  return `cd ${quoteShellPath(path)}\n`;
}

/** Below this the panel is a scrollbar with a line of text in it. */
export const PANEL_MIN_PX = 80;

/** The panel is a helper for the file view, never the thing that hides it. */
export const PANEL_MAX_FRACTION = 0.7;

/** Tall enough for a prompt, a command and its answer. */
export const PANEL_DEFAULT_PX = 220;

/**
 * A stored or dragged panel height, made legal for the pane it lives in.
 *
 * `paneHeight` of 0 means "not measured yet" — restoring from disk happens
 * long before any layout — and then only the floor can be applied. When the
 * pane is so short that the ceiling falls below the floor, the ceiling wins:
 * the panel may be too small to be useful, but it must never be the reason
 * the files it belongs to cannot be seen.
 */
export function clampPanelHeight(desired: number, paneHeight = 0): number {
  const cap =
    paneHeight > 0 ? Math.floor(paneHeight * PANEL_MAX_FRACTION) : Infinity;
  if (!Number.isFinite(desired)) {
    return Math.min(PANEL_DEFAULT_PX, cap);
  }
  return Math.round(Math.min(Math.max(desired, PANEL_MIN_PX), cap));
}
