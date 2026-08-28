import { deleteState, loadState, saveState } from "./persist";
import { isFreshRun } from "./state/store";


/** The scope this history occupies in the state store. */
export const HISTORY_SCOPE = "browser-history";

/** How many sites are kept; the weakest are dropped past this. */
export const HISTORY_MAX = 500;

/**
 * A visit that keeps scoring for this long. Frequency halves every week of
 * silence, so a habit fades over roughly a month rather than a day.
 */
export const HALF_LIFE_DAYS = 7;

/**
 * One page view emits several events (the load finishing, then the title
 * arriving, then a probe), and a reload is not a new habit either. Repeats of
 * the same address inside this window are one visit: the title still lands,
 * the count does not drift upwards.
 */
export const VISIT_COALESCE_MS = 30_000;

const DAY_MS = 86_400_000;

/** One site in the history, as stored. */
export interface VisitEntry {
  /** The exact address to go back to. */
  url: string;
  /** Last page title seen there; empty until the engine reports one. */
  title: string;
  /** Host of `url`, kept so ranking and filtering never re-parse it. */
  host: string;
  /** How many separate visits were counted. */
  visits: number;
  /** Epoch ms of the most recent visit. */
  lastVisit: number;
}

interface StoredHistory {
  version: 1;
  entries: VisitEntry[];
}

/**
 * Whether an address is somewhere you could go back to. Blank tabs, empty
 * strings and the in-memory schemes are events, not places — recording them
 * would put rows in the new-tab list that lead nowhere.
 */
export function isRecordableUrl(url: string): boolean {
  const raw = url.trim();
  if (!raw) return false;
  if (/^(about|data|blob|javascript):/i.test(raw)) return false;
  try {
    const u = new URL(raw);
    return !!u.host || u.protocol === "file:";
  } catch {
    return false;
  }
}

/** Host to show under a title; falls back to the scheme for local files. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host || u.protocol.replace(":", "");
  } catch {
    return url;
  }
}

/**
 * How strongly a site deserves the top of the new-tab list.
 *
 *   score = (1 + ln(visits)) * 2 ^ (-ageDays / HALF_LIFE_DAYS)
 *   ageDays = max(0, (now - lastVisit) / one day)
 *
 * Two shapes, on purpose. Frequency enters through a logarithm, so the 40th
 * visit to a site counts for far less than its 4th — a place you go daily
 * cannot bury everything else forever. Recency enters as exponential decay
 * with a one-week half-life, so a habit that stopped fades instead of holding
 * its rank. Together they give what the requirement asks for: 20 visits a
 * month ago score (1+ln20) * 2^(-30/7) ~ 0.20, while 5 visits today score
 * (1+ln5) * 1 ~ 2.61 — today wins, and it takes a very large frequency gap to
 * overturn a much fresher visit.
 */
export function scoreSite(entry: VisitEntry, now: number): number {
  const ageDays = Math.max(0, (now - entry.lastVisit) / DAY_MS);
  const frequency = 1 + Math.log(Math.max(1, entry.visits));
  return frequency * Math.pow(2, -ageDays / HALF_LIFE_DAYS);
}

/**
 * Entries best-first. Ties break on the more recent visit, then on the
 * address, so the same input always produces the same order — a list that
 * reshuffles under the cursor is worse than one that ranks imperfectly.
 */
export function rankSites(entries: VisitEntry[], now: number): VisitEntry[] {
  return entries
    .map((e) => ({ e, s: scoreSite(e, now) }))
    .sort(
      (a, b) =>
        b.s - a.s || b.e.lastVisit - a.e.lastVisit || a.e.url.localeCompare(b.e.url)
    )
    .map((x) => x.e);
}

/**
 * The entries a typed query still stands for. Matching is case-insensitive
 * substring over the host, the title and the full address, because the user
 * may remember any of the three. An empty query filters nothing.
 */
export function filterSites(entries: VisitEntry[], query: string): VisitEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  return entries.filter(
    (e) =>
      e.host.toLowerCase().includes(q) ||
      e.title.toLowerCase().includes(q) ||
      e.url.toLowerCase().includes(q)
  );
}

/**
 * The history after visiting `url`. Returns the input untouched when the
 * address is not a place (so callers know there is nothing to save), keeps
 * the newest title, and drops the weakest entries — by the same score the
 * new-tab list ranks with — once the store is over its cap.
 */
