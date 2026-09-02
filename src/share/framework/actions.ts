import { useStore, type ShareViewer } from "../../state/store";
import { shareCapability, type ShareAccess } from "./capability";
import { joinLink } from "./joinLink";
import { mockShareStart } from "../../backend/mock";
import { shareBlockedReason, shareBlockedText } from "./terminalBlocking";

/**
 * The host-side share actions, for any kind of tab. The gate is the
 * capability registry — this file never asks what type a tab is, only what
 * that type declared — and the tab id is the whole address: the core
 * resolves the runtime (and its current grid) through its source registry.
 *
 * In the plain browser (mock backend) there is no core to share through, so
 * each action's demo branch fabricates what the core would have said —
 * clearly marked, and only ever reached when Tauri is absent — so the share
 * dialog's whole surface can be seen and exercised in the demo.
 */

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Ticket join window: new joins are refused after this many seconds; viewers
 * already connected stay connected (invite-link semantics). */
export const SHARE_TTL_SECS = 86_400;

/** What startShare accepts beyond the tab id. Absent fields fall back to the
 * capability's default level and the 24h window. */
export interface StartShareOpts {
  access?: ShareAccess;
  /** Join window in seconds; null keeps the window open until the share is
   * stopped (the core's ttl: None). */
  ttlSecs?: number | null;
}

/** Start sharing a tab; stores the ticket on the tab. `access` is the level
 * new viewers join at — one of the capability's declared levels, defaulting
 * to its declared default. */
