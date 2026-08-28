import { deleteState, loadState, saveState } from "../../persist";
import { isFreshRun } from "../../state/store";


export const RECENT_PATHS_SCOPE = "recent-paths";
export const RECENT_PATHS_MAX = 20;

interface StoredRecentPaths {
  version: 1;
  paths: string[];
}

/**
 * The list after a jump: the path moves to the front, a duplicate dies, the
 * oldest falls off past the cap. Pure, so the interesting parts — dedupe,
 * the cap, no-ops for junk — are testable without a store.
 */
export function mergeRecentPath(
  paths: readonly string[],
  path: string
): string[] {
  const t = path.trim();
  if (!t) return paths.slice();
  return [t, ...paths.filter((p) => p !== t)].slice(0, RECENT_PATHS_MAX);
}

/** Whatever survived a round trip through storage, shaped and believable. */
function sanitize(stored: StoredRecentPaths | null): string[] {
  if (!stored || !Array.isArray(stored.paths)) return [];
  return stored.paths
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .slice(0, RECENT_PATHS_MAX);
}

let cache: string[] | null = null;
let gen = 0;

/** The remembered paths, newest first. */
export async function recentPaths(): Promise<string[]> {
  if (cache) return cache.slice();
  // A fresh (test) run neither inherits the real machine's paths nor
  // writes over them.
  if (isFreshRun()) return (cache ??= []);
  const mine = gen;
  const loaded = await loadState<StoredRecentPaths>(RECENT_PATHS_SCOPE);
  if (gen !== mine) return cache ?? [];
  cache ??= sanitize(loaded);
  return cache.slice();
}

/**
 * Note that a jump landed somewhere. Fire-and-forget, like everything on
 * the persistence path: a history that fails to save must never break the
 * jump it is recording.
 */
export function recordRecentPath(path: string): void {
  const t = path.trim();
  if (!t) return;
  void recentPaths().then((list) => {
    const next = mergeRecentPath(list, t);
    if (next === list) return;
    cache = next;
    if (isFreshRun()) return;
    saveState(RECENT_PATHS_SCOPE, { version: 1, paths: next } as const);
  });
}

/** Forget everything (the privacy escape hatch, one scope). */
export function clearRecentPaths(): void {
  gen += 1;
  cache = [];
  if (isFreshRun()) return;
  deleteState(RECENT_PATHS_SCOPE);
}
