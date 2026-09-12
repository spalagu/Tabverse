export const SEARCH_HISTORY_SCOPE = "search-history";
export const SEARCH_HISTORY_MAX = 50;

export interface SearchParams {
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string | null;
  exclude: string | null;
}

export interface SearchHistoryPort {
  load: () => Promise<SearchParams[]>;
  record: (entry: SearchParams) => void;
}

export interface SearchHistoryStoragePort {
  load: () => Promise<unknown>;
  save: (value: unknown) => void;
  remove: () => void;
  isFreshRun: () => boolean;
  invalid?: (reason: string) => void;
}

export interface SearchHistoryController extends SearchHistoryPort {
  clear: () => void;
}

export function sameSearchParams(a: SearchParams, b: SearchParams): boolean {
  return (
    a.query === b.query &&
    a.replacement === b.replacement &&
    a.caseSensitive === b.caseSensitive &&
    a.wholeWord === b.wholeWord &&
    a.regex === b.regex &&
    a.include === b.include &&
    a.exclude === b.exclude
  );
}

export function mergeSearchHistory(
  list: readonly SearchParams[],
  entry: SearchParams
): SearchParams[] {
  if (!entry.query.trim()) return list.slice();
  return [
    entry,
    ...list.filter((candidate) => !sameSearchParams(candidate, entry)),
  ].slice(0, SEARCH_HISTORY_MAX);
}

function sanitizeEntry(value: unknown): SearchParams | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join("\0") !==
      [
        "caseSensitive",
        "exclude",
        "include",
        "query",
        "regex",
        "replacement",
        "wholeWord",
      ].join("\0") ||
    typeof record.query !== "string" ||
    !record.query.trim() ||
    typeof record.replacement !== "string" ||
    typeof record.caseSensitive !== "boolean" ||
    typeof record.wholeWord !== "boolean" ||
    typeof record.regex !== "boolean" ||
    !(record.include === null || typeof record.include === "string") ||
    !(record.exclude === null || typeof record.exclude === "string")
  ) return null;
  return {
    query: record.query,
    replacement: record.replacement,
    caseSensitive: record.caseSensitive,
    wholeWord: record.wholeWord,
    regex: record.regex,
    include: record.include,
    exclude: record.exclude,
  };
}

function sanitize(value: unknown): SearchParams[] | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== "searches\0version" ||
    record.version !== 1 ||
    !Array.isArray(record.searches) ||
    record.searches.length > SEARCH_HISTORY_MAX
  ) return null;
  const searches = record.searches.map(sanitizeEntry);
  return searches.some((entry) => entry === null)
    ? null
    : (searches as SearchParams[]);
}

export function searchHistoryStep(
  list: readonly SearchParams[],
  cursor: number,
  direction: -1 | 1
): { entry: SearchParams; cursor: number } | null {
  if (list.length === 0) return null;
  if (direction === -1) {
    const next = Math.min(cursor + 1, list.length - 1);
    return { entry: list[next], cursor: next };
  }
  if (cursor === -1) return null;
  const next = cursor - 1;
  return next === -1 ? null : { entry: list[next], cursor: next };
}

/** Create one local-only search-history controller over an injected store. */
export function createSearchHistoryController(
  storage: SearchHistoryStoragePort
): SearchHistoryController {
  let cache: SearchParams[] | null = null;
  let generation = 0;

  const load = async (): Promise<SearchParams[]> => {
    if (cache) return cache.slice();
    if (storage.isFreshRun()) return (cache ??= []);
    const ownGeneration = generation;
    const stored = await storage.load();
    if (generation !== ownGeneration) return cache ?? [];
    const decoded = sanitize(stored);
    if (decoded === null) {
      storage.invalid?.("invalid current Files search-history record");
      return [];
    }
    cache ??= decoded;
    return cache.slice();
  };

  const record = (entry: SearchParams): void => {
    if (!entry.query.trim()) return;
    void load().then((list) => {
      const next = mergeSearchHistory(list, entry);
      cache = next;
      if (storage.isFreshRun()) return;
      storage.save({ version: 1, searches: next });
    });
  };

  const clear = (): void => {
    generation += 1;
    cache = [];
    if (!storage.isFreshRun()) storage.remove();
  };

  return { load, record, clear };
}
