import { isCommandModifier } from "./platform";
import {
  chordId,
  eventChord,
  eventChordId,
  matchBinding,
  type KeyEventLike,
} from "./shortcuts";


/** What a key press means to the file explorer. */
export type FilesKeyAction =
  | { command: "find"; replace: boolean }
  | { command: "quick-open" }
  | { command: "save-file" }
  | { command: "terminal-panel" }
  | { command: "undo" }
  | { command: "redo" };

/** Which way a pane key points. Index order in the table's four-part rows. */
export const PANE_DIRS = ["left", "right", "up", "down"] as const;
export type PaneKeyDir = (typeof PANE_DIRS)[number];

/** What a key press means to a terminal tab. */
export type TerminalKeyAction =
  | { command: "find" }
  | { command: "command-blocks"; dir: -1 | 1 }
  | { command: "split-pane"; vertical: boolean }
  | { command: "focus-pane"; dir: PaneKeyDir }
  | { command: "resize-pane"; dir: PaneKeyDir }
  | { command: "zoom-pane" }
  | { command: "toggle-broadcast" }
  // Jump to the bottom (the scrollback's newest line), iTerm2's ⌘End
  // family: reading a long build's tail should not be a scroll hunt.
  | { command: "scroll-end"; dir: -1 | 1 };

/** The same event with ⌥ down-graded, for the one binding that has a variant. */
function withoutAlt(e: KeyEventLike): KeyEventLike {
  return {
    key: e.key,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: false,
    metaKey: e.metaKey,
  };
}

/**
 * The explorer's four: find, quick open, save, the terminal panel.
 *
 * Find is asked twice. ⌥ on find does not name a different binding — it
 * selects the editor's replace mode on the SAME binding — so a press
 * carrying ⌥ is offered to find a second time with the flag dropped, and
 * only after the other three have had the chord exactly as it was pressed.
 * Last, so that a row which genuinely holds an ⌥ chord keeps it against
 * find's shadow of the same combination.
 */
export function filesKeyAction(e: KeyEventLike): FilesKeyAction | null {
  // A bare key belongs to the editor. This is about the SHAPE of the press,
  // not about which key it is, so no rebinding can invalidate it.
  if (!e.metaKey && !e.ctrlKey) return null;
  const cmd = isCommandModifier(e);
  const pressed = eventChordId(e, cmd);

  if (matchBinding("find", pressed) === 0) return { command: "find", replace: false };
  if (matchBinding("quick-open", pressed) === 0) return { command: "quick-open" };
  if (matchBinding("save-file", pressed) === 0) return { command: "save-file" };
  if (matchBinding("terminal-panel", pressed) === 0) return { command: "terminal-panel" };
  if (e.altKey && matchBinding("find", eventChordId(withoutAlt(e), cmd)) === 0) {
    return { command: "find", replace: true };
  }
  if (e.key.toLowerCase() === "z" && !e.altKey) {
    return e.shiftKey ? { command: "redo" } : { command: "undo" };
  }
  return null;
}

/**
 * The terminal's two: search the scrollback, and step through command blocks.
 *
 * The block row is a compound — `⌘↑ / ⌘↓`, previous then next — and the
 * DIRECTION is read off which half of the row matched, not off the arrow
 * glyph. Rebind the row to `⌘⇧K / ⌘⇧J` and the first half is still previous.
 */
