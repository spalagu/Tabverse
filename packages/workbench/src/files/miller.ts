import type { FileEntry } from "./FileEntry";


/** One column: the directory it lists, and the row the keyboard is on. */
export interface MillerColumn {
  dir: string;
  aimed: string | null;
}

export interface MillerState {
  columns: MillerColumn[];
  /** The column the arrows move in. */
  activeCol: number;
}

/** A brand-new column view over a root: one column, nothing aimed. */
export function millerAt(root: string): MillerState {
  return { columns: [{ dir: root, aimed: null }], activeCol: 0 };
}

/**
 * Single click on a directory in column `at`: everything after that column
 * goes away and the directory's own column is appended — the Finder
 * semantics, where clicking an ancestor's sibling collapses the branch you
 * were in. Clicking the directory the next column already shows is a
 * no-op, so re-clicking while a listing loads cannot reshuffle the row.
 */
export function millerPush(
  s: MillerState,
  at: number,
  dir: string
): MillerState {
  if (at < 0 || at >= s.columns.length) return s;
  // Already showing it one column over: just walk into that column, so
  // re-clicking while a listing loads cannot reshuffle the rows.
  if (
    s.columns.length > at + 1 &&
    s.columns[at + 1].dir === dir &&
    s.activeCol === at + 1
  ) {
    return s;
  }
  if (s.columns.length > at + 1 && s.columns[at + 1].dir === dir) {
    return { columns: s.columns, activeCol: at + 1 };
  }
  return {
    columns: [...s.columns.slice(0, at + 1), { dir, aimed: null }],
    activeCol: at + 1,
  };
}

/** The mouse sat on a row: it becomes the column's aimed row. */
export function millerAim(
  s: MillerState,
  at: number,
  path: string | null
): MillerState {
  if (at < 0 || at >= s.columns.length) return s;
  if (s.columns[at].aimed === path && s.activeCol === at) return s;
  const columns = s.columns.map((c, i) =>
    i === at ? { ...c, aimed: path } : c
  );
  return { columns, activeCol: at };
}

/**
 * The arrows. Up and down move within the active column's listing; right
 * walks into the next column (or pushes one for the aimed folder, Finder's
 * expand-on-right); left walks back out, aiming the parent column at the
 * row the current column came from — so left and right are each other's
 * inverse for the aimed row.
 *
 * `entriesFor` hands back a column's rows in display order (the caller
 * applies the pane's sort); it is a parameter rather than a Map so the
 * machine can be driven without a filesystem at all.
 */
export function millerKey(
  s: MillerState,
  entriesFor: (dir: string) => readonly FileEntry[],
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"
): MillerState {
  const at = s.activeCol;
  const col = s.columns[at];
  if (!col) return s;
  const rows = entriesFor(col.dir);
  const atIdx = rows.findIndex((e) => e.path === col.aimed);

  if (key === "ArrowUp" || key === "ArrowDown") {
    const step = key === "ArrowUp" ? -1 : 1;
    let next: number;
    if (atIdx < 0) next = step > 0 ? 0 : rows.length - 1;
    else next = Math.min(rows.length - 1, Math.max(0, atIdx + step));
    const entry = rows[next];
    if (!entry) return s;
    return millerAim(s, at, entry.path);
  }

  if (key === "ArrowLeft") {
    if (at === 0) return s;
    // The parent column aims at the row this column came from.
    return millerAim(s, at - 1, col.dir);
  }

  // ArrowRight: into the next column if there is one…
  if (at < s.columns.length - 1) {
    return { columns: s.columns, activeCol: at + 1 };
  }
  // …else the aimed folder opens a column of its own.
  const aimed = rows[atIdx];
  if (aimed?.isDir) return millerPush(s, at, aimed.path);
  return s;
}

/** The entry a path names in a column, if it is still listed there. */
export function millerEntry(
  entriesFor: (dir: string) => readonly FileEntry[],
  dir: string,
  path: string | null
): FileEntry | null {
  if (!path) return null;
  return entriesFor(dir).find((e) => e.path === path) ?? null;
}
