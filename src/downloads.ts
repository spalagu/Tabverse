import { useSyncExternalStore } from "react";
import { requestPathOpen } from "./openIntent";
import { deleteState, loadState, markStateInvalid, saveState } from "./persist";
import { isFreshRun } from "./state/store";

/** The scope the ledger occupies in the state store. */
export const DOWNLOADS_SCOPE = "downloads";

/** How many records are kept; the oldest fall off past this. */
export const DOWNLOADS_MAX = 200;

/** The two states the engine can actually report — no progress between. */
export type DownloadState = "downloading" | "done" | "failed";

/** One download, as recorded. */
export interface DownloadEntry {
  /** Where the file was (or is being) written; the row's identity. */
  path: string;
  /** The file's name, as the row shows it. */
  name: string;
  /** Epoch ms when the download began. */
  at: number;
  state: DownloadState;
}

interface StoredDownloads {
  version: 1;
  /** Newest first — the order the panel reads. */
  entries: DownloadEntry[];
}

/**
 * The ledger after a download began. Prepends a fresh "downloading" row;
 * the oldest rows fall off past DOWNLOADS_MAX. The path is unique by the
 * core's never-overwrite naming, so no dedup is needed here.
 */
export function mergeDownloadStart(
  entries: DownloadEntry[],
  path: string,
  name: string,
  now: number
): DownloadEntry[] {
  if (!path) return entries;
  const started: DownloadEntry = {
    path,
    name: name || basename(path),
    at: now,
    state: "downloading",
  };
  return [started, ...entries].slice(0, DOWNLOADS_MAX);
}

/**
 * The ledger after a download ended. Settles the newest still-running row
 * for that path; a finish nothing matches (its start was evicted, or the
 * events raced a restart) is recorded as a fresh settled row rather than
 * dropped — a download that happened must not vanish from the record.
 */
export function mergeDownloadFinish(
  entries: DownloadEntry[],
  path: string,
  success: boolean,
  now: number
): DownloadEntry[] {
  if (!path) return entries;
  const state: DownloadState = success ? "done" : "failed";
  const at = entries.findIndex(
    (e) => e.path === path && e.state === "downloading"
  );
  if (at >= 0) {
    const next = entries.slice();
    next[at] = { ...next[at], state };
    return next;
  }
  return [{ path, name: basename(path), at: now, state }, ...entries].slice(
    0,
    DOWNLOADS_MAX
  );
}

function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** Whatever survived a round trip through storage, shaped and believable. */
function sanitize(stored: StoredDownloads | null): DownloadEntry[] | null {
  if (stored === null) return [];
  if (
    Object.keys(stored).sort().join("\0") !== "entries\0version" ||
    stored.version !== 1 ||
    !Array.isArray(stored.entries) ||
    stored.entries.length > DOWNLOADS_MAX ||
    stored.entries.some(
      (raw) =>
        !raw ||
        Object.keys(raw).sort().join("\0") !== "at\0name\0path\0state" ||
        typeof raw.path !== "string" ||
        !raw.path ||
        typeof raw.name !== "string" ||
        !raw.name ||
        !Number.isFinite(raw.at) ||
        !(["downloading", "done", "failed"] as unknown[]).includes(raw.state)
    )
  ) return null;
  return stored.entries.map((raw) => ({
    ...raw,
    // A row saved mid-download belongs to the previous process and cannot
    // still be transferring after restart.
    state: raw.state === "downloading" ? "failed" : raw.state,
  }));
}

/**
 * The ledger, in memory, with subscribers — the panel must repaint when a
 * row settles while it is open, which rules out load-on-open alone.
 */
let ledger: DownloadEntry[] = [];
let loadedOnce = false;
const listeners = new Set<() => void>();

function commit(next: DownloadEntry[]): void {
  ledger = next;
  if (!isFreshRun()) {
    const payload: StoredDownloads = { version: 1, entries: next };
    saveState(DOWNLOADS_SCOPE, payload);
  }
  listeners.forEach((fn) => fn());
}

/** The current record, newest first. */
export function downloadsSnapshot(): DownloadEntry[] {
  return ledger;
}

/** React to the ledger — the downloads panel's data feed. */
export function useDownloads(): DownloadEntry[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    downloadsSnapshot,
    downloadsSnapshot
  );
}

/**
 * Load the stored record and start listening for the core's download
 * events. Called once at boot; safe to call again (it will not double-
 * subscribe). A fresh (test) run starts empty and stays out of the disk.
 */
export function initDownloads(): void {
  if (loadedOnce) return;
  loadedOnce = true;
  const ready = !isFreshRun()
    ? loadState<StoredDownloads>(DOWNLOADS_SCOPE).then((stored) => {
      // Events that arrived while the disk was answering are newer.
      const seen = new Set(ledger.map((e) => e.path));
      const decoded = sanitize(stored);
      if (decoded === null) {
        markStateInvalid(DOWNLOADS_SCOPE, "invalid current downloads record");
        return;
      }
      const restored = decoded.filter((e) => !seen.has(e.path));
      ledger = [...ledger, ...restored].slice(0, DOWNLOADS_MAX);
      listeners.forEach((fn) => fn());
    })
    : Promise.resolve();
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<{ path: string; name: string }>("download-started", (e) => {
      void ready.then(() => {
        commit(
          mergeDownloadStart(ledger, e.payload.path, e.payload.name, Date.now())
        );
      });
    });
    void listen<{ path: string; success: boolean }>("download-finished", (e) => {
      void ready.then(() => {
        commit(
          mergeDownloadFinish(ledger, e.payload.path, e.payload.success, Date.now())
        );
      });
    });
  });
}

/** Forget one download record (never the file). */
export function removeDownload(path: string, at: number): void {
  commit(ledger.filter((e) => !(e.path === path && e.at === at)));
}

/** Forget every download record (never the files). */
export function clearDownloads(): void {
  ledger = [];
  if (!isFreshRun()) deleteState(DOWNLOADS_SCOPE);
  listeners.forEach((fn) => fn());
}

/** Open a downloaded file inside Tabverse through the same OpenIntent path as
 * OS associations and other product ingress. */
export async function openDownload(path: string): Promise<void> {
  requestPathOpen(path);
}

/** Show the file in the system's file manager. */
export async function revealDownload(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("fs_reveal", { path });
}
