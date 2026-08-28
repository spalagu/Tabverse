import { useEffect, useSyncExternalStore } from "react";


const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** host -> data URL: what this site looked like, good enough for a cold tab. */
const icons = new Map<string, string>();
/** tab id -> data URL: what THIS tab's page is showing right now. */
const live = new Map<string, string>();
/** Hosts already asked of the core's cache, so each costs one round trip. */
const asked = new Set<string>();
const subs = new Set<() => void>();
let wired = false;

function notify() {
  for (const fn of subs) fn();
}

function wire() {
  if (wired || !isTauri) return;
  wired = true;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<{ tabId: string; host: string; dataUrl: string }>(
      "browser-favicon",
      (e) => {
        const { tabId, host, dataUrl } = e.payload;
        // The reporting tab's own icon, and the host's cold-start default.
        const tabChanged = tabId !== "" && live.get(tabId) !== dataUrl;
        if (tabChanged) live.set(tabId, dataUrl);
        const hostChanged = icons.get(host) !== dataUrl;
        if (hostChanged) icons.set(host, dataUrl);
        if (tabChanged || hostChanged) notify();
      }
    )
  );
}

/** The cache key a tab's address maps to, or null for no address. */
export function faviconHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function askCore(host: string) {
  if (!isTauri || asked.has(host)) return;
  asked.add(host);
  void import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke<string | null>("favicon_lookup", { host })
      .then((hit) => {
        // A live fetch may have answered while the ask was in flight; the
        // fetched icon is newer than the disk's and must not be overwritten.
        if (typeof hit === "string" && !icons.has(host)) {
          icons.set(host, hit);
          notify();
        }
      })
      .catch(() => {
      })
  );
}

/** A closed tab's live icon is nobody's; drop it with the tab. */
export function forgetTabFavicon(tabId: string): void {
  if (live.delete(tabId)) notify();
}

/**
 * The icon to draw for a tab: what its own page last reported, else what this
 * host looked like last time. Passing the tab id is what keeps two tabs on one
 * host apart; without it a caller gets the host's icon, which is right for a
 * row that has no tab behind it (a history entry, say).
 */
export function useFavicon(
  url: string | undefined,
  tabId?: string
): string | null {
  const host = faviconHost(url);
  useEffect(() => {
    wire();
    if (host) askCore(host);
  }, [host]);
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () =>
      (tabId !== undefined ? live.get(tabId) : undefined) ??
      (host ? icons.get(host) ?? null : null)
  );
}
