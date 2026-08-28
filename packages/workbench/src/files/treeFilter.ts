import type { FileEntry } from "./FileEntry";


export type FilterKind = "all" | "dirs" | "files";

export interface TreeFilter {
  text: string;
  kind: FilterKind;
}

/** No filter: everything shown, the tree's ordinary walk. */
export const NO_FILTER: TreeFilter = { text: "", kind: "all" };

export function filterActive(f: TreeFilter): boolean {
  return f.text !== "" || f.kind !== "all";
}

/** Substring on the name, case-blind, plus the kind's one rule. */
export function entryMatches(entry: FileEntry, f: TreeFilter): boolean {
  if (f.kind === "dirs" && !entry.isDir) return false;
  if (f.kind === "files" && entry.isDir) return false;
  return entry.name.toLowerCase().includes(f.text.toLowerCase());
}

/** A row on screen while filtering: the entry, at its depth from the root. */
export interface FilteredRow {
  entry: FileEntry;
  depth: number;
}

export interface FilteredTree {
  rows: FilteredRow[];
  /** Everything visible under the loaded directories — the "of M". */
  total: number;
}

/**
 * The matches across everything loaded, deepest-first search of the tree's
 * own cache. Hidden entries obey the same toggle the ordinary rows do.
 */
export function filterRows(
  children: ReadonlyMap<string, readonly FileEntry[]>,
  root: string,
  showHidden: boolean,
  f: TreeFilter
): FilteredTree {
  const rows: FilteredRow[] = [];
  let total = 0;
  const walk = (dir: string, depth: number) => {
    for (const entry of children.get(dir) ?? []) {
      if (!showHidden && entry.name.startsWith(".")) continue;
      total++;
      if (entryMatches(entry, f)) rows.push({ entry, depth });
      if (entry.isDir) walk(entry.path, depth + 1);
    }
  };
  if (root) walk(root, 0);
  return { rows, total };
}