export function mergeVisit(
  entries: VisitEntry[],
  url: string,
  title: string,
  now: number
): VisitEntry[] {
  if (!isRecordableUrl(url)) return entries;
  const key = url.trim();
  const clean = title.trim();
  const at = entries.findIndex((e) => e.url === key);
  const next = entries.slice();
  if (at >= 0) {
    const prev = entries[at];
    const sameVisit = now - prev.lastVisit < VISIT_COALESCE_MS;
    next[at] = {
      ...prev,
      title: clean || prev.title,
      host: prev.host || hostOf(key),
      visits: sameVisit ? prev.visits : prev.visits + 1,
      lastVisit: Math.max(prev.lastVisit, now),
    };
  } else {
    next.push({
      url: key,
      title: clean,
      host: hostOf(key),
      visits: 1,
      lastVisit: now,
    });
  }
  if (next.length <= HISTORY_MAX) return next;
  return rankSites(next, now).slice(0, HISTORY_MAX);
}

/** Whatever survived a round trip through storage, shaped and believable. */
function sanitize(stored: StoredHistory | null): VisitEntry[] {
  if (!stored || !Array.isArray(stored.entries)) return [];
  const out: VisitEntry[] = [];
  for (const raw of stored.entries) {
    if (!raw || typeof raw.url !== "string" || !isRecordableUrl(raw.url)) continue;
    out.push({
      url: raw.url,
      title: typeof raw.title === "string" ? raw.title : "",
      host: typeof raw.host === "string" && raw.host ? raw.host : hostOf(raw.url),
      visits: Number.isFinite(raw.visits) && raw.visits > 0 ? Math.floor(raw.visits) : 1,
      lastVisit: Number.isFinite(raw.lastVisit) ? raw.lastVisit : 0,
    });
  }
  return out.slice(0, HISTORY_MAX);
}


/** The scope the visit log occupies in the state store. */
export const VISITS_SCOPE = "browser-visits";

/** How many visits are kept; the oldest fall off past this. */
export const VISITS_MAX = 2000;

/** One page arrival, as the log keeps it. */
export interface VisitLogEntry {
  url: string;
  /** Last title seen for this arrival; empty until the engine reports one. */
  title: string;
  /** Epoch ms of the arrival. */
  at: number;
}

interface StoredVisits {
  version: 1;
  /** Newest first — the order the panel reads. */
  entries: VisitLogEntry[];
}

/**
 * The log after a page arrived. The same settling window as the frequency
 * store (VISIT_COALESCE_MS): a load event, the title arriving moments later
 * and a reload are one visit, so a repeat of the newest entry for that
 * address inside the window only fills in the title. Past the window the
 * same address is a new line — a log that merged them would stop being a
 * log. Newest first; the oldest entries fall off past VISITS_MAX.
 */
export function mergeVisitLog(
  entries: VisitLogEntry[],
  url: string,
  title: string,
  now: number
): VisitLogEntry[] {
  if (!isRecordableUrl(url)) return entries;
  const key = url.trim();
  const clean = title.trim();
  const at = entries.findIndex((e) => e.url === key);
  if (at >= 0 && now - entries[at].at < VISIT_COALESCE_MS) {
    const next = entries.slice();
    next[at] = {
      ...next[at],
      title: clean || next[at].title,
      at: Math.max(next[at].at, now),
    };
    return next;
  }
  return [{ url: key, title: clean, at: now }, ...entries].slice(0, VISITS_MAX);
}

export function filterVisits(
  entries: VisitLogEntry[],
  query: string
): VisitLogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  return entries.filter(
    (e) => e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)
  );
}

/** The panel's three shelves, by the calendar rather than by elapsed time. */
export interface VisitDayGroups {
  today: VisitLogEntry[];
  yesterday: VisitLogEntry[];
  earlier: VisitLogEntry[];
}

/**
 * Visits grouped the way people remember them — "today", "yesterday",
 * "before that" — which is a calendar question, not an age question: at
 * 00:30, a page read an hour ago is yesterday's. Boundaries are local
 * midnights derived from `now`, so the split is testable with a fixed
 * clock. A visit stamped in the future (a clock that ran backwards) counts
 * as today rather than vanishing from all three shelves.
 */
