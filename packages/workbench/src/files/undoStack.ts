import { trimTrailingSlashes } from "./pathStrings";


/** How deep the memory goes. Older steps fall off the bottom. */
export const UNDO_LIMIT = 50;

/** What the stack remembers about one landed operation. */
export type UndoEntry =
  /**
   * A copy or a move through fs_transfer. `src` is where it started,
   * `landed` is the ANSWER the backend gave — the yielded name included.
   */
  | { kind: "transfer"; cut: boolean; src: string; landed: string }
  /** A rename (same directory, new name — the facts are absolute). */
  | { kind: "rename"; from: string; to: string }
  /** A create: file or folder, at a path that did not exist. */
  | { kind: "create"; path: string; dir: boolean }
  /**
   * A trash. Recorded so ⌘Z can name what it cannot do — the inverse
   * (restore from the system Trash) has no API to stand on.
   */
  | { kind: "trash"; path: string }
  | { kind: "overwritten"; path: string };

/**
 * What redo re-performs: a forward operation as EXECUTABLE facts — where
 * the thing is now, which directory it goes to — because the landing is
 * never knowable in advance (free_name yields), so the redo command is
 * phrased the way the backend answers.
 */
export type ForwardOp =
  | { op: "transfer"; from: string; into: string; cut: boolean }
  | { op: "create"; path: string; dir: boolean };

/** The two stacks. Both session-only; neither ever leaves the view. */
export interface UndoState {
  undo: UndoEntry[];
  redo: ForwardOp[];
}

export const EMPTY_UNDO: UndoState = { undo: [], redo: [] };

/** The directory a path sits in ("/w1/a.txt" -> "/w1", "/a" -> "/"). */
export function parentDir(path: string): string {
  const cut = trimTrailingSlashes(path).lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "/";
}

/**
 * A user operation landed: its facts go on the undo stack, and whatever
 * was waiting on the redo stack is gone — a new step forks history, the
 * classic rule, so redo can never replay steps around a branch the user
 * left.
 */
export function recordOp(state: UndoState, entry: UndoEntry): UndoState {
  return {
    undo: [...state.undo, entry].slice(-UNDO_LIMIT),
    redo: [],
  };
}

/** Take the newest step off the undo stack, if there is one. */
export function popUndo(state: UndoState): { entry: UndoEntry; state: UndoState } | null {
  if (state.undo.length === 0) return null;
  return {
    entry: state.undo[state.undo.length - 1],
    state: { ...state, undo: state.undo.slice(0, -1) },
  };
}

/** Take the most recently undone operation off the redo stack, if any. */
export function popRedo(state: UndoState): { op: ForwardOp; state: UndoState } | null {
  if (state.redo.length === 0) return null;
  return {
    op: state.redo[state.redo.length - 1],
    state: { ...state, redo: state.redo.slice(0, -1) },
  };
}

/**
 * An inverse LANDED: the operation goes back on the redo stack, beneath
 * whatever is already there. Nothing clears the undo stack — undoing five
 * steps and redoing two leaves the three older steps exactly where they
 * were.
 */
export function settleUndo(state: UndoState, op: ForwardOp): UndoState {
  return { ...state, redo: [...state.redo, op].slice(-UNDO_LIMIT) };
}

/**
 * A redo LANDED: its fresh facts (the new landing included) go back on
 * the undo stack. The redo stack was already popped by `popRedo`; the
 * rest of it survives, because replaying one step of a branch is not
 * abandoning the branch.
 */
export function settleRedo(state: UndoState, entry: UndoEntry): UndoState {
  return { ...state, undo: [...state.undo, entry].slice(-UNDO_LIMIT) };
}

/** What undoing one step does: an honest refusal, or the op to run. */
export type UndoPlan =
  | { undo: "none"; why: "trash" | "overwritten"; path: string }
  | { undo: "transfer"; from: string; into: string }
  | { undo: "trash"; path: string };

/**
 * The decision table. Every executable inverse is a TRANSFER INTO A
 * DIRECTORY (free_name yields at the backend) or a TRASH — never a bare
 * rename, per the module's opening rule.
 */
export function planUndo(entry: UndoEntry): UndoPlan {
  switch (entry.kind) {
    case "transfer":
      if (entry.cut) {
        // A move goes home: the file (wherever it landed) back into the
        // directory it started in.
        return { undo: "transfer", from: entry.landed, into: parentDir(entry.src) };
      }
      // A copy's inverse is to take the copy away — to the Trash, which
      // is reversible in the way this app knows how.
      return { undo: "trash", path: entry.landed };
    case "rename":
      // Back into the directory it was renamed in, NOT back onto its old
      // name: the old name may have been taken since, and yielding is
      // safer than refusing.
      return { undo: "transfer", from: entry.to, into: parentDir(entry.from) };
    case "create":
      return { undo: "trash", path: entry.path };
    case "trash":
      return { undo: "none", why: "trash", path: entry.path };
    case "overwritten":
      return { undo: "none", why: "overwritten", path: entry.path };
  }
}

/**
 * The forward operation an undo leaves behind for redo. `inverseLanding`
 * is where the inverse transfer LANDED (null when the inverse trashed):
 * redo takes the file from where it actually is now, not from a path it
 * left hours of undo ago.
 */
export function forwardFor(entry: UndoEntry, inverseLanding: string | null): ForwardOp {
  switch (entry.kind) {
    case "transfer":
      return {
        op: "transfer",
        from: entry.cut ? (inverseLanding ?? entry.landed) : entry.src,
        into: parentDir(entry.landed),
        cut: entry.cut,
      };
    case "rename":
      return {
        op: "transfer",
        from: inverseLanding ?? entry.to,
        into: parentDir(entry.to),
        cut: true,
      };
    case "create":
      return { op: "create", path: entry.path, dir: entry.dir };
    case "trash":
    case "overwritten":
      // Unreachable through the executor (planUndo refuses these before
      // any forward op is built); the shape is here so the compiler keeps
      // the table total.
      return { op: "create", path: entry.path, dir: false };
  }
}
