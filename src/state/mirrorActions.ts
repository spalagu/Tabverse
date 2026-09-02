import type { StoreApi } from "zustand";
import {
  isAppMirrorActionName,
  type AppMirrorActionName,
} from "@tabverse/runtime-contracts";
import type { Tab, TabType } from "./store";
import { useStore, type AppStore } from "./store";

export function isTabType(v: unknown): v is TabType {
  return typeof v === "string" && v.length > 0 && v !== "agent";
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number";

/**
 * The store half a mirror needs: read the state, write the state. `useStore`
 * satisfies it structurally, and so does any independent instance built for
 * the two-store comparison (createAppStore), which is the whole point of
 * naming the shape.
 */
export type MirrorStoreApi = Pick<StoreApi<AppStore>, "getState" | "setState">;

/** Where replays land. The app's own store unless a comparison redirected it. */
let mirror: MirrorStoreApi = useStore;

/**
 * Point the mirror at a specific store instance — the determinism tests'
 * move: they build a second store and replay the host's sequence into it.
 */
export function setMirrorStore(s: MirrorStoreApi): void {
  mirror = s;
}

/** Back to the app's own store (every test's teardown). */
export function resetMirrorStore(): void {
  mirror = useStore;
}

/** The store replays land in, for mirrorStore.ts's snapshot landing. */
export function mirrorSetState(patch: Partial<AppStore>): void {
  mirror.setState(patch);
}

/**
 * The actions a joiner may replay: one entry per whitelisted store action,
 * keyed by the exact action name. The HOST side broadcasts exactly these
 * keys too (state/mirrorBroadcast.ts derives its list from here), so one
 * table decides both ends — a name cannot be broadcast but not replayed.
 */
export const MIRROR_ACTIONS: Record<AppMirrorActionName, (args: unknown) => void> = {
  /**
   * The host's id and birth stamp travel in the args (its own addTab
   * generated them); every other field is passed through as-is, so the
   * joiner's row carries what the host's row carries.
   */
  addTab: (args) => {
    if (args === null || typeof args !== "object") return;
    const a = args as Record<string, unknown>;
    if (!isTabType(a.type)) return;
    const partial: Partial<Tab> & { type: TabType } = { type: a.type };
    if (isString(a.id)) partial.id = a.id;
    if (isString(a.title)) partial.title = a.title;
    if (isString(a.cwd)) partial.cwd = a.cwd;
    if (isString(a.url)) partial.url = a.url;
    if (isString(a.groupId)) partial.groupId = a.groupId;
    if (isNumber(a.lastActiveAt)) partial.lastActiveAt = a.lastActiveAt;
    mirror.getState().addTab(partial);
  },
  closeTab: (args) => {
    if (!isString(args)) return;
    mirror.getState().closeTab(args);
  },
  toggleSidebar: () => {
    mirror.getState().toggleSidebar();
  },
  setSidebarPeeking: (args) => {
    if (typeof args !== "boolean") return;
    mirror.getState().setSidebarPeeking(args);
  },
  activateTab: (args) => {
    if (isString(args)) {
      mirror.getState().activateTab(args);
      return;
    }
    if (args === null || typeof args !== "object") return;
    const a = args as Record<string, unknown>;
    if (!isString(a.id)) return;
    if (isNumber(a.now)) mirror.getState().activateTab(a.id, a.now);
    else mirror.getState().activateTab(a.id);
  },
  closeMenu: () => {
    mirror.getState().closeMenu();
  },
  openMenu: (args) => {
    if (args === null || typeof args !== "object") return;
    const a = args as Record<string, unknown>;
    if (!isString(a.tabId) || !isNumber(a.x) || !isNumber(a.y)) return;
    mirror.getState().openMenu(a.tabId, a.x, a.y);
  },
  splitWith: (args) => {
    if (!isString(args)) return;
    mirror.getState().splitWith(args);
  },
  setFilesOpenPath: (args) => {
    // The host's files pane named the file it fronts; the path is the
    // host's own fact (never a locally generated one), so it replays as-is.
    if (args === null || typeof args !== "object") return;
    const a = args as Record<string, unknown>;
    if (!isString(a.tabId)) return;
    if (a.path === null) mirror.getState().setFilesOpenPath(a.tabId, null);
    else if (isString(a.path)) mirror.getState().setFilesOpenPath(a.tabId, a.path);
  },
  unsplit: () => {
    mirror.getState().unsplit();
  },
  renameTab: (args) => {
    if (args === null || typeof args !== "object") return;
    const a = args as Record<string, unknown>;
    if (!isString(a.id) || !isString(a.title)) return;
    mirror.getState().renameTab(a.id, a.title);
  },
  toggleGroupCollapsed: (args) => {
    if (!isString(args)) return;
    mirror.getState().toggleGroupCollapsed(args);
  },
  setFilesOpenDir: (args) => {
    // The host's active pane navigated: the live directory for the joiner's
    // folder view, same contract as setFilesOpenPath.
    if (args === null || typeof args !== "object") return;
    const a = args as Record<string, unknown>;
    if (!isString(a.tabId)) return;
    if (a.dir === null) mirror.getState().setFilesOpenDir(a.tabId, null);
    else if (isString(a.dir)) mirror.getState().setFilesOpenDir(a.tabId, a.dir);
  },
};

/**
 * Replay one host ActionApplied into the mirror. True when the name was
 * whitelisted and ran; false when it was ignored.
 */
export function applyMirrorAction(name: string, args: unknown): boolean {
  if (!isAppMirrorActionName(name)) return false;
  const run = MIRROR_ACTIONS[name];
  run(args);
  return true;
}
