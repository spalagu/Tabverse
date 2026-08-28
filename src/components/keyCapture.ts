import { recordChord, type Chord } from "../shortcuts";


/** Where a captured press is delivered. */
export interface KeyCaptureSink {
  /** A real chord: modifiers plus a key. */
  onChord(recorded: { chord: Chord; keys: string }): void;
  /** Escape, which means "stop capturing" and never becomes a binding. */
  onCancel(): void;
}

let sink: KeyCaptureSink | null = null;

/**
 * Take the next key presses as data until the returned function is called.
 *
 * A second claim replaces the first, and releasing gives nothing back if
 * somebody else has claimed since — otherwise a row that lost its turn
 * would silently switch off the row that took it.
 */
export function captureKeys(next: KeyCaptureSink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

/** Whether a capture is in force. Read by tests; nothing else needs it. */
export function capturing(): boolean {
  return sink !== null;
}

/**
 * The one listener, installed at import time for the ordering above.
 *
 * Guarded on `window` because this module is imported by a page that is also
 * rendered in tests and, in another life, on a server; the guard is the same
 * one fileCloseKey.ts uses.
 */
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (e) => {
      const active = sink;
      if (active === null) return;
      // A bare modifier is the first half of a chord. It is swallowed as
      // well: letting ⌘ through while the app waits for ⌘-something has no
      // upside, and letting it through is how a recorder ends up recording
      // the modifier itself on a slow key repeat.
      const recorded = recordChord(e);
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (recorded === null) return;
      // Escape leaves the recording rather than becoming one. It is the one
      // key a person presses to mean "not this", and a recorder that took it
      // literally would bind the way out of itself.
      if (recorded.chord.key === "esc" && !recorded.chord.cmd) {
        active.onCancel();
        return;
      }
      active.onChord(recorded);
    },
    { capture: true }
  );
}
