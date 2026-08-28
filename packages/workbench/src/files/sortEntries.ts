import type { FileEntry } from "./FileEntry";


/** The four ordering keys. "kind" is the extension, derived from the name. */
export type SortKey = "name" | "kind" | "size" | "modified";

export interface SortSpec {
  key: SortKey;
  /** Ascending when true. */
  asc: boolean;
  /** Folders ahead of files regardless of key. */
  dirsFirst: boolean;
}

/**
 * The default IS the backend's order: folders first, names ascending,
 * case-blind. Re-sorting with it is a no-op, which is what makes the option
 * "defaultable" — a stored session with no sort field behaves exactly as
 * one written before the option existed.
 */
export const DEFAULT_SORT: SortSpec = {
  key: "name",
  asc: true,
  dirsFirst: true,
};

export const SORT_KEYS: readonly SortKey[] = ["name", "kind", "size", "modified"];

/** The extension, lower-cased, without its dot; "" for none. */
export function entryKind(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Case-blind string compare in the backend's own style (`to_lowercase`,
 * not locale collation) so the render layer's order and the backend's
 * default agree on every machine instead of only where the locale does.
 */
function cmpText(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}

/**
 * One key's contribution, direction applied, without folder grouping.
 *
 * `modified` is the one key that can be unknown (the reader could not stat
 * the file). An unknown mtime sorts LAST whichever way the arrow points:
 * "when did this change" has no meaningful answer for it, and pinning it to
 * one end would make it switch ends with the direction, reading as though
 * it were the oldest (or newest) thing in the directory.
 */
function cmpKey(a: FileEntry, b: FileEntry, key: SortKey, asc: boolean): number {
  const dir = asc ? 1 : -1;
  switch (key) {
    case "name":
      return dir * cmpText(a.name, b.name);
    case "kind":
      return dir * cmpText(entryKind(a.name), entryKind(b.name));
    case "size":
      return dir * (a.size - b.size);
    case "modified": {
      if (a.modified === b.modified) return 0;
      if (a.modified === null) return 1;
      if (b.modified === null) return -1;
      return dir * (a.modified - b.modified);
    }
  }
}

/**
 * The entries in this view's order. A fresh array always: the caller's
 * cached listing (the backend's order, shared by every consumer of that
 * directory) is never reordered in place.
 *
 * Stability is relied upon: entries equal under the current key keep their
 * backend order — and the backend's own order is names-ascending, so equal
 * kinds or sizes still read alphabetically on real listings.
 */
export function sortEntries(
  entries: readonly FileEntry[],
  spec: SortSpec
): FileEntry[] {
  const out = entries.slice();
  out.sort((a, b) => {
    if (spec.dirsFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return cmpKey(a, b, spec.key, spec.asc);
  });
  return out;
}

/** Equal-to-default specs are omitted from the stored session, not written. */
export function sameSort(a: SortSpec, b: SortSpec): boolean {
  return a.key === b.key && a.asc === b.asc && a.dirsFirst === b.dirsFirst;
}