export async function startShare(
  tabId: string,
  opts?: StartShareOpts
): Promise<void> {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error("no such tab");
  const cap = shareCapability(tab.type);
  if (!cap.shareable) throw new Error(cap.reason);
  const blocked = shareBlockedReason(tab);
  if (blocked !== null) throw new Error(shareBlockedText(blocked)!);
  if (tab.share) return;
  const level = opts?.access ?? cap.defaultLevel;
  if (!cap.levels.includes(level)) {
    throw new Error(`a ${tab.type} tab cannot be shared at "${level}"`);
  }
  const ttlSecs = opts?.ttlSecs === undefined ? SHARE_TTL_SECS : opts.ttlSecs;
  if (!isTauri) {
    // Browser demo: no core, so fabricate the started share (mock.ts owns
    // the fabrication) instead of refusing — the dialog's shared state is
    // part of what the demo exists to show.
    const fake = mockShareStart(level, cap.levels);
    useStore.getState().setTabShare(tabId, {
      shareId: fake.shareId,
      ticket: fake.ticket,
      joinLink: joinLink(fake.ticket),
      access: level,
      viewers: fake.viewers,
      ttlSecs,
      startedAt: Date.now(),
    });
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const res = await invoke<{ shareId: string; ticket: string }>("share_start", {
    tabId,
    kind: tab.type,
    title: tab.title,
    browserUrl: tab.url,
    ttlSecs,
    access: level,
  });
  useStore.getState().setTabShare(tabId, {
    shareId: res.shareId,
    ticket: res.ticket,
    joinLink: joinLink(res.ticket),
    access: level,
    viewers: [],
    ttlSecs,
    startedAt: Date.now(),
  });
}

/** Change one connected viewer's access level, live. The host core is the
 * authority: the hub re-gates that viewer's input from its very next frame
 * and resends Mode so the viewer's own badge follows. The roster in
 * tab.share.viewers updates through the presence event — the same path as
 * join/leave — rather than optimistically, so the store never shows a level
 * the hub has not actually applied. The gate is the capability registry:
 * a level the tab's type never declared is refused before any command. */
export async function setViewerAccess(
  tabId: string,
  viewerId: number,
  access: ShareAccess
): Promise<void> {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.id === tabId);
  if (!tab?.share) throw new Error("tab is not shared");
  const cap = shareCapability(tab.type);
  if (!cap.shareable || !cap.levels.includes(access)) {
    throw new Error(`a ${tab.type} tab cannot grant "${access}"`);
  }
  if (!isTauri) {
    // Browser demo: no hub, no presence event — write the roster the way
    // the presence listener would have.
    const viewers: ShareViewer[] = tab.share.viewers.map((v) =>
      v.id === viewerId ? { ...v, access } : v
    );
    useStore.getState().setShareViewersByTab(tabId, viewers);
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("share_set_viewer_access", { tabId, viewerId, access });
}

/** Disconnect one viewer; the share keeps running for everyone else. Returns
 * whether the viewer was still connected. */
export async function kickViewer(
  tabId: string,
  viewer: number
): Promise<boolean> {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.id === tabId);
  if (!tab?.share) return false;
  if (!isTauri) {
    // Browser demo: drop the fabricated viewer the way presence would have.
    const had = tab.share.viewers.some((v) => v.id === viewer);
    useStore
      .getState()
      .setShareViewersByTab(
        tabId,
        tab.share.viewers.filter((v) => v.id !== viewer)
      );
    return had;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("share_kick", {
    shareId: tab.share.shareId,
    viewer,
  });
}

export async function stopShare(tabId: string): Promise<void> {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.id === tabId);
  if (!tab?.share) return;
  if (!isTauri) {
    // Browser demo: nothing to tear down beyond the store.
    useStore.getState().setTabShare(tabId, undefined);
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("share_stop", { tabId });
  useStore.getState().setTabShare(tabId, undefined);
}

/** The tab id the whole-app share registers under — the webview's mirror
 * of the Rust APP_SHARE_TAB_ID (share_commands.rs). Fixed, one share per
 * process, and the one address on the shared presence channel that names
 * no tab. */
export const APP_SHARE_TAB_ID = "app";

export const APP_SHARE_LEVELS: readonly ShareAccess[] = ["view", "steer"];

const APP_SHARE_DEFAULT_ACCESS: ShareAccess = "steer";

/** What startAppShare accepts. Absent fields fall back to the app pair's
 * default level and the 24h window — the same shape StartShareOpts gives
 * the tab share, so the app panel's confirm face is the tab dialog's. */
export interface StartAppShareOpts {
  access?: ShareAccess;
  /** Join window in seconds; null keeps the window open until the share is
   * stopped (the core's ttl: None). */
  ttlSecs?: number | null;
}

export async function startAppShare(opts?: StartAppShareOpts): Promise<void> {
  if (useStore.getState().appShare) return;
  const access = opts?.access ?? APP_SHARE_DEFAULT_ACCESS;
  if (!APP_SHARE_LEVELS.includes(access)) {
    throw new Error(`the whole app cannot be shared at "${access}"`);
  }
  const ttlSecs = opts?.ttlSecs === undefined ? SHARE_TTL_SECS : opts.ttlSecs;
  if (!isTauri) {
    // Browser demo: no core, so fabricate the started share — two viewers
    // at distinct levels, like the tab demo — so the panel's whole
    // surface can be seen without a desktop.
    const fake = mockShareStart(access, APP_SHARE_LEVELS);
    useStore.getState().setAppShare({
      shareId: fake.shareId,
      ticket: fake.ticket,
      joinLink: joinLink(fake.ticket),
      access,
      viewers: fake.viewers,
      ttlSecs,
      startedAt: Date.now(),
    });
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const res = await invoke<{ shareId: string; ticket: string }>(
    "app_share_start",
    { ttlSecs, access }
  );
  useStore.getState().setAppShare({
    shareId: res.shareId,
    ticket: res.ticket,
    joinLink: joinLink(res.ticket),
    access,
    viewers: [],
    ttlSecs,
    startedAt: Date.now(),
  });
}

/** Stop the whole-app share. The hub tells every viewer End; here the
 * app-level state simply goes away, panel included. */
export async function stopAppShare(): Promise<void> {
  if (!useStore.getState().appShare) return;
  if (!isTauri) {
    // Browser demo: nothing to tear down beyond the store.
    useStore.getState().setAppShare(null);
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("app_share_stop");
  useStore.getState().setAppShare(null);
}

export function applySharePresence(
  tabId: string,
  viewers: ShareViewer[]
): void {
  const st = useStore.getState();
  if (tabId === APP_SHARE_TAB_ID) st.setAppShareViewers(viewers);
  else st.setShareViewersByTab(tabId, viewers);
}
