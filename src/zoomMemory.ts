import { loadState, saveState } from "./persist";
import { isFreshRun } from "./state/store";


/** The scope this memory occupies in the state store. */
export const ZOOM_SCOPE = "browser-zoom";

/** How many hosts are kept; the least recently set is dropped past this. */
export const ZOOM_MAX = 200;

/** One host's remembered zoom. */
export interface ZoomEntry {
  host: string;
  scale: number;
}

interface StoredZoom {
  version: 1;
  entries: ZoomEntry[];
}

/**
 * Set `host`'s zoom, keeping the list ordered oldest-first and capped: setting
 * a host moves it to the most-recent end, and once the list is over `cap` the
 * oldest (front) entries fall off. Pure, so the eviction rule is testable.
 */
export function upsert(
  entries: ZoomEntry[],
  host: string,
  scale: number,
  cap = ZOOM_MAX
): ZoomEntry[] {
  const kept = entries.filter((e) => e.host !== host);
  kept.push({ host, scale });
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
}

let entries: ZoomEntry[] = [];

/** Load the stored zoom levels once at boot. A fresh run stays empty. */
export async function loadZoomMemory(): Promise<void> {
  if (isFreshRun()) return;
  const stored = await loadState<StoredZoom>(ZOOM_SCOPE);
  if (stored && Array.isArray(stored.entries)) {
    entries = stored.entries.filter(
      (e) =>
        e &&
        typeof e.host === "string" &&
        e.host.length > 0 &&
        typeof e.scale === "number" &&
        e.scale > 0
    );
    // Trust the file no further than the cap: a hand-edited file cannot make
    // the memory grow without bound.
    if (entries.length > ZOOM_MAX) entries = entries.slice(entries.length - ZOOM_MAX);
  }
}

/** The remembered zoom for a host, or undefined if none was ever set. */
export function zoomFor(host: string): number | undefined {
  if (!host) return undefined;
  return entries.find((e) => e.host === host)?.scale;
}

/**
 * Remember a host's zoom (the ⌘±0 result). A fresh run keeps it in memory so
 * the feature works within the session — freshness is about the disk, not the
 * running app (the store's own persist doorway updates state and skips only
 * the write) — and only the save to disk is what a zero-trace run withholds.
 */
export function rememberZoom(host: string, scale: number): void {
  if (!host) return;
  entries = upsert(entries, host, scale);
  if (isFreshRun()) return;
  saveState(ZOOM_SCOPE, { version: 1, entries } satisfies StoredZoom);
}

export function zoomEntries(): ZoomEntry[] {
  return entries.map((e) => ({ ...e }));
}

export function forgetZoom(host: string): void {
  if (!host) return;
  entries = entries.filter((e) => e.host !== host);
  if (isFreshRun()) return;
  saveState(ZOOM_SCOPE, { version: 1, entries } satisfies StoredZoom);
}

export function clearZoomMemory(): void {
  entries = [];
  if (isFreshRun()) return;
  saveState(ZOOM_SCOPE, { version: 1, entries } satisfies StoredZoom);
}