export function terminalKeyAction(e: KeyEventLike): TerminalKeyAction | null {
  // Never Ctrl on a Mac: Ctrl+F is readline's forward-char and Ctrl+↑/↓
  // belong to whatever TUI is running — swallowing them here broke them.
  if (!isCommandModifier(e)) return null;
  // The guard just established the command modifier, so the chord is read
  // with it rather than by asking the platform a second time.
  const pressed = commandChordId(e);

  if (matchBinding("find", pressed) === 0) return { command: "find" };
  const half = matchBinding("command-blocks", pressed);
  if (half === 0) return { command: "command-blocks", dir: -1 };
  if (half === 1) return { command: "command-blocks", dir: 1 };

  if (matchBinding("split-pane-vertical", pressed) === 0) {
    // "Split vertically" is iTerm2's name for a vertical DIVIDER: the two
    // panes end up side by side, which the tree calls `vertical: false`.
    return { command: "split-pane", vertical: false };
  }
  if (matchBinding("split-pane-horizontal", pressed) === 0) {
    return { command: "split-pane", vertical: true };
  }
  if (matchBinding("zoom-pane", pressed) === 0) return { command: "zoom-pane" };
  if (matchBinding("toggle-broadcast", pressed) === 0) {
    return { command: "toggle-broadcast" };
  }
  const focusAt = matchBinding("focus-pane-dir", pressed);
  if (focusAt >= 0 && focusAt < PANE_DIRS.length) {
    return { command: "focus-pane", dir: PANE_DIRS[focusAt] };
  }
  const resizeAt = matchBinding("resize-pane-dir", pressed);
  if (resizeAt >= 0 && resizeAt < PANE_DIRS.length) {
    return { command: "resize-pane", dir: PANE_DIRS[resizeAt] };
  }
  // Scroll is a real table row (⌘↑ / ⌘↓): users may rebind it; the
  // command-block row is ⌘⇧↑ / ⌘⇧↓. ⌘End/Home remain aliases for iTerm2
  // muscle memory.
  const scrollAt = matchBinding("scroll-end", pressed);
  if (scrollAt === 0) return { command: "scroll-end", dir: -1 };
  if (scrollAt === 1) return { command: "scroll-end", dir: 1 };
  if (!e.shiftKey && !e.altKey && !e.ctrlKey) {
    if (e.key === "End") return { command: "scroll-end", dir: 1 };
    if (e.key === "Home") return { command: "scroll-end", dir: -1 };
  }
  return null;
}

/**
 * The chord a press carries, once the command modifier is known to be down
 * — with ⌃ KEPT when ⌃ is not the modifier that made it a command chord.
 *
 * `eventChord` drops ⌃ whenever the command modifier is present, and that
 * is right on Windows and Linux, where Ctrl IS the command modifier and
 * reporting it twice would turn every ⌘-chord into a ⌃⌘-chord. On a Mac it
 * is not: ⌃ and ⌘ are two different keys, and the pane resize row is
 * `⌃⌘←` — read through `eventChord` a press of it comes out as plain `⌘←`,
 * which is not merely a miss. `⌃⌘↑` would come out as `⌘↑` and step through
 * the command blocks, so the wrong thing would happen rather than nothing.
 *
 * The discriminator is ⌘ itself, which is why no platform question is asked
 * here: if the press carries ⌘ then ⌘ is the command modifier and a ⌃ on the
 * same press is a modifier in its own right; if it does not, the command
 * modifier can only have been Ctrl, and Ctrl is already accounted for.
 */
function commandChordId(e: KeyEventLike): string {
  const base = eventChord(e, true);
  return e.metaKey ? chordId({ ...base, ctrl: e.ctrlKey }) : chordId(base);
}

export function isIMEComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229 || e.key === "Process";
}

export function isCmdArrow(e: KeyboardEvent): boolean {
  return e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp");
}

/**
 * Install one view's decider on the window, in the capture phase, and hand
 * back the removal.
 *
 * The phase and the target are not incidental. Listeners on one target in
 * one phase all run, in the order they were added, and `stopPropagation`
 * does not reach a sibling — so a view's listener and the app-wide handler
 * both see a chord they both claim, and the view can only win by being
 * offered the key first (see `components/files/fileCloseKey.ts`, which turns
 * that ordering into a mechanism). Written once here so that neither view
 * can quietly choose bubble phase and start losing keys it thinks it owns.
 */
export function onLocalKeys<A>(
  decide: (e: KeyEventLike) => A | null,
  run: (action: A, e: KeyboardEvent) => void
): () => void {
  const handler = (e: KeyboardEvent) => {
    if (isIMEComposing(e) && !isCmdArrow(e)) return;
    const action = decide(e);
    if (action !== null) run(action, e);
  };
  window.addEventListener("keydown", handler, { capture: true });
  return () => window.removeEventListener("keydown", handler, { capture: true });
}