export function groupVisitsByDay(
  entries: VisitLogEntry[],
  now: number
): VisitDayGroups {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.getTime();
  const yesterdayStart = todayStart - DAY_MS;
  const groups: VisitDayGroups = { today: [], yesterday: [], earlier: [] };
  for (const e of entries) {
    if (e.at >= todayStart) groups.today.push(e);
    else if (e.at >= yesterdayStart) groups.yesterday.push(e);
    else groups.earlier.push(e);
  }
  return groups;
}

/** Whatever survived a round trip through storage, shaped and believable. */
function sanitizeVisits(stored: StoredVisits | null): VisitLogEntry[] {
  if (!stored || !Array.isArray(stored.entries)) return [];
  const out: VisitLogEntry[] = [];
  for (const raw of stored.entries) {
    if (!raw || typeof raw.url !== "string" || !isRecordableUrl(raw.url)) continue;
    if (!Number.isFinite(raw.at)) continue;
    out.push({
      url: raw.url,
      title: typeof raw.title === "string" ? raw.title : "",
      at: raw.at,
    });
  }
  return out.slice(0, VISITS_MAX);
}

/**
 * The loaded history, held in memory so the new-tab page never waits on disk
 * twice. `gen` invalidates a load that was still in flight when the user
 * cleared the history — otherwise the erased entries would come back.
 */
let cache: VisitEntry[] | null = null;
let gen = 0;

async function entries(): Promise<VisitEntry[]> {
  if (cache) return cache;
  // A fresh (test) run neither inherits the real machine's history nor
  // writes over it — the same zero-trace rule the session store follows.
  if (isFreshRun()) return (cache ??= []);
  const mine = gen;
  const loaded = await loadState<StoredHistory>(HISTORY_SCOPE);
  if (gen !== mine) return cache ?? [];
  cache ??= sanitize(loaded);
  return cache;
}

/** The visit log's own cache and generation, same duty as above. */
let visitsCache: VisitLogEntry[] | null = null;
let visitsGen = 0;

async function visitEntries(): Promise<VisitLogEntry[]> {
  if (visitsCache) return visitsCache;
  if (isFreshRun()) return (visitsCache ??= []);
  const mine = visitsGen;
  const loaded = await loadState<StoredVisits>(VISITS_SCOPE);
  if (visitsGen !== mine) return visitsCache ?? [];
  visitsCache ??= sanitizeVisits(loaded);
  return visitsCache;
}

function saveVisits(next: VisitLogEntry[]): void {
  visitsCache = next;
  if (isFreshRun()) return;
  const payload: StoredVisits = { version: 1, entries: next };
  saveState(VISITS_SCOPE, payload);
}

export function recordVisit(url: string, title = ""): void {
  if (!isRecordableUrl(url)) return;
  void entries().then((list) => {
    const next = mergeVisit(list, url, title, Date.now());
    if (next === list) return;
    cache = next;
    if (isFreshRun()) return;
    const payload: StoredHistory = { version: 1, entries: next };
    saveState(HISTORY_SCOPE, payload);
  });
  void visitEntries().then((list) => {
    const next = mergeVisitLog(list, url, title, Date.now());
    if (next === list) return;
    saveVisits(next);
  });
}

/** The full visit log, newest first — what the history panel renders. */
export async function recentVisits(): Promise<VisitLogEntry[]> {
  return (await visitEntries()).slice();
}

/**
 * Forget one line of the log. Identity is the (url, at) pair — the same
 * address visited twice is two rows, and deleting one must not eat the
 * other.
 */
export function deleteVisit(url: string, at: number): void {
  void visitEntries().then((list) => {
    const next = list.filter((e) => !(e.url === url && e.at === at));
    if (next.length === list.length) return;
    saveVisits(next);
  });
}

/** The sites a new tab should offer, best-first. */
export async function topSites(limit = 8): Promise<VisitEntry[]> {
  if (limit <= 0) return [];
  const list = await entries();
  return rankSites(list, Date.now()).slice(0, limit);
}

export function clearHistory(): void {
  gen += 1;
  cache = [];
  visitsGen += 1;
  visitsCache = [];
  if (isFreshRun()) return;
  deleteState(HISTORY_SCOPE);
  deleteState(VISITS_SCOPE);
}
