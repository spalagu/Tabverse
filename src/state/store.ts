import { create, type StoreApi } from "zustand";
import type { TabType as WorkbenchTabType } from "@tabverse/runtime-contracts";
import { rootGroups } from "@tabverse/workbench/sidebar";
export { rootGroups, subtreeTabs } from "@tabverse/workbench/sidebar";
import { coreLog } from "../errlog";
import {
  SESSION_SCOPE,
  THEME_SCOPE,
  deleteState,
  listScopes,
  loadState,
  loadStateResult,
  saveState,
  scopeTabId,
} from "../persist";
import { errorText } from "../strings/errors";
import { asThemePreference, resolve as resolveTheme } from "../theme/resolve";
import {
  FALLBACK_THEME,
  groupColor as themeGroupColor,
  groupColors,
  type ThemeName,
  type ThemePreference,
} from "../theme/tokens";
import {
  CONFIG_KEYS,
  NO_CONFIG_BACKEND,
  bootConfigSlice,
  configErrorPath,
  configGet,
  configReady,
  configSchema,
  configSetSoon,
  configSlice,
  flushConfigWrites,
  numberRange,
  type ConfigSlice,
  type ConfigSnapshot,
  type ConfigTemplate,
  type ConfigWarning,
  type ConfigWriteError,
  type NumberRange,
  type WriteOutcome,
} from "./config";
import { instantiateTemplate } from "../terminalTemplates";
import { sameValue, settingValues } from "./modifiedSettings";
import {
  findLeaf,
  firstLeaf,
  leaves,
  neighbor,
  paneCount,
  paneTakingOver,
  paneTreeSnapshot,
  readPaneTree,
  removePane,
  resizePane,
  setPaneBoundary,
  splitPane,
  updateLeaf,
  type PaneDir,
  type PaneId,
  type PaneNode,
} from "../paneTree";

export type TabType = WorkbenchTabType;

/** The three access levels a viewer can hold (= backend/types.ts AgentAccess). */
export type ShareAccess = "view" | "steer" | "approve";

/** One connected viewer, from the host presence event. */
export interface ShareViewer {
  id: number;
  /** From the Hello it joined with: "tabverse@host", "Safari (web)", … */
  name: string;
  access: ShareAccess;
}

export interface ShareState {
  shareId: string;
  ticket: string;
  /** JOIN_PAGE_URL + "#" + ticket (share/framework/joinLink.ts builds it). */
  joinLink: string;
  /** The default level: what a NEW viewer joins at. */
  access: ShareAccess;
  /** Connected viewers, real names and current levels; the count is
   * viewers.length. */
  viewers: ShareViewer[];
  /** Ticket join window in seconds; with startedAt, the remaining window.
   * Null means the window never closes (an explicit "no expiry" choice in
   * the dialog — never a silent default). */
  ttlSecs: number | null;
  /** Date.now() at the moment sharing started. */
  startedAt: number;
}

export interface BackgroundTask {
  id: string;
  generation: number;
  cwd: string | null;
  exited: number | null | undefined;
  attached: boolean;
}

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  groupId: string | null;
  cwd?: string;
  url?: string;
  exited?: boolean;
  /** PTY session id (terminal tabs, once the shell is up). */
  termId?: string;
  /** Existing helper session this newly-mounted terminal must attach to. */
  attachSessionId?: string;
  panes?: PaneNode;
  /** Which pane the keyboard is in. Meaningless without `panes`. */
  activePaneId?: PaneId;
  /**
   * The pane temporarily filling the tab (⌘⇧⏎). Deliberately NOT persisted
   * and not part of the tree: zooming changes what is drawn, never the
   * layout, so quitting while zoomed comes back to the layout as built.
   */
  zoomedPaneId?: PaneId;
  /** Active outgoing share (terminal tabs). */
  share?: ShareState;
  /** Ticket we joined with (remote tabs). */
  joinTicket?: string;
  /** Viewer count reported by the host (remote tabs). */
  remoteViewers?: number;
  /** Set when the user renamed the tab; stops auto-titling from overriding it. */
  renamed?: boolean;
  /** Something happened here while the tab was in the background. */
  attention?: boolean;
  /**
   * A file to open the moment this tab mounts (file tabs), with the tab rooted
   * at its folder. Set when the system hands us a document to open: "open this
   * file" has to land on the file, not merely on the folder around it.
   *
   * One-shot by construction — sessionSnapshot does not carry it — so
   * restoring a session reopens the folder and the files the user left open,
   * not the document that happened to start the tab weeks ago.
   */
  openPath?: string;
  /**
   * Where a files tab should jump next (ch. agent tab). Unlike `openPath` this
   * is not one-shot: the agent references the same file repeatedly, and each
   * reference has to land even though the tab is already open and mounted.
   * `nonce` is what makes a repeat observable — the path alone would look
   * unchanged to an effect that already ran for it.
   */
  reveal?: { path: string; line?: number; nonce: number };
  /** A command put in front of the user in a terminal, unexecuted. */
  command?: { text: string; nonce: number };
  /**
   * A command to run once the shell is up (terminal tabs). Set when the system
   * hands us a script to execute or a remote-shell link to follow. One-shot for
   * the same reason as openPath, and more urgently: re-running a command on
   * every restart would be a command the user never asked for.
   */
  runOnStart?: string;
  profile?: string;
  pinnedUrl?: string;
  dormant?: true;
  lastActiveAt?: number;
  busy?: boolean;
  lastOutputAt?: number;
  dirty?: boolean;
  peek?: true;
  /**
   * The tab that was in front when this peek opened. The overlay belongs
   * to that moment: the commit gate drops the peek whenever activation
   * has moved off this tab, whatever moved it — a new tab, a close's
   * neighbor handoff, a folder close, Clear — so no path can front a tab
   * with a stale overlay hanging over it. Peek tabs only; never saved.
   */
  peekOver?: string;
}

export type PeekTarget =
  | { type: "browser"; url: string }
  | { type: "files"; openPath: string };

export interface SplitGroup {
  ids: string[];
  ratios: number[];
  vertical: boolean;
}

export const SPLIT_MAX_PANES = 4;
export const SPLIT_MIN_SHARE = 0.1;

/** Even shares for n panes; the default any time a pane is added or removed. */
const equalRatios = (n: number): number[] =>
  n > 0 ? new Array(n).fill(1 / n) : [];

/**
 * Ratios coerced to a valid distribution for n panes: the right length, all
 * positive, summing to 1. Anything malformed falls back to an even split, so a
 * corrupt session can never make a pane vanish or overflow the axis.
 */
function normalizeRatios(ratios: number[] | undefined, n: number): number[] {
  if (n <= 0) return [];
  const usable =
    ratios !== undefined &&
    ratios.length === n &&
    ratios.every((r) => Number.isFinite(r) && r > 0);
  const raw = usable ? ratios.slice() : equalRatios(n);
  const sum = raw.reduce((a, b) => a + b, 0);
  return sum > 0 ? raw.map((r) => r / sum) : equalRatios(n);
}

export function splittable(t: Tab | undefined): t is Tab {
  return !!t && t.dormant !== true && t.peek !== true;
}

/**
 * The split trimmed to what can actually be shown, or null: members that no
 * longer exist, went dormant, became a peek, or duplicate are dropped in
 * place; a survivor list of fewer than two dissolves the split; a list longer
 * than four is capped. Ratios are re-normalized to the survivors.
 * Returns the SAME object when nothing changed, so the commit gate can tell
 * "still valid" from "adjusted" by identity and not re-patch every commit.
 */
function validSplit(
  group: SplitGroup | null | undefined,
  tabs: Tab[]
): SplitGroup | null {
  if (!group) return null;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of group.ids) {
    if (seen.has(id)) continue;
    if (!splittable(tabs.find((t) => t.id === id))) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= SPLIT_MAX_PANES) break;
  }
  if (ids.length < 2) return null;
  // Keep each survivor's own share (by its original index), then re-normalize.
  const kept = ids.map((id) => group.ratios?.[group.ids.indexOf(id)]);
  const ratios = normalizeRatios(
    kept.every((r) => typeof r === "number") ? (kept as number[]) : undefined,
    ids.length
  );
  const vertical = group.vertical === true;
  const unchanged =
    ids.length === group.ids.length &&
    ids.every((id, i) => id === group.ids[i]) &&
    group.ratios?.length === ratios.length &&
    ratios.every((r, i) => r === group.ratios[i]) &&
    group.vertical === vertical;
  return unchanged ? group : { ids, ratios, vertical };
}

function withInsertedPane(
  group: SplitGroup,
  anchorId: string,
  newId: string,
  side: "left" | "right"
): SplitGroup | null {
  if (group.ids.includes(newId) || group.ids.length >= SPLIT_MAX_PANES) {
    return null;
  }
  const at = group.ids.indexOf(anchorId);
  if (at < 0) return null;
  const pos = side === "left" ? at : at + 1;
  const ids = [...group.ids.slice(0, pos), newId, ...group.ids.slice(pos)];
  return { ids, ratios: equalRatios(ids.length), vertical: group.vertical };
}

export function nextSplitCandidate(
  s: Pick<AppStore, "tabs" | "split">
): string | null {
  const inSplit = new Set(s.split?.ids ?? []);
  const cands = s.tabs.filter(
    (t) => t.groupId === null && !inSplit.has(t.id) && splittable(t)
  );
  if (cands.length === 0) return null;
  cands.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  return cands[0].id;
}

export function splitPartners(
  s: Pick<AppStore, "split" | "activeTabId">
): string[] {
  const g = s.split;
  if (g === null || s.activeTabId === null || !g.ids.includes(s.activeTabId)) {
    return [];
  }
  return g.ids.filter((id) => id !== s.activeTabId);
}

function seatAfterClose(g: SplitGroup, id: string, tabs: Tab[]): string | null {
  const at = g.ids.indexOf(id);
  if (at < 0) return null;
  for (const cand of [g.ids[at + 1], g.ids[at - 1]]) {
    if (cand !== undefined && tabs.some((x) => x.id === cand && x.dormant !== true)) {
      return cand;
    }
  }
  return null;
}

export interface Group {
  id: string;
  name: string;
  colorIndex: number;
  collapsed: boolean;
  parentId?: string;
  preset?: TabType;
  keepWhenEmpty?: true;
}

const PRESET_GROUPS: Array<{ type: TabType; name: string }> = [
  { type: "terminal", name: "Terminals" },
  { type: "files", name: "Files" },
  { type: "browser", name: "Browser" },
];

const presetGroupId = (type: TabType) => `preset-${type}`;

/**
 * Make sure the three preset groups exist and lead the list, keeping any
 * renaming, colour or collapsed state a saved session already carries.
 */
export function withPresetGroups(groups: Group[]): Group[] {
  const presets = PRESET_GROUPS.map(({ type, name }, i) => {
    const existing = groups.find((g) => g.preset === type || g.id === presetGroupId(type));
    return (
      existing ?? {
        id: presetGroupId(type),
        name,
        colorIndex: i % GROUP_PALETTE_SIZE,
        collapsed: false,
        preset: type,
      }
    );
  }).map((g, i) => ({
    ...g,
    // A session saved before presets existed has the group but not the
    // marking; without this it would be deletable and would not attract
    // new tabs.
    preset: PRESET_GROUPS[i].type,
  }));
  const custom = groups.filter((g) => !presets.some((p) => p.id === g.id));
  return [...presets, ...custom];
}

/** Palette slots available to folders. Every theme carries this many —
 *  tokens.schema.json pins the count and packages/workbench/src/theme/tokens.test.ts holds it
 *  across all of them — so which theme it is read from cannot matter, and a
 *  stored slot index survives a switch to a theme that did not exist when
 *  the group was made. */
const GROUP_PALETTE_SIZE = groupColors(FALLBACK_THEME).length;

export function groupColor(g: Pick<Group, "colorIndex">): string {
  return themeGroupColor(useStore.getState().resolvedTheme, g.colorIndex);
}

const LEGACY_PALETTE_THEME: ThemeName = "dark";

function legacyColorIndex(color: string): number {
  const channels = (c: string): [number, number, number] | null => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim());
    return m
      ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
      : null;
  };
  const target = channels(color);
  if (!target) return 0;
  let best = 0;
  let bestDist = Infinity;
  groupColors(LEGACY_PALETTE_THEME).forEach((c, i) => {
    const p = channels(c);
    if (!p) return;
    const d =
      (p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2 + (p[2] - target[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

export type PersistedGroup = Omit<Group, "colorIndex"> & {
  colorIndex?: number;
  color?: string;
};

/** Read-side compatibility only — saved files are rewritten as the current
 *  shape on the next ordinary persist, never migrated in place. Exported
 *  for the app-share mirror, which restores a host snapshot through the
 *  same hydrate → presets → sanitize chain (state/mirrorStore.ts). */
export function hydrateGroup(g: PersistedGroup): Group {
  const { color, colorIndex, ...rest } = g;
  return {
    ...rest,
    colorIndex:
      typeof colorIndex === "number" && Number.isInteger(colorIndex)
        ? ((colorIndex % GROUP_PALETTE_SIZE) + GROUP_PALETTE_SIZE) %
          GROUP_PALETTE_SIZE
        : typeof color === "string"
          ? legacyColorIndex(color)
          : 0,
  };
}

const TYPE_TITLES: Record<TabType, string> = {
  terminal: "Terminal",
  files: "Files",
  browser: "Browser",
  settings: "Settings",
  remote: "Remote",
  agent: "Agent",
};

/** The overlay title for a browser peek: the host, a placeholder until the
 * page's own title arrives through the ordinary title pipeline moments
 * later. */
function peekHostTitle(url: string): string {
  try {
    return new URL(url).host || "Peek";
  } catch {
    return "Peek";
  }
}

function peekFileTitle(path: string): string {
  const base = path.split("/").filter(Boolean).pop();
  return base ?? path;
}

/**
 * Where a new agent tab should work.
 *
 * The menu offers "a coding agent working in a folder" but never asks which
 * one, and falling back to the home directory made the agent's first `glob`
 * walk the entire home tree — minutes of work over files the user never meant
 * to expose. So it inherits the folder the user is already in: the active tab
 * first, then the most recently used one, counting only tabs that stand for a
 * directory. Returns undefined when nothing does, and the caller keeps its own
 * fallback.
 */
export function inheritedCwd(
  tabs: Pick<Tab, "id" | "type" | "cwd" | "lastActiveAt">[],
  activeTabId: string | null,
): string | undefined {
  const rooted = tabs.filter(
    (t) => (t.type === "files" || t.type === "terminal" || t.type === "agent") && t.cwd,
  );
  const active = rooted.find((t) => t.id === activeTabId);
  if (active) return active.cwd;
  return [...rooted].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]?.cwd;
}

let terminalCounter = 0;

/**
 * Keep the terminal-name counter ahead of whichever titles were just
 * restored, so a new terminal is never "Terminal 1" over a live "Terminal
 * 1". Shared by boot restore and the app-share mirror (state/mirrorStore.ts),
 * which both land whole tab lists in one move.
 */
export function advanceTerminalCounter(tabs: { title: string }[]): void {
  terminalCounter = tabs.reduce((max, t) => {
    const m = /^Terminal (\d+)$/.exec(t.title);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
}

export type ArchiveThreshold = "12h" | "24h" | "7d" | "off";

export type SearchEngineId = "duckduckgo" | "google" | "bing" | "custom";

/** The classification of one startup attempt to restore `session.json`. */
export type SessionRestoreResult =
  | "restored"
  | "missing"
  | "read-failed"
  | "invalid-json"
  | "unsupported-version"
  | "invalid-shape"
  | "empty-tabs";

export const ARCHIVE_THRESHOLD_MS: Record<
  Exclude<ArchiveThreshold, "off">,
  number
> = {
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export interface ArchiveEntry {
  id: string;
  type: TabType;
  title: string;
  cwd?: string;
  url?: string;
  archivedAt: number;
}

/**
 * The archive lives in a scope of its own rather than inside the session:
 * it outgrows the session (up to 500 entries) and changes on a schedule of
 * its own, and coupling the two would rewrite the whole tab list every time
 * the scan shelves one page.
 */
export const ARCHIVE_SCOPE = "browser-archive";
const ARCHIVE_LIMIT = 500;

const requestTrafficLightReapply = () => {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  const apply = () => {
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("traffic_light_reapply")
    ).catch(() => {});
  };
  // The first pass keeps the native buttons in place immediately; the later
  // passes cover the webview/title-bar layout settling after the sidebar
  // width transition. This is intentionally tied to the state mutation, so
  // keyboard shortcuts and the button share the same repair path.
  apply();
  window.requestAnimationFrame(apply);
  window.setTimeout(apply, 180);
};

/** What survives a restart. Live handles (PTY ids, shares) never do. */
export interface PersistedState {
  version: 1;
  zones?: 2 | 3;
  tabs: {
    id: string;
    type: TabType;
    title: string;
    groupId: string | null;
    cwd?: string;
    url?: string;
    renamed?: boolean;
    pinnedUrl?: string;
    lastActiveAt?: number;
    panes?: PaneNode;
    dormant?: true;
  }[];
  groups: PersistedGroup[];
  activeTabId: string | null;
  sidebarWidth?: number;
  sidebarPinned?: boolean;
  archiveThreshold?: ArchiveThreshold;
  searchEngine?: SearchEngineId;
  /** The user's own %s template; only read while searchEngine is "custom". */
  customSearchTemplate?: string;
  split?: SplitGroup;
  splitPair?: { leftId: string; rightId: string; ratio: number };
}

/**
 * Is anything drawn on top of the tab content right now?
 *
 * A browser tab's page is a native view stacked over the whole DOM, so it
 * paints over every overlay we draw. Whoever adds the next dialog must not
 * have to remember to teach the browser tab about it: the page reads this one
 * answer and gets out of the way.
 */
export function anyOverlayOpen(s: AppStore): boolean {
  // Drawn across the app, over wherever the page happens to be — these are
  // the ones the page has to make room for.
  const appWide =
    s.newTabMenuOpen ||
    s.joinDialogOpen ||
    s.shareDialogTabId !== null ||
    s.switcherOpen ||
    s.commandBarOpen ||
    s.shortcutsHelpOpen ||
    s.authRequest !== null ||
    s.pageDialog !== null ||
    s.unloadConfirm !== null ||
    s.userscriptAsk !== null ||
    s.archiveOpen ||
    s.historyOpen ||
    s.downloadsOpen ||
    s.appSharePanelOpen;
  return appWide;
}

export interface PageDialog {
  dialogId: number;
  kind:
    | "alert"
    | "confirm"
    | "prompt"
    | "camera"
    | "microphone"
    | "camera and microphone"
    | "notifications";
  origin: string;
  message: string;
  defaultText: string;
}

/** An HTTP auth challenge waiting for the user's username and password. */
export interface AuthRequest {
  challengeId: number;
  host: string;
  realm: string;
  failedUsername?: string | null;
}

export interface AppStore {
  tabs: Tab[];
  groups: Group[];
  activeTabId: string | null;
  newTabMenuOpen: boolean;
  joinDialogOpen: boolean;
  shareDialogTabId: string | null;
  appShare: ShareState | null;
  appSharePanelOpen: boolean;
  switcherOpen: boolean;
  commandBarOpen: boolean;
  shortcutsHelpOpen: boolean;
  /** Tab id whose context menu is open, plus where to draw it. */
  menu: { tabId: string; x: number; y: number } | null;
  sidebarMenu: { x: number; y: number; zone: "pinned" | "today" } | null;
  groupMenu: { groupId: string; x: number; y: number } | null;
  folderPreviewGroupId: string | null;
  setFolderPreview: (groupId: string | null) => void;
  folderPreviewPendingGroupId: string | null;
  setFolderPreviewPending: (groupId: string | null) => void;
  pageFreeze: { tabId: string; src: string } | null;
  setPageFreeze: (freeze: { tabId: string; src: string } | null) => void;
  /** A group just created and not yet named, so its header opens ready to type. */
  namingGroupId: string | null;
  renamingTabId: string | null;
  passwordsOpen: boolean;
  fileClipboard: { path: string; paths?: string[]; cut: boolean } | null;
  draggingFilePaths: string[];
  setDraggingFilePaths: (paths: string[]) => void;
  selectedTabIds: string[];
  /** Where a range selection counts from — the last row picked on its own. */
  selectionAnchor: string | null;
  authRequest: AuthRequest | null;
  pageDialog: PageDialog | null;
  unloadConfirm: { tabId: string; title: string } | null;
  userscriptAsk: {
    askId: number;
    scriptId: string;
    scriptName: string;
    host: string;
  } | null;
  scriptCommands: Record<
    string,
    Array<{ scriptId: string; cmdId: number; name: string }>
  >;
  audibleTabs: Record<string, boolean>;
  mutedTabs: Record<string, boolean>;
  archive: ArchiveEntry[];
  archiveEvicted: number;
  /** The archive panel is open. */
  archiveOpen: boolean;
  historyOpen: boolean;
  downloadsOpen: boolean;
  /** Helper-owned sessions, refreshed from the helper rather than persisted here. */
  backgroundTasks: BackgroundTask[];
  /** How long a today tab may idle before the scan shelves it. */
  archiveThreshold: ArchiveThreshold | null;
  themePreference: ThemePreference | null;
  /** Latest matchMedia("(prefers-color-scheme: dark)") answer. */
  systemDark: boolean;
  resolvedTheme: ThemeName;
  setThemePreference: (p: ThemePreference) => void;
  onSystemTheme: (dark: boolean) => void;
  searchEngine: SearchEngineId | null;
  /**
   * The user's own search template, kept even while a built-in engine is
   * selected so switching back to "custom" finds it again. Never logged:
   * a search URL is user data (see src/search.ts).
   */
  customSearchTemplate: string | null;
  initConfig: () => Promise<void>;
  configError: string | null;
  configWriteErrors: ConfigWriteError[];
  /** Keys the file names that the registry does not know, with their lines. */
  configWarnings: ConfigWarning[];
  /** The unknown-key banner has been closed for this run. */
  configWarningsDismissed: boolean;
  /** Which file to open from a banner, when one can be named. */
  configPath: string | null;
  /**
   * The width the registry allows the sidebar, read off `config_schema`.
   * Null until the schema has arrived — and the drag then clamps to nothing
   * rather than to remembered bounds, which would be a copy of
   * SIDEBAR_WIDTH_MIN/MAX with the same power to go stale as a default.
   */
  sidebarWidthRange: NumberRange | null;
  /** Close the unknown-key banner (the error banner has no such action). */
  dismissConfigWarnings: () => void;
  /**
   * Close the failed-save banner. Unlike the load error — which describes a
   * file that is still broken — this one describes something that already
   * happened and has already been undone, so the user is allowed to say they
   * have read it.
   */
  dismissConfigWriteErrors: () => void;
  split: SplitGroup | null;
  /**
   * The split divider is being dragged right now. While it is, both panes'
   * webviews park: a native child view swallows pointer events the moment
   * the pointer crosses onto it, so a live-resizing drag would stall the
   * instant it left the divider strip. Parking hands the whole surface
   * back to the DOM for the drag's duration; release restores both pages
   * at the new ratio. Never persisted — it is about this pointer, now.
   */
  splitDragging: boolean;
  peekTabId: string | null;
  contentDrag: {
    id: string;
    side: "left" | "right" | null;
    index?: number | null;
  } | null;
  paneHoverTabId: string | null;
  setPaneHover: (id: string | null) => void;
  draggingTabIds: string[];
  setDraggingTabs: (ids: string[]) => void;
  setContentDrag: (
    v: {
      id: string;
      side: "left" | "right" | null;
      index?: number | null;
    } | null
  ) => void;

  splitWith: (id: string) => boolean;
  splitDrop: (id: string, side: "left" | "right") => boolean;
  splitDropAt: (id: string, index: number) => boolean;
  splitOnTab: (draggedId: string, targetId: string, side: "left" | "right") => boolean;
  addSplitPane: (side: "left" | "right") => boolean;
  /** Dissolve the split; every member stays a tab, the active one stays active. */
  unsplit: () => void;
  moveSplitPane: (id: string, delta: -1 | 1) => void;
  separateFromSplit: (id: string) => void;
  toggleSplitOrientation: () => void;
  setSplitRatio: (dividerIndex: number, position: number, final?: boolean) => void;
  setSplitDragging: (on: boolean) => void;

  splitTerminalPane: (
    tabId: string,
    vertical: boolean,
    cwd?: string
  ) => PaneId | null;
  /** Move the focus one pane that way — geometric, never by tree shape. */
  focusPaneDir: (tabId: string, dir: PaneDir) => void;
  /** Put the focus in a named pane (a click, or a survivor after a close). */
  focusPane: (tabId: string, paneId: PaneId) => void;
  /** ⌘⇧⏎: the focused pane fills the tab, or gives the others their room back. */
  togglePaneZoom: (tabId: string) => void;
  /** ⌃⌘ arrow: move the seam the focused pane leans against that way. */
  resizePaneDir: (tabId: string, dir: PaneDir) => void;
  /** A dragged divider: boundary `index` of one split node, 0–1 within it. */
  setPaneRatio: (
    tabId: string,
    splitId: PaneId,
    index: number,
    position: number,
    final?: boolean
  ) => void;
  removeTerminalPane: (tabId: string, paneId: PaneId) => void;
  /** One pane's live PTY id, the per-pane form of setTabTermId. */
  setPaneTermId: (tabId: string, paneId: PaneId, termId: string) => void;
  /** One pane's directory, the per-pane form of setTabCwd. */
  setPaneCwd: (tabId: string, paneId: PaneId, cwd: string) => void;
  toggleBroadcast: (tabId: string) => { on: boolean; refused?: "sharing" };
  /** Whether a tab is broadcasting — the one read the four amber layers do. */
  isBroadcasting: (tabId: string) => boolean;
  openTemplateTab: (template: ConfigTemplate) => string;
  saveTemplateFor: string | null;
  broadcastTabs: Record<string, true>;
  remoteTabs: Record<string, { host?: string }>;
  /**
   * Which panes of which terminal tabs are running a command, by pane id —
   * the per-pane truth `tab.busy` is aggregated from. Same rule as
   * broadcastTabs: store state, never a Tab field, never persisted. Without
   * it, every pane of a split writing the tab-level flag would let an idle
   * pane's `false` overwrite a sibling's running `true`, and closing the tab
   * would kill a live shell without asking.
   */
  busyPanes: Record<string, Record<string, true>>;
  /** Record one pane's running state; the tab's `busy` follows the union. */
  setPaneBusy: (id: string, paneId: PaneId, busy: boolean) => void;
  /** Enter/clear one tab's remote state; a no-op when nothing changed. */
  setTabRemote: (id: string, remote: { host: string } | null) => void;
  setSaveTemplateFor: (tabId: string | null) => void;

  openPeek: (target: PeekTarget) => string;
  discardPeek: () => void;
  promotePeek: () => string | null;
  splitPeek: () => string | null;

  addTab: (partial: Partial<Tab> & { type: TabType }) => string;
  /**
   * Bring `path` up in a files tab: reuse the one already rooted above it,
   * waking it if it was shelved, and only open a new tab when none fits.
   * This is what a tool call's location resolves to when the user clicks it.
   */
  revealPath: (path: string, line?: number) => string;
  setTabReveal: (
    tabId: string,
    reveal: { path: string; line?: number; nonce: number }
  ) => void;
  showCommand: (text: string, cwd?: string) => void;
  closeTab: (id: string) => void;
  closeTabs: (
    ids: string[],
    askFinal?: (tab: Tab) => Promise<boolean>
  ) => Promise<void>;
  archiveTabs: (
    ids: string[],
    now?: number
  ) => { archived: number; skipped: string[] };
  activateTab: (id: string, now?: number) => void;
  activateIndex: (i: number) => void;
  cycleTab: (delta: number) => void;
  moveTab: (id: string, beforeId: string | null) => void;
  setTabTitle: (id: string, title: string) => void;
  renameTab: (id: string, title: string) => void;
  markTabExited: (id: string) => void;
  setAttention: (id: string, on: boolean) => void;
  setTabBusy: (id: string, busy: boolean) => void;
  setTabOutputAt: (id: string, at: number) => void;
  setTabDirty: (id: string, dirty: boolean) => void;

  filesOpenPath: Record<string, string>;
  setFilesOpenPath: (tabId: string, path: string | null) => void;
  /**
   * The directory the files tab's ACTIVE pane is browsing, by tab id —
   * `tab.cwd` is only the spawn-time hint (undefined for a hand-made tab,
   * never updated as the pane navigates), while the pane's root is the
   * live fact. Same transient contract as filesOpenPath.
   */
  filesOpenDir: Record<string, string>;
  setFilesOpenDir: (tabId: string, dir: string | null) => void;

  /** Another tab of the same work: same place, never the same process. */
  duplicateTab: (id: string) => string | null;
  reopenClosedTab: (at?: number) => string | null;
  /** How many closed tabs are waiting to be reopened. */
  closedCount: number;
  recentlyClosed: () => ReadonlyArray<ClosedEntry>;

  sidebarWidth: number | null;
  /**
   * Pinned means the sidebar holds a column of its own and the tab sits
   * beside it. Unpinned it slides away and returns as an overlay when the
   * pointer reaches the window's left edge — the arrangement Arc uses, and
   * the reason this is a mode rather than a visibility flag.
   */
  sidebarPinned: boolean | null;
  /** Unpinned and currently slid back in because the pointer is on it. */
  sidebarPeeking: boolean;
  setSidebarPeeking: (on: boolean) => void;
  setSidebarWidth: (px: number) => void;
  toggleSidebar: () => void;

  createGroup: (name: string, tabId?: string) => string;
  createEmptyGroup: (parentId?: string) => string;
  setNamingGroup: (id: string | null) => void;
  setRenamingTab: (id: string | null) => void;
  setPasswordsOpen: (on: boolean) => void;
  setFileClipboard: (
    entry: { path: string; paths?: string[]; cut: boolean } | null
  ) => void;
  toggleSelected: (id: string) => void;
  extendSelectionTo: (id: string) => void;
  clearSelection: () => void;
  /** Move several tabs at once, keeping the order they had between them. */
  moveTabs: (ids: string[], beforeId: string | null) => void;
  renameGroup: (id: string, name: string) => void;
  /** Move a folder to another palette slot (the index, not a color value). */
  setGroupColor: (id: string, colorIndex: number) => void;
  toggleGroupCollapsed: (id: string) => void;
  assignToGroup: (tabId: string, groupId: string | null) => void;
  closeGroup: (groupId: string) => void;
  deleteGroup: (groupId: string) => void;
  dissolveGroup: (groupId: string) => void;
  setGroupParent: (id: string, parentId: string | null) => boolean;
  /** Order a group right before another, adopting that group's level. */
  moveGroupBefore: (id: string, beforeId: string) => boolean;

  pinTab: (id: string) => void;

  setArchiveThreshold: (threshold: ArchiveThreshold) => void;
  setArchiveOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
  setDownloadsOpen: (open: boolean) => void;
  setBackgroundTasks: (tasks: BackgroundTask[]) => void;
  attachBackgroundTask: (task: BackgroundTask) => string;
  /**
   * Shelve today-zone tabs of every kind that idled past the threshold
   * `now` is injectable so unit tests need not wait a day.
   */
  runArchiveScan: (now?: number) => void;
  archiveAllToday: (now?: number) => void;
  /** Load the archive from its own scope; called once at boot. */
  restoreArchive: () => Promise<void>;
  unarchiveEntry: (index: number) => string | null;
  removeArchiveEntry: (index: number) => void;
  clearArchive: () => void;

  setNewTabMenu: (open: boolean) => void;
  setJoinDialog: (open: boolean) => void;
  setShareDialogTab: (tabId: string | null) => void;
  setSwitcher: (open: boolean) => void;
  setCommandBar: (open: boolean) => void;
  setShortcutsHelp: (open: boolean) => void;
  setSearchEngine: (engine: SearchEngineId, template?: string) => void;
  setAuthRequest: (req: AuthRequest | null) => void;
  setPageDialog: (dialog: PageDialog | null) => void;
  setUnloadConfirm: (req: { tabId: string; title: string } | null) => void;
  setUserscriptAsk: (
    ask: {
      askId: number;
      scriptId: string;
      scriptName: string;
      host: string;
    } | null
  ) => void;
  addScriptCommand: (
    tabId: string,
    cmd: { scriptId: string; cmdId: number; name: string }
  ) => void;
  /** A tab's document changed: drop the menu commands it had. */
  clearScriptCommands: (tabId: string) => void;
  setTabAudible: (tabId: string, audible: boolean) => void;
  setTabMuted: (tabId: string, muted: boolean) => void;
  openMenu: (tabId: string, x: number, y: number) => void;
  closeMenu: () => void;
  openSidebarMenu: (x: number, y: number, zone?: "pinned" | "today") => void;
  closeSidebarMenu: () => void;
  openGroupMenu: (groupId: string, x: number, y: number) => void;
  closeGroupMenu: () => void;

  setTabTermId: (id: string, termId: string) => void;
  setTabCwd: (id: string, cwd: string) => void;
  setTabUrl: (id: string, url: string) => void;
  setTabShare: (id: string, share: ShareState | undefined) => void;
  setShareViewersByTab: (tabId: string, viewers: ShareViewer[]) => void;
  setAppShare: (share: ShareState | null) => void;
  setAppShareViewers: (viewers: ShareViewer[]) => void;
  setAppSharePanel: (open: boolean) => void;
  setRemoteViewers: (id: string, viewers: number) => void;

  /** Most recent session restore outcome; runtime-only, never persisted. */
  sessionRestoreResult: SessionRestoreResult | null;
  restoreSession: () => Promise<boolean>;
}

/**
 * The two halves zustand hands a store: how to write and how to read.
 * Named so `createAppStore` — the factory that lets a second, independent
 * store be built for the app-share determinism comparison — can take them
 * as plain parameters instead of growing a dependency on zustand's
 * internal callback shapes.
 */
type StoreSetter = StoreApi<AppStore>["setState"];
type StoreGetter = StoreApi<AppStore>["getState"];

/**
 * A fresh (test) run must leave no trace: it neither restores the saved
 * session nor overwrites it, and it deletes nothing durable. Flipped once at
 * startup, before any commit runs.
 */
let freshRun = false;
export function markFreshRun() {
  freshRun = true;
}
/**
 * Whether this run is a zero-trace one, for modules outside this file that
 * keep durable state of their own (history, downloads) and owe the same
 * discipline: inherit nothing, write nothing, delete nothing durable.
 */
export function isFreshRun(): boolean {
  return freshRun;
}

function dropTabState(ids: string[]) {
  if (freshRun || ids.length === 0) return;
  const dead = new Set(ids);
  void listScopes().then((scopes) => {
    for (const scope of scopes) {
      const owner = scopeTabId(scope);
      if (owner !== null && dead.has(owner)) deleteState(scope);
    }
  });
}

const CLOSED_LIMIT = 10;
let closedTabs: Array<{ tab: Tab; index: number; closedAt: number }> = [];

export interface ClosedEntry {
  tab: Tab;
  /** Where the tab sat when it closed; reopen puts it back there. */
  index: number;
  /** When it closed (the moment rememberClosed ran): the "3m ago" the
   *  command bar's row shows next to the title. */
  closedAt: number;
}

function rememberClosed(tab: Tab, index: number) {
  // A remote tab is someone else's session joined by ticket, and a settings
  // tab is a singleton the app reopens on demand — neither is work to
  // restore, so neither is kept.
  if (tab.type === "remote" || tab.type === "settings") {
    dropTabState([tab.id]);
    return;
  }
  closedTabs = [{ tab, index, closedAt: Date.now() }, ...closedTabs];
  const evicted = closedTabs.slice(CLOSED_LIMIT);
  closedTabs = closedTabs.slice(0, CLOSED_LIMIT);
  if (evicted.length > 0) dropTabState(evicted.map((e) => e.tab.id));
}

export async function sweepOrphanTabState(): Promise<void> {
  if (freshRun) return; // must not eat the real session's files
  const live = new Set(useStore.getState().tabs.map((t) => t.id));
  for (const e of useStore.getState().archive) live.add(e.id);
  const shelved = await loadState<ArchiveEntry[]>(ARCHIVE_SCOPE);
  if (Array.isArray(shelved)) {
    for (const e of shelved) {
      if (e && typeof e.id === "string") live.add(e.id);
    }
  }
  for (const scope of await listScopes()) {
    const owner = scopeTabId(scope);
    if (owner !== null && !live.has(owner)) deleteState(scope);
  }
}

/**
 * Exactly what a session becomes on disk. Split out from the write so it
 * can be asserted on directly — a test that went through the file would be
 * testing the disk instead.
 */
export function sessionSnapshot(state: AppStore): PersistedState {
  const savedTabs = state.tabs
    .filter((t) => t.type !== "remote" && t.peek !== true)
    .map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      groupId: t.groupId,
      cwd: t.cwd,
      url: t.url,
      renamed: t.renamed,
      pinnedUrl: t.pinnedUrl,
      lastActiveAt: t.lastActiveAt,
      panes: t.panes ? paneTreeSnapshot(t.panes) : undefined,
      // Manual sleep persists (requirement change 2026-08-21): a restart
      // must not wake what the user closed, nor sleep what they left open.
      ...(t.dormant === true ? { dormant: true as const } : {}),
      // The zoom is deliberately absent as well: it is a way of looking at
      // the layout, never part of it.
      // openPath and runOnStart are deliberately absent: both describe a
      // one-time instruction from the system, and carrying them across a
      // restart would reopen a document or re-run a command nobody asked for.
    }));
  return {
    version: 1,
    zones: 3,
    tabs: savedTabs,
    groups: state.groups.filter((g) =>
      subtreeEarnsItsKeep(state.groups, savedTabs, g.id)
    ),
    activeTabId: state.activeTabId,
    // Valid by construction: every commit re-validates the split, and a
    // peek tab can never be a member of it.
    split: state.split ?? undefined,
  };
}

function persist(state: AppStore) {
  // A session the user chose to preserve after recovery failed must remain
  // untouched even if a late startup event or a UI action tries to add a tab.
  // App.tsx changes this marker to `missing` only after the explicit
  // replacement choice, immediately before it initializes the new session.
  if (
    freshRun ||
    (state.sessionRestoreResult !== null &&
      state.sessionRestoreResult !== "restored" &&
      state.sessionRestoreResult !== "missing")
  ) {
    return;
  }
  saveState(SESSION_SCOPE, sessionSnapshot(state));
}

/** The archive's own write, honouring the same zero-trace rule as persist. */
function saveArchive(entries: ArchiveEntry[]) {
  if (freshRun) return;
  saveState(ARCHIVE_SCOPE, entries);
}

function persistThemePreference(pref: ThemePreference): void {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("theme_pref_save", { pref }))
      .catch((e) => coreLog("error", `theme_pref_save failed: ${String(e)}`));
  } else if (!freshRun) {
    saveState(THEME_SCOPE, { preference: pref });
  }
}

function writeSetting(key: string, value: unknown, previous: unknown): void {
  if (freshRun) return;
  configSetSoon(key, value, (o) => writeEnded(o, previous));
}

/**
 * The store field each configuration key stands for — `settingValues` seen
 * from the write side, and the one thing a rollback needs that reading the
 * slice cannot give it.
 *
 * Typed by the key table rather than by `string`, so a setting added to
 * CONFIG_KEYS and forgotten here fails to compile instead of quietly becoming
 * the one setting a failed save cannot put back.
 */
const CONFIG_FIELDS: Record<
  (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS],
  keyof ConfigSlice
> = {
  [CONFIG_KEYS.theme]: "themePreference",
  [CONFIG_KEYS.sidebarWidth]: "sidebarWidth",
  [CONFIG_KEYS.sidebarPinned]: "sidebarPinned",
  [CONFIG_KEYS.searchEngine]: "searchEngine",
  [CONFIG_KEYS.customSearchTemplate]: "customSearchTemplate",
  [CONFIG_KEYS.archiveAfter]: "archiveThreshold",
};

/**
 * The failed-write list with one more failure on it. One entry per key,
 * newest last: a setting that fails twice is one problem, and the second
 * reason is the current one.
 */
function withWriteError(
  list: readonly ConfigWriteError[],
  key: string,
  error: unknown
): ConfigWriteError[] {
  return [...list.filter((w) => w.key !== key), { key, error: errorText(error) }];
}

export function recordConfigWrite(key: string, error: unknown | null): void {
  useStore.setState((s) => ({
    configWriteErrors:
      error === null
        ? s.configWriteErrors.filter((w) => w.key !== key)
        : withWriteError(s.configWriteErrors, key, error),
  }));
}

function writeEnded(o: WriteOutcome, previous: unknown): void {
  if (o.ok) {
    useStore.setState((s) =>
      s.configWriteErrors.some((w) => w.key === o.key)
        ? {
            configWriteErrors: s.configWriteErrors.filter(
              (w) => w.key !== o.key
            ),
          }
        : {}
    );
    return;
  }
  const s = useStore.getState();
  // Widened at the lookup because the key arrives as a string: the strict
  // type above is what makes the table exhaustive, not a promise that every
  // string is in it.
  const field = (CONFIG_FIELDS as Record<string, keyof ConfigSlice | undefined>)[
    o.key
  ];
  const patch: Record<string, unknown> = {
    configWriteErrors: withWriteError(s.configWriteErrors, o.key, o.error),
  };
  if (
    field !== undefined &&
    sameValue(settingValues(storeSlice(s))[o.key], o.value)
  ) {
    // `previous` may be null — "the file had not been read when this was
    // changed" — and null is what goes back, because the alternative is
    // inventing a value for a setting whose value nobody knows. The two
    // sidebar fields are the exception the layout floor owns: putting null
    // back collapses the grid and the toggle (see initConfig), so they fall
    // to the working values instead — visibly usable, honestly reported in
    // the banner, overwritten the moment the file is fixed.
    if (field === "sidebarPinned") {
      patch[field] = previous === null ? true : previous;
    } else if (field === "sidebarWidth") {
      patch[field] = previous === null ? 248 : previous;
    } else {
      patch[field] = previous;
    }
    if (field === "themePreference") {
      // The one setting with a consequence past itself: everything on screen
      // subscribes to resolvedTheme, so a preference put back without being
      // re-resolved is a rollback nobody can see. The cold-start snapshot
      // goes back with it, or the next launch paints a colour the file was
      // never able to record.
      const pref = previous as ThemePreference | null;
      Object.assign(patch, themeFanOut(pref, s.systemDark));
      if (pref !== null) persistThemePreference(pref);
    }
  }
  useStore.setState(patch as Partial<AppStore>);
}

/** The six fields, as the file spells them, from the store's own names. */
function settingWrites(slice: Partial<ConfigSlice>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  if (slice.themePreference !== undefined)
    out.push([CONFIG_KEYS.theme, slice.themePreference]);
  if (slice.sidebarWidth !== undefined)
    out.push([CONFIG_KEYS.sidebarWidth, slice.sidebarWidth]);
  if (slice.sidebarPinned !== undefined)
    out.push([CONFIG_KEYS.sidebarPinned, slice.sidebarPinned]);
  if (slice.searchEngine !== undefined)
    out.push([CONFIG_KEYS.searchEngine, slice.searchEngine]);
  if (slice.customSearchTemplate !== undefined)
    out.push([CONFIG_KEYS.customSearchTemplate, slice.customSearchTemplate]);
  if (slice.archiveThreshold !== undefined)
    out.push([CONFIG_KEYS.archiveAfter, slice.archiveThreshold]);
  return out;
}

/**
 * The legacy-settings migration rewrites session.json, so it may only touch
 * a payload that startup can actually restore. A parseable-but-invalid file
 * belongs to the recovery decision instead of to this migration.
 */
function isRecoverableSessionPayload(
  value: unknown
): value is Record<string, unknown> & PersistedState {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { tabs?: unknown }).tabs) &&
    (value as { tabs: unknown[] }).tabs.length > 0
  );
}

/**
 * A width inside the registry's bounds. With no bounds yet there is nothing
 * to clamp to: the value stands, and the write that follows it is validated
 * by the same rule on the way into the file.
 */
function clampWidth(px: number, range: NumberRange | null): number {
  return range === null ? px : Math.max(range.min, Math.min(range.max, px));
}

/**
 * Whether the six settings have arrived. False only before the file has been
 * read — which on the desktop is over before the first paint, the core
 * having injected the values — and while a file that failed to load leaves
 * the interface with nothing to show. The settings page reads this to
 * refuse edits: writing a setting whose current value is unknown would be
 * choosing a value on the user's behalf.
 */
export function settingsReady(s: AppStore): boolean {
  return configReady(storeSlice(s));
}

/**
 * The six settings as they stand in the store — the store's own names on one
 * side of the same mapping `configSlice` sits on the other side of. Written
 * once here because two readers need it and would otherwise each list the six
 * fields, which is how a seventh setting ends up in one list and not the
 * other.
 */
export function storeSlice(s: Pick<AppStore, keyof ConfigSlice>): ConfigSlice {
  return {
    themePreference: s.themePreference,
    sidebarWidth: s.sidebarWidth,
    sidebarPinned: s.sidebarPinned,
    searchEngine: s.searchEngine,
    customSearchTemplate: s.customSearchTemplate,
    archiveThreshold: s.archiveThreshold,
  };
}

export function forgetSessionScopes(all: readonly string[]): string[] {
  return all.filter((scope) => scope !== THEME_SCOPE);
}

async function migrateSettingsIntoConfig(
  snap: ConfigSnapshot
): Promise<Partial<ConfigSlice>> {
  if (freshRun || snap.sources.length > 0) return {};
  const current = configSlice(snap.values);
  const moved: Partial<ConfigSlice> = {};

  const loaded = await loadStateResult<Record<string, unknown>>(SESSION_SCOPE);
  const stored =
    loaded.kind === "value" && isRecoverableSessionPayload(loaded.value)
      ? loaded.value
      : null;
  if (stored !== null) {
    const width = stored.sidebarWidth;
    if (typeof width === "number" && width !== current.sidebarWidth) {
      moved.sidebarWidth = width;
    }
    const pinned = stored.sidebarPinned;
    if (typeof pinned === "boolean" && pinned !== current.sidebarPinned) {
      moved.sidebarPinned = pinned;
    }
    const threshold = stored.archiveThreshold;
    if (
      typeof threshold === "string" &&
      threshold !== current.archiveThreshold
    ) {
      moved.archiveThreshold = threshold as ArchiveThreshold;
    }
    const engine = stored.searchEngine;
    if (typeof engine === "string" && engine !== current.searchEngine) {
      moved.searchEngine = engine as SearchEngineId;
    }
    const template = stored.customSearchTemplate;
    if (
      typeof template === "string" &&
      template !== current.customSearchTemplate
    ) {
      moved.customSearchTemplate = template;
    }
  }

  // The theme came from a scope of its own rather than the session blob, so
  // its old value is read from there.
  const themeScope = await loadState<{ preference?: unknown }>(THEME_SCOPE);
  if (themeScope !== null && themeScope.preference !== undefined) {
    const pref = asThemePreference(themeScope.preference);
    if (pref !== current.themePreference) moved.themePreference = pref;
  }

  const writes = settingWrites(moved);
  // What the file already says is what a failed move would leave standing —
  // the store is still on those values here, `moved` not having been applied
  // yet. So the rollback these carry is a no-op by construction (the guard in
  // writeEnded sees a store that never held the moved value), and what a
  // failure actually produces is the banner, which is the whole of what a
  // migration that could not write should produce.
  const before = settingValues(current);
  for (const [key, value] of writes) writeSetting(key, value, before[key]);
  if (writes.length > 0) await flushConfigWrites();

  // Step 1's second half: the five fields leave the session snapshot. Done
  // even when nothing moved, so a session carrying default-valued copies
  // stops carrying them too.
  if (stored !== null) {
    const pruned = { ...stored };
    let changed = false;
    for (const field of [
      "sidebarWidth",
      "sidebarPinned",
      "archiveThreshold",
      "searchEngine",
      "customSearchTemplate",
    ]) {
      if (field in pruned) {
        delete pruned[field];
        changed = true;
      }
    }
    if (changed) saveState(SESSION_SCOPE, pruned);
  }
  return moved;
}

/**
 * The theme's derived value, recomputed — or left exactly as it is while the
 * preference has not been read. Never a substitute preference: resolving a
 * theme nobody asked for would repaint the window on a guess.
 */
function themeFanOut(
  pref: ThemePreference | null,
  systemDark: boolean
): { resolvedTheme: ThemeName } | Record<string, never> {
  return pref === null ? {} : { resolvedTheme: resolveTheme(pref, systemDark) };
}

function promoteTab(t: Tab, groupId: string): Tab {
  if (t.type === "browser" && t.url !== undefined && t.pinnedUrl === undefined) {
    return { ...t, groupId, pinnedUrl: t.url };
  }
  return { ...t, groupId };
}

function demoteTab(t: Tab): Tab {
  return {
    ...t,
    groupId: null,
    pinnedUrl: undefined,
    dormant: undefined,
  };
}

/**
 * The three pane fields as one patch, so that "this tab has a layout" and
 * "this tab has a focused pane" can never be set apart from each other. A
 * null tree clears all three, which is the shape a tab has before its first
 * ⌘D and the shape it must return to. Exported for the app-share mirror,
 * which maps a host snapshot's tabs through the same patch.
 */
export function paneFields(
  panes: PaneNode | null
): Pick<Tab, "panes" | "activePaneId" | "zoomedPaneId"> {
  if (panes === null) {
    return { panes: undefined, activePaneId: undefined, zoomedPaneId: undefined };
  }
  return {
    panes,
    activePaneId: firstLeaf(panes),
    // Never restored, never inherited: the zoom is not part of a layout.
    zoomedPaneId: undefined,
  };
}

function sleepTab(t: Tab): Tab {
  return {
    ...t,
    dormant: true,
    url: t.type === "browser" && t.pinnedUrl !== undefined ? t.pinnedUrl : t.url,
    termId: undefined,
    ...(t.panes ? paneFields(paneTreeSnapshot(t.panes)) : {}),
    exited: undefined,
    busy: undefined,
    lastOutputAt: undefined,
    dirty: undefined,
    share: undefined,
    attention: undefined,
  };
}


/** Is `path` inside `root`? Both are absolute; a trailing slash must not fool it. */
function isUnder(path: string, root: string | undefined): boolean {
  if (!root) return false;
  const base = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(base);
}

/** The directory holding `path`, for rooting a fresh files tab at it. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "/";
}

/** Materialize a dormant item; the pane mounting is what starts the runtime. */
function wakeTab(t: Tab): Tab {
  return t.dormant === true ? { ...t, dormant: undefined } : t;
}

export function archivableByState(t: Tab): boolean {
  if (t.peek === true) return false;
  switch (t.type) {
    case "settings":
    case "remote":
      return false;
    case "browser":
      return t.url !== undefined;
    case "terminal":
      return t.exited === true || t.busy !== true;
    case "files":
      return t.dirty !== true;
    // An agent tab follows the terminal's rule for the same reason: the pane is
    // the runtime, so shelving one mid-run kills the work. The scan therefore
    // leaves a running one alone. A user who closes it anyway does get their
    // way — that path unmounts the pane, which cancels the turn and releases
    // any approval waiting on them, and the session log is what the tab reads
    // back when it is woken.
    case "agent":
      return t.busy !== true;
  }
}

function archiveEntryOf(t: Tab, now: number): ArchiveEntry {
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    cwd: t.cwd,
    url: t.url,
    archivedAt: now,
  };
}

function evictBeyondLimit(
  archive: ArchiveEntry[]
): { kept: ArchiveEntry[]; evicted: number } {
  if (archive.length <= ARCHIVE_LIMIT) return { kept: archive, evicted: 0 };
  const evictedCount = archive.length - ARCHIVE_LIMIT;
  const evicted = archive.slice(0, evictedCount);
  dropTabState(evicted.map((e) => e.id).filter((id) => typeof id === "string"));
  return { kept: archive.slice(-ARCHIVE_LIMIT), evicted: evictedCount };
}

export function createAppStore(set: StoreSetter, get: StoreGetter): AppStore {
  // Peek tabs the commit gate below dropped; their state files are
  // reclaimed right after the set() — a side effect has no place inside
  // the updater, and dropTabState only schedules async work anyway.
  let droppedPeeks: string[] = [];

  const commit = (fn: (s: AppStore) => Partial<AppStore>) => {
    set((s) => {
      const patch = fn(s);
      let next = { ...s, ...patch } as AppStore;
      const live = next.groups.filter(
        (g) =>
          g.preset !== undefined ||
          subtreeEarnsItsKeep(next.groups, next.tabs, g.id)
      );
      if (live.length !== next.groups.length) {
        next = { ...next, groups: live };
        (patch as Partial<AppStore>).groups = live;
      }
      if (next.peekTabId !== null) {
        const p = next.tabs.find((t) => t.id === next.peekTabId);
        const stillOver =
          p !== undefined && p.peek === true && next.activeTabId === p.peekOver;
        if (!stillOver) {
          if (p !== undefined) droppedPeeks.push(p.id);
          const freezeGone =
            p !== undefined && next.pageFreeze?.tabId === p.peekOver;
          next = {
            ...next,
            tabs: next.tabs.filter((t) => t.id !== next.peekTabId),
            peekTabId: null,
            ...(freezeGone ? { pageFreeze: null } : {}),
          };
          (patch as Partial<AppStore>).tabs = next.tabs;
          (patch as Partial<AppStore>).peekTabId = null;
          if (freezeGone) (patch as Partial<AppStore>).pageFreeze = null;
        }
      }
      const split = validSplit(next.split, next.tabs);
      if (split !== next.split) {
        next = { ...next, split };
        (patch as Partial<AppStore>).split = split;
      }
      persist(next);
      return patch;
    });
    if (droppedPeeks.length > 0) {
      dropTabState(droppedPeeks);
      droppedPeeks = [];
    }
  };

  return {
    tabs: [],
    saveTemplateFor: null,
    broadcastTabs: {},
    filesOpenPath: {},
    filesOpenDir: {},
    /**
     * as broadcastTabs above, for the same reason — which machine a pane's
     * shell is on is a fact about this run, not about the workspace.
     */
    remoteTabs: {},
    /**
     * Per-pane running state (see the field's declaration): the aggregate
     * behind `tab.busy`, never itself a workspace fact.
     */
    busyPanes: {},
    groups: withPresetGroups([]),
    activeTabId: null,
    sessionRestoreResult: null,
    newTabMenuOpen: false,
    joinDialogOpen: false,
    shareDialogTabId: null,
    appShare: null,
    appSharePanelOpen: false,
    switcherOpen: false,
    commandBarOpen: false,
    shortcutsHelpOpen: false,
    menu: null,
    sidebarMenu: null,
    groupMenu: null,
    folderPreviewGroupId: null,
    folderPreviewPendingGroupId: null,
    pageFreeze: null,
    namingGroupId: null,
    renamingTabId: null,
    passwordsOpen: false,
    fileClipboard: null,
    draggingFilePaths: [],
    selectedTabIds: [],
    selectionAnchor: null,
    authRequest: null,
    pageDialog: null,
    unloadConfirm: null,
    userscriptAsk: null,
    scriptCommands: {},
    audibleTabs: {},
    mutedTabs: {},
    archive: [],
    archiveEvicted: 0,
    archiveOpen: false,
    historyOpen: false,
    downloadsOpen: false,
    backgroundTasks: [],
    ...bootConfigSlice(),
    // The fallback theme until the theme bootstrap (main.tsx) or initTheme
    // overwrites the snapshot — the value the app rendered with before
    // themes existed, and the same landing point every unknown id gets.
    systemDark: true,
    resolvedTheme: FALLBACK_THEME,
    configError: null,
    configWarnings: [],
    configWarningsDismissed: false,
    configWriteErrors: [],
    configPath: null,
    sidebarWidthRange: null,
    split: null,
    splitDragging: false,
    peekTabId: null,
    contentDrag: null,
    paneHoverTabId: null,
    draggingTabIds: [],
    closedCount: 0,
    sidebarPeeking: false,

    splitWith: (id) => {
      const s = get();
      const active = s.tabs.find((t) => t.id === s.activeTabId);
      const other = s.tabs.find((t) => t.id === id);
      if (!splittable(active) || !splittable(other) || active.id === other.id) {
        return false;
      }
      const cur = s.split;
      if (cur !== null && cur.ids.includes(active.id)) {
        if (cur.ids.includes(other.id) || cur.ids.length >= SPLIT_MAX_PANES) {
          return false; // already a member, or full
        }
        const ids = [...cur.ids, other.id];
        commit(() => ({
          split: { ids, ratios: equalRatios(ids.length), vertical: cur.vertical },
          menu: null,
        }));
        return true;
      }
      // Otherwise a fresh two-pane split — active on the left, the asked tab
      // on the right — replacing any other split (there is only ever one).
      commit(() => ({
        split: { ids: [active.id, other.id], ratios: [0.5, 0.5], vertical: false },
        menu: null,
      }));
      return true;
    },

    splitDrop: (id, side) =>
      // The two-sided form the right-click path and the older tests use: the
      // near edge of whatever is on screen.
      get().splitDropAt(id, side === "left" ? 0 : Number.MAX_SAFE_INTEGER),

    splitOnTab: (draggedId, targetId, side) => {
      const s = get();
      const dragged = s.tabs.find((t) => t.id === draggedId);
      const target = s.tabs.find((t) => t.id === targetId);
      if (!splittable(dragged) || !splittable(target) || draggedId === targetId) {
        set({ contentDrag: null });
        return false;
      }
      const cur = s.split;
      let group: SplitGroup;
      if (
        cur !== null &&
        cur.ids.includes(targetId) &&
        !cur.ids.includes(draggedId) &&
        cur.ids.length < SPLIT_MAX_PANES
      ) {
        // Onto a pane of a standing split: in beside it, on the side asked for.
        const ids = [...cur.ids];
        const at = ids.indexOf(targetId) + (side === "right" ? 1 : 0);
        ids.splice(at, 0, draggedId);
        group = { ids, ratios: equalRatios(ids.length), vertical: cur.vertical };
      } else {
        group = {
          ids: side === "left" ? [draggedId, targetId] : [targetId, draggedId],
          ratios: [0.5, 0.5],
          vertical: cur?.vertical ?? false,
        };
      }
      const rest = s.tabs.filter((t) => t.id !== draggedId);
      const placed =
        target.groupId !== null
          ? promoteTab(dragged, target.groupId)
          : demoteTab(dragged);
      const at = rest.findIndex((t) => t.id === targetId);
      const order =
        at < 0
          ? [...rest, placed]
          : side === "left"
            ? [...rest.slice(0, at), placed, ...rest.slice(at)]
            : [...rest.slice(0, at + 1), placed, ...rest.slice(at + 1)];
      // A split only shows when one of its members is the tab in front, and
      // the one the user just placed is the one they are looking at.
      commit(() => ({
        tabs: order,
        split: group,
        activeTabId: draggedId,
        contentDrag: null,
        menu: null,
      }));
      return true;
    },

    splitDropAt: (id, index) => {
      const s = get();
      const active = s.tabs.find((t) => t.id === s.activeTabId);
      const other = s.tabs.find((t) => t.id === id);
      if (!splittable(active) || !splittable(other) || active.id === other.id) {
        // The drag ends whether or not a split was made; a bad drop just
        // returns the pages to where they were.
        set({ contentDrag: null });
        return false;
      }
      const cur = s.split;
      let group: SplitGroup;
      if (
        cur !== null &&
        cur.ids.includes(active.id) &&
        !cur.ids.includes(other.id) &&
        cur.ids.length < SPLIT_MAX_PANES
      ) {
        const ids = [...cur.ids];
        ids.splice(Math.max(0, Math.min(index, ids.length)), 0, other.id);
        group = { ids, ratios: equalRatios(ids.length), vertical: cur.vertical };
      } else {
        const before = index <= 0;
        group = {
          ids: before ? [other.id, active.id] : [active.id, other.id],
          ratios: [0.5, 0.5],
          vertical: cur?.vertical ?? false,
        };
      }
      // Same placement rule as splitOnTab: the pair shows at the position of
      // the tab that was already on screen, so the dragged one comes to sit
      // beside it rather than leaving the merged row somewhere else.
      const rest = s.tabs.filter((t) => t.id !== id);
      const anchor = group.ids.find((x) => x !== id) ?? active.id;
      const at = rest.findIndex((t) => t.id === anchor);
      const before = group.ids.indexOf(id) < group.ids.indexOf(anchor);
      const placed =
        active.groupId !== null
          ? promoteTab(other, active.groupId)
          : demoteTab(other);
      const order =
        at < 0
          ? [...rest, placed]
          : before
            ? [...rest.slice(0, at), placed, ...rest.slice(at)]
            : [...rest.slice(0, at + 1), placed, ...rest.slice(at + 1)];
      commit(() => ({
        tabs: order,
        split: group,
        contentDrag: null,
        menu: null,
      }));
      return true;
    },

    addSplitPane: (side) => {
      const s = get();
      const cur = s.split;
      const active = s.activeTabId;
      if (cur === null || active === null || !cur.ids.includes(active)) {
        return false;
      }
      const cand = nextSplitCandidate(s);
      if (cand === null) return false;
      const grown = withInsertedPane(cur, active, cand, side);
      if (grown === null) return false; // full
      commit(() => ({ split: grown, menu: null }));
      return true;
    },

    setContentDrag: (v) => set({ contentDrag: v }),

    setPaneHover: (id) => set({ paneHoverTabId: id }),

    setDraggingTabs: (ids) => set({ draggingTabIds: ids }),

    unsplit: () =>
      commit(() => ({ split: null, menu: null })),

    moveSplitPane: (id, delta) =>
      commit((s) => {
        const g = s.split;
        if (g === null) return {};
        const i = g.ids.indexOf(id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= g.ids.length) return {};
        const ids = g.ids.slice();
        const ratios = g.ratios.slice();
        [ids[i], ids[j]] = [ids[j], ids[i]];
        [ratios[i], ratios[j]] = [ratios[j], ratios[i]];
        // Focus follows the tab, not the slot: activeTabId is untouched.
        return { split: { ...g, ids, ratios }, menu: null };
      }),

    separateFromSplit: (id) =>
      commit((s) => {
        const g = s.split;
        if (g === null || !g.ids.includes(id)) return {};
        const ids = g.ids.filter((x) => x !== id);
        let activeTabId = s.activeTabId;
        if (s.activeTabId === id) {
          const at = g.ids.indexOf(id);
          activeTabId = g.ids[at + 1] ?? g.ids[at - 1] ?? s.activeTabId;
        }
        const split =
          ids.length >= 2
            ? { ids, ratios: equalRatios(ids.length), vertical: g.vertical }
            : null;
        return { split, activeTabId, menu: null };
      }),

    toggleSplitOrientation: () =>
      commit((s) =>
        s.split === null
          ? {}
          : { split: { ...s.split, vertical: !s.split.vertical }, menu: null }
      ),

    setSplitRatio: (dividerIndex, position, final = false) => {
      const patch = (s: AppStore): Partial<AppStore> => {
        const g = s.split;
        if (g === null || dividerIndex < 0 || dividerIndex >= g.ids.length - 1) {
          return {};
        }
        const ratios = g.ratios.slice();
        const before = ratios
          .slice(0, dividerIndex)
          .reduce((a, b) => a + b, 0);
        // The boundary lives inside the two panes it divides; their combined
        // share is fixed, so the panes on either side never move.
        const pairSum = ratios[dividerIndex] + ratios[dividerIndex + 1];
        const left = Math.min(
          pairSum - SPLIT_MIN_SHARE,
          Math.max(SPLIT_MIN_SHARE, position - before)
        );
        ratios[dividerIndex] = left;
        ratios[dividerIndex + 1] = pairSum - left;
        return { split: { ...g, ratios } };
      };
      // Mid-drag moves are plain sets — a disk write per pointer move is
      // the thing the debounced doorway exists to avoid paying — and the
      // release commits once, which is what makes the ratios persistent.
      if (final) commit(patch);
      else set(patch);
    },

    setSplitDragging: (on) => set({ splitDragging: on }),


    splitTerminalPane: (tabId, vertical, cwd) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || tab.type !== "terminal" || tab.dormant === true) return null;
      const newId = crypto.randomUUID();
      // The first split wraps the terminal that is already running, and the
      // leaf it becomes takes the TAB'S id. That is not a shortcut: the
      // pane's id is what keys its React element, its registry entry and
      // its screen-memory file, so any other id would tear the live shell
      // down and start a new one as the price of pressing ⌘D.
      const base: PaneNode = tab.panes ?? {
        kind: "leaf",
        id: tab.id,
        termId: tab.termId,
        cwd: tab.cwd,
      };
      const from = tab.activePaneId ?? firstLeaf(base);
      const panes = splitPane(base, from, vertical, newId, cwd ?? tab.cwd);
      if (panes === base) return null;
      commit((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? // A split is a new pane to look at: zoom would hide it.
              { ...t, panes, activePaneId: newId, zoomedPaneId: undefined }
            : t
        ),
        activeTabId: tabId,
      }));
      return newId;
    },

    focusPaneDir: (tabId, dir) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab?.panes) return;
      const from = tab.activePaneId ?? firstLeaf(tab.panes);
      const to = neighbor(tab.panes, from, dir);
      if (to === null) return;
      // Jumping out of a zoomed pane is asking to see the other one, so the
      // zoom ends rather than following the focus.
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? { ...t, activePaneId: to, zoomedPaneId: undefined }
            : t
        ),
      }));
    },

    focusPane: (tabId, paneId) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab?.panes || tab.activePaneId === paneId) return {};
        if (findLeaf(tab.panes, paneId) === null) return {};
        return {
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, activePaneId: paneId } : t
          ),
        };
      }),

    togglePaneZoom: (tabId) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab?.panes) return {};
        const focus = tab.activePaneId ?? firstLeaf(tab.panes);
        const next = tab.zoomedPaneId === undefined ? focus : undefined;
        return {
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, zoomedPaneId: next, activePaneId: focus } : t
          ),
        };
      }),

    resizePaneDir: (tabId, dir) =>
      commit((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab?.panes) return {};
        const focus = tab.activePaneId ?? firstLeaf(tab.panes);
        const panes = resizePane(tab.panes, focus, dir);
        if (panes === tab.panes) return {};
        return {
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, panes } : t)),
        };
      }),

    setPaneRatio: (tabId, splitId, index, position, final = false) => {
      const patch = (s: AppStore): Partial<AppStore> => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab?.panes) return {};
        const panes = setPaneBoundary(tab.panes, splitId, index, position);
        if (panes === tab.panes) return {};
        return {
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, panes } : t)),
        };
      };
      // Same division of labour as the outer layer's divider: pointer moves
      // are plain sets, and only the release is worth a disk write.
      if (final) commit(patch);
      else set(patch);
    },

    removeTerminalPane: (tabId, paneId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab?.panes) return;
      if (findLeaf(tab.panes, paneId) === null) return;
      const panes = removePane(tab.panes, paneId);
      // Where the focus goes if it was in the pane that left: the survivor
      // that took its room.
      const successor = paneTakingOver(tab.panes, panes, paneId);
      if (panes === tab.panes) return;
      const remaining = leaves(panes);
      const focus =
        tab.activePaneId === paneId
          ? successor !== null && remaining.includes(successor)
            ? successor
            : firstLeaf(panes)
          : tab.activePaneId;
      // Down to one pane the TREE STAYS, holding that single leaf, and the
      // tab's own `termId`/`cwd` are re-pointed at it. Clearing `panes`
      // here instead would look tidier and would kill the surviving shell:
      // the pane list is what React reconciles the terminals by, so a tab
      // that stops having one takes its last terminal down with it. What
      // the single-leaf tree costs is nothing — the pane that carries the
      // tab's id keys its registry entry and its screen file exactly as an
      // un-split tab does — and sharing comes back the moment the count is
      // one again, which is what `shareBlockedReason` reads.
      const only = paneCount(panes) === 1 ? findLeaf(panes, firstLeaf(panes)) : null;
      commit((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                panes,
                activePaneId: only ? only.id : focus,
                zoomedPaneId:
                  t.zoomedPaneId === paneId ? undefined : t.zoomedPaneId,
                termId: only ? only.termId : t.termId,
                cwd: only?.cwd ?? t.cwd,
              }
            : t
        ),
      }));
    },

    // The two writers a mounted terminal uses for itself. Both answer for a
    // tab with a tree and for one without, so the view has no branch of its
    // own: with no tree they ARE setTabTermId and setTabCwd, which is what
    // makes an un-split tab's behaviour identical rather than merely similar.
    setPaneTermId: (tabId, paneId, termId) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab) return {};
        // The pane wearing the tab's own id is the tab's terminal in every
        // older sense — `share.ts` reads `tab.termId` — so it keeps that
        // field in step as well as its own leaf.
        const onTab = tab.panes === undefined || paneId === tabId;
        const panes = tab.panes ? updateLeaf(tab.panes, paneId, { termId }) : undefined;
        return {
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  ...(panes ? { panes } : {}),
                  ...(onTab ? { termId } : {}),
                }
              : t
          ),
        };
      }),

    setPaneCwd: (tabId, paneId, cwd) =>
      commit((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab) return {};
        const onTab = tab.panes === undefined || paneId === tabId;
        const leafSame =
          tab.panes === undefined || findLeaf(tab.panes, paneId)?.cwd === cwd;
        const tabSame = !onTab || tab.cwd === cwd;
        // Reported on every prompt; a session write per prompt is what the
        // no-op guard on setTabCwd exists to avoid, and it has to stay.
        if (leafSame && tabSame) return {};
        const panes = tab.panes ? updateLeaf(tab.panes, paneId, { cwd }) : undefined;
        return {
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  ...(panes ? { panes } : {}),
                  ...(onTab ? { cwd } : {}),
                }
              : t
          ),
        };
      }),

    openTemplateTab: (template) => {
      const id = crypto.randomUUID();
      // The declared tree, made live: fresh pane ids throughout except the
      // first leaf, which wears the tab's own id so its registry key and
      // screen-memory scope are the ones an un-split terminal has always
      // used. Per-pane launch fields (profile, cwd, runOnStart) travel on
      // the leaves; the terminal view reads them at spawn.
      const panes = instantiateTemplate(template.tree, id);
      const first = findLeaf(panes, firstLeaf(panes));
      const tab: Tab = {
        id,
        type: "terminal",
        title: `Terminal ${++terminalCounter}`,
        groupId: null,
        // The tab's own directory mirrors the first pane's, the same field
        // every other terminal tab keeps — the sidebar and the archive read
        // it, and a dormant wake uses it.
        cwd: first?.cwd,
        panes,
        activePaneId: firstLeaf(panes),
        lastActiveAt: Date.now(),
      };
      commit((s) => ({
        tabs: [tab, ...s.tabs],
        activeTabId: id,
        newTabMenuOpen: false,
        joinDialogOpen: false,
      }));
      return id;
    },

    setSaveTemplateFor: (tabId) => set({ saveTemplateFor: tabId }),

    toggleBroadcast: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (tab === undefined || tab.type !== "terminal") return { on: false };
      const on = get().broadcastTabs[tabId] === true;
      if (!on && tab.share !== undefined) {
        return { on: false, refused: "sharing" };
      }
      const next = { ...get().broadcastTabs };
      if (on) delete next[tabId];
      else next[tabId] = true;
      set({ broadcastTabs: next });
      return { on: !on };
    },

    isBroadcasting: (tabId) => get().broadcastTabs[tabId] === true,

    setTabRemote: (id, remote) =>
      set((s) => {
        if (remote === null) {
          if (s.remoteTabs[id] === undefined) return {};
          const next = { ...s.remoteTabs };
          delete next[id];
          return { remoteTabs: next };
        }
        if (s.remoteTabs[id]?.host === remote.host) return {};
        return { remoteTabs: { ...s.remoteTabs, [id]: { host: remote.host } } };
      }),

    setTabReveal: (tabId, reveal) =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? { ...t, dormant: undefined, reveal }
            : t
        ),
      })),

    openPeek: (target) => {
      if (get().peekTabId !== null) get().discardPeek();
      const id = crypto.randomUUID();
      const over = get().activeTabId ?? undefined;
      const now = Date.now();
      const tab: Tab =
        target.type === "browser"
          ? {
              id,
              type: "browser",
              title: peekHostTitle(target.url),
              groupId: null,
              url: target.url,
              peek: true,
              // The overlay belongs to this moment: the commit gate drops it
              // as soon as activation leaves the tab it opened over.
              peekOver: over,
              lastActiveAt: now,
            }
          : {
              id,
              type: "files",
              title: peekFileTitle(target.openPath),
              groupId: null,
              openPath: target.openPath,
              peek: true,
              peekOver: over,
              lastActiveAt: now,
            };
      set((s) => ({ tabs: [...s.tabs, tab], peekTabId: id }));
      return id;
    },

    discardPeek: () => {
      const s = get();
      const id = s.peekTabId;
      if (id === null) return;
      const source = s.tabs.find((t) => t.id === id)?.peekOver ?? null;
      dropTabState([id]);
      set((st) => ({
        tabs: st.tabs.filter((t) => t.id !== id),
        peekTabId: null,
        pageFreeze:
          source !== null && st.pageFreeze?.tabId === source
            ? null
            : st.pageFreeze,
      }));
    },

    promotePeek: () => {
      const id = get().peekTabId;
      if (id === null) return null;
      commit((s) => {
        const t = s.tabs.find((x) => x.id === id);
        if (!t) return { peekTabId: null, pageFreeze: null };
        const rest = s.tabs.filter((x) => x.id !== id);
        const promoted: Tab = {
          ...t,
          peek: undefined,
          peekOver: undefined,
          lastActiveAt: Date.now(),
        };
        return {
          tabs: [promoted, ...rest],
          activeTabId: id,
          peekTabId: null,
          pageFreeze: null,
        };
      });
      return id;
    },

    splitPeek: () => {
      const s = get();
      const id = s.peekTabId;
      if (id === null) return null;
      const sourceId = s.tabs.find((t) => t.id === id)?.peekOver ?? null;
      const promoted = get().promotePeek();
      if (promoted === null || sourceId === null) return promoted;
      const source = get().tabs.find((t) => t.id === sourceId);
      // The source may have gone away or gone dormant while the peek was up;
      // then the page is still promoted, just not split.
      if (!splittable(source) || source.id === promoted) return promoted;
      commit((st) => {
        const cur = st.split;
        if (
          cur !== null &&
          cur.ids.includes(sourceId) &&
          !cur.ids.includes(promoted) &&
          cur.ids.length < SPLIT_MAX_PANES
        ) {
          const grown = withInsertedPane(cur, sourceId, promoted, "right");
          return grown === null ? {} : { split: grown };
        }
        return {
          split: { ids: [sourceId, promoted], ratios: [0.5, 0.5], vertical: false },
        };
      });
      return promoted;
    },

    addTab: (partial) => {
      const id = partial.id ?? crypto.randomUUID();
      const title =
        partial.title ??
        (partial.type === "terminal"
          ? `Terminal ${++terminalCounter}`
          : TYPE_TITLES[partial.type]);
      if (partial.type === "settings") {
        const existing = get().tabs.find((t) => t.type === "settings");
        if (existing) {
          set({ activeTabId: existing.id, newTabMenuOpen: false });
          return existing.id;
        }
      }
      const groupId = partial.groupId !== undefined ? partial.groupId : null;
      const tab: Tab = {
        id,
        type: partial.type,
        title,
        groupId,
        // An agent with no folder named for it lands in the one the user is
        // already working in, rather than at the root of everything they own.
        cwd:
          partial.cwd ??
          (partial.type === "agent"
            ? inheritedCwd(get().tabs, get().activeTabId)
            : undefined),
        url: partial.url,
        joinTicket: partial.joinTicket,
        renamed: partial.renamed,
        openPath: partial.openPath,
        reveal: partial.reveal,
        command: partial.command,
        runOnStart: partial.runOnStart,
        attachSessionId: partial.attachSessionId,
        // The profile the ⌘N picker or a `new:` row chose. Passed through
        // untouched: this store decides nothing about what a profile means.
        profile: partial.profile,
        pinnedUrl:
          partial.pinnedUrl ??
          (groupId !== null && partial.type === "browser" && partial.url
            ? partial.url
            : undefined),
        lastActiveAt: partial.lastActiveAt ?? Date.now(),
      };
      commit((s) => ({
        tabs: [tab, ...s.tabs],
        activeTabId: id,
        newTabMenuOpen: false,
        joinDialogOpen: false,
      }));
      return id;
    },

    showCommand: (text, cwd) => {
      const state = get();
      // The terminal rooted deepest under the agent's folder, same rule the
      // files side uses: with both ~/work and ~/work/api open, a command run in
      // the latter belongs there.
      const host = state.tabs
        .filter((t) => t.type === "terminal" && isUnder(cwd ?? "", t.cwd))
        .sort((a, b) => (b.cwd?.length ?? 0) - (a.cwd?.length ?? 0))[0];

      if (host) {
        commit((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === host.id
              ? {
                  ...t,
                  dormant: undefined,
                  lastActiveAt: Date.now(),
                  // The nonce is what makes the same command land twice: the
                  // agent runs `cargo test` over and over, and an effect keyed
                  // on the text alone would ignore every one after the first.
                  command: { text, nonce: (t.command?.nonce ?? 0) + 1 },
                }
              : t,
          ),
          activeTabId: host.id,
        }));
        return;
      }

      get().addTab({
        type: "terminal",
        cwd,
        command: { text, nonce: 1 },
      });
    },

    revealPath: (path, line) => {
      const state = get();
      // Deepest root wins: with both ~/work and ~/work/api open, a file under
      // the latter belongs there, not in the tab that merely contains it.
      const host = state.tabs
        .filter((t) => t.type === "files" && t.peek !== true && isUnder(path, t.cwd))
        .sort((a, b) => (b.cwd?.length ?? 0) - (a.cwd?.length ?? 0))[0];

      if (host) {
        commit((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === host.id
              ? {
                  ...t,
                  // Waking here is deliberate: the user asked to see a file, and
                  // a shelved tab that stays shelved would silently swallow that.
                  dormant: undefined,
                  reveal: {
                    path,
                    line,
                    nonce: (t.reveal?.nonce ?? 0) + 1,
                  },
                }
              : t,
          ),
        }));
        get().activateTab(host.id);
        return host.id;
      }

      return get().addTab({
        type: "files",
        cwd: parentOf(path),
        openPath: path,
        reveal: { path, line, nonce: 1 },
      });
    },

    closeTab: (id) => {
      const dying = get().tabs.find((t) => t.id === id);
      if (!dying) return;
      if (dying.peek === true) {
        if (get().peekTabId === id) {
          get().discardPeek();
        } else {
          dropTabState([id]);
          set((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) }));
        }
        return;
      }
      if (dying.groupId !== null) {
        if (dying.dormant === true) return; // already asleep; nothing to do
        commit((s) => {
          const t = s.tabs.find((x) => x.id === id);
          if (!t || t.groupId === null || t.dormant === true) return {};
          let activeTabId = s.activeTabId;
          if (activeTabId === id) {
            const seat = s.split ? seatAfterClose(s.split, id, s.tabs) : null;
            if (seat !== null) {
              activeTabId = seat;
            } else {
            // The nearest neighbor that can actually be shown — a dormant
            // row has no pane, so handing it focus would show a blank pane.
            const drawn = visibleOrdered(s.tabs, s.groups, s.split).filter(
              (x) => x.dormant !== true
            );
            const vIdx = drawn.findIndex((x) => x.id === id);
            const left = drawn.filter((x) => x.id !== id);
            const neighbor =
              vIdx >= 0
                ? left[Math.min(vIdx, left.length - 1)]
                : left[left.length - 1];
            activeTabId = neighbor ? neighbor.id : null;
            }
          }
          return {
            tabs: s.tabs.map((x) => (x.id === id ? sleepTab(x) : x)),
            activeTabId,
            shareDialogTabId:
              s.shareDialogTabId === id ? null : s.shareDialogTabId,
            menu: s.menu?.tabId === id ? null : s.menu,
          };
        });
        return;
      }
      // A today tab really closes. Its workspace files are NOT reclaimed
      // here any more: reopening has to be able to bring back the open
      // files, the draft, the directory. rememberClosed evicts the oldest
      // entry and reclaims that one, so nothing leaks — and a crash in
      // between is caught by the boot sweep.
      rememberClosed(dying, get().tabs.findIndex((t) => t.id === id));
      set({ closedCount: closedTabs.length });
      commit((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        if (idx < 0) return {};
        const tabs = s.tabs.filter((t) => t.id !== id);
        let activeTabId = s.activeTabId;
        if (activeTabId === id) {
          const seat = s.split ? seatAfterClose(s.split, id, s.tabs) : null;
          if (seat !== null) {
            activeTabId = seat;
          } else {
          // Pick the neighbor the user can see, in sidebar order — the raw
          // array could hand focus to a tab hidden in a collapsed group —
          // skipping dormant rows, which have no pane to show.
          const before = visibleOrdered(s.tabs, s.groups, s.split).filter(
            (t) => t.dormant !== true
          );
          const vIdx = before.findIndex((t) => t.id === id);
          const after = before.filter((t) => t.id !== id);
          const neighbor =
            vIdx >= 0
              ? after[Math.min(vIdx, after.length - 1)]
              : tabs[Math.min(idx, tabs.length - 1)];
          activeTabId = neighbor ? neighbor.id : null;
          }
        }
        return {
          tabs,
          activeTabId,
          shareDialogTabId: s.shareDialogTabId === id ? null : s.shareDialogTabId,
          menu: s.menu?.tabId === id ? null : s.menu,
        };
      });
    },


    closeTabs: async (ids, askFinal) => {
      for (const id of ids) {
        // Re-read each turn: an answer awaited between closes may have
        // watched the list change underneath it, and an id that stopped
        // existing between click and close is simply done.
        const t = get().tabs.find((x) => x.id === id);
        if (!t) continue;
        if (t.type === "settings" || t.type === "remote") {
          // Destructive: nothing of either kind ever enters the reopen
          // queue, so a batch sweep asks about it alone before closing —
          // the ask-then-close shape closeTabAsking established for the
          // page's own say. Without an asker, the close proceeds.
          if (askFinal && !(await askFinal(t))) continue;
        }
        get().closeTab(id);
      }
      // The picking has done its job; a selection left standing over rows
      // that no longer exist would rope ghosts into the next drag.
      get().clearSelection();
    },

    activateTab: (id, now) =>
      commit((s) => {
        return {
          activeTabId: id,
          switcherOpen: false,
          menu: null,
          ...(s.folderPreviewGroupId !== null || s.pageFreeze !== null
            ? {
                folderPreviewGroupId: null,
                pageFreeze: null,
              }
            : {}),
          tabs: s.tabs.map((t) =>
            t.id === id
              ? {
                  ...wakeTab(t),
                  attention: undefined,
                  lastActiveAt: now ?? Date.now(),
                }
              : t
          ),
        };
      }),

    activateIndex: (i) => {
      const { tabs, groups, split } = get();
      // ⌘n means "the n-th row I can see", in sidebar drawing order — a
      // split counts once, and landing on it activates its first pane.
      const visible = visibleOrdered(tabs, groups, split);
      if (i >= 0 && i < visible.length) get().activateTab(visible[i].id);
    },

    cycleTab: (delta) => {
      const { tabs, groups, activeTabId, split } = get();
      const visible = visibleOrdered(tabs, groups, split);
      if (visible.length === 0) return;
      const fromId =
        split !== null &&
        activeTabId !== null &&
        split.ids.includes(activeTabId) &&
        activeTabId !== split.ids[0]
          ? split.ids[0]
          : activeTabId;
      const idx = Math.max(
        0,
        visible.findIndex((t) => t.id === fromId)
      );
      const next = (idx + delta + visible.length) % visible.length;
      get().activateTab(visible[next].id);
    },

    moveTab: (id, beforeId) =>
      commit((s) => {
        const moving = s.tabs.find((t) => t.id === id);
        if (!moving || id === beforeId) return {};
        const rest = s.tabs.filter((t) => t.id !== id);
        const target = beforeId ? rest.find((t) => t.id === beforeId) : null;
        const withGroup = target
          ? target.groupId !== null
            ? promoteTab(moving, target.groupId)
            : demoteTab(moving)
          : moving;
        const at = beforeId ? rest.findIndex((t) => t.id === beforeId) : rest.length;
        const tabs = [...rest.slice(0, at), withGroup, ...rest.slice(at)];
        return { tabs };
      }),

    setTabTitle: (id, title) =>
      commit((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id && !t.renamed ? { ...t, title } : t
        ),
      })),

    renameTab: (id, title) =>
      commit((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, title, renamed: true } : t
        ),
        menu: null,
      })),

    markTabExited: (id) =>
      commit((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, exited: true } : t)),
      })),

    setAttention: (id, on) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, attention: on } : t)),
      })),

    setTabBusy: (id, busy) =>
      set((s) => {
        const t = s.tabs.find((x) => x.id === id);
        if (!t) return {};
        // Clearing the tab-level flag clears the per-pane records it is
        // aggregated from, or a pane that went silent would hold `busy`
        // true forever through its own stale entry. Setting it does not
        // touch them: the agent tab's turn has no pane to record.
        if (!busy && s.busyPanes[id] !== undefined) {
          const { [id]: _gone, ...rest } = s.busyPanes;
          if ((t.busy ?? false) === busy) return { busyPanes: rest };
          return {
            tabs: s.tabs.map((x) => (x.id === id ? { ...x, busy } : x)),
            busyPanes: rest,
          };
        }
        if ((t.busy ?? false) === busy) return {};
        return { tabs: s.tabs.map((x) => (x.id === id ? { ...x, busy } : x)) };
      }),

    // The files pane's live open-file fact: set on every open, cleared on
    // close. Plain set (not commit) — it is UI state the session snapshot
    // deliberately does not carry; the app-share overlay reads it live.
    setFilesOpenPath: (tabId, path) =>
      set((s) => {
        const prev = s.filesOpenPath[tabId];
        if (path === null) {
          if (prev === undefined) return {};
          const { [tabId]: _gone, ...rest } = s.filesOpenPath;
          return { filesOpenPath: rest };
        }
        if (prev === path) return {};
        return { filesOpenPath: { ...s.filesOpenPath, [tabId]: path } };
      }),

    // The same contract for the pane's browsing directory: set from the
    // active pane's root on every change (open, navigate, restore).
    setFilesOpenDir: (tabId, dir) =>
      set((s) => {
        const prev = s.filesOpenDir[tabId];
        if (dir === null) {
          if (prev === undefined) return {};
          const { [tabId]: _gone, ...rest } = s.filesOpenDir;
          return { filesOpenDir: rest };
        }
        if (prev === dir) return {};
        return { filesOpenDir: { ...s.filesOpenDir, [tabId]: dir } };
      }),
    setPaneBusy: (id, paneId, busy) =>
      set((s) => {
        const t = s.tabs.find((x) => x.id === id);
        if (!t) return {};
        const prev = s.busyPanes[id] ?? {};
        const had = prev[paneId] !== undefined;
        if (busy === had) return {}; // block transitions fire far more often than this flips
        const next = { ...prev };
        if (busy) next[paneId] = true;
        else delete next[paneId];
        // The union, not the last pane to speak: an idle sibling's `false`
        // must never unblock closing a tab whose other pane still runs.
        const anyBusy = Object.keys(next).length > 0;
        const busyPanes = { ...s.busyPanes };
        if (anyBusy) busyPanes[id] = next;
        else delete busyPanes[id];
        if ((t.busy ?? false) === anyBusy) return { busyPanes };
        return {
          tabs: s.tabs.map((x) => (x.id === id ? { ...x, busy: anyBusy } : x)),
          busyPanes,
        };
      }),

    setTabOutputAt: (id, at) =>
      set((s) => {
        const t = s.tabs.find((x) => x.id === id);
        if (!t || t.lastOutputAt === at) return {};
        return {
          tabs: s.tabs.map((x) => (x.id === id ? { ...x, lastOutputAt: at } : x)),
        };
      }),

    setTabDirty: (id, dirty) =>
      set((s) => {
        const t = s.tabs.find((x) => x.id === id);
        if (!t || (t.dirty ?? false) === dirty) return {};
        return { tabs: s.tabs.map((x) => (x.id === id ? { ...x, dirty } : x)) };
      }),


    // A group only exists while it holds tabs, so creating one always takes
    // the tab that motivated it.
    duplicateTab: (id) => {
      const src = get().tabs.find((t) => t.id === id);
      // Settings is a singleton; a second viewer onto someone else's shared
      // session only narrows the host's viewport for everyone.
      if (!src || src.type === "settings" || src.type === "remote") return null;
      const copy = get().addTab({
        type: src.type,
        title: src.renamed ? src.title : undefined,
        renamed: src.renamed,
        cwd: src.cwd,
        url: src.url,
        groupId: src.groupId,
      });
      // Right after its source, not at the end: it is a continuation of
      // that work and belongs beside it.
      commit((s) => {
        const rest = s.tabs.filter((t) => t.id !== copy);
        const at = rest.findIndex((t) => t.id === id);
        const made = s.tabs.find((t) => t.id === copy)!;
        return {
          tabs: [...rest.slice(0, at + 1), made, ...rest.slice(at + 1)],
        };
      });
      return copy;
    },

    reopenClosedTab: (at = 0) => {
      const entry = closedTabs[at];
      if (!entry) return null;
      closedTabs = closedTabs.filter((_, i) => i !== at);
      // Its workspace files were never reclaimed, so restoring the record
      // restores the work: the same id finds the same open files, draft and
      // directory it had when it was closed.
      commit((s) => {
        const tabs = [...s.tabs];
        tabs.splice(Math.min(entry.index, tabs.length), 0, entry.tab);
        return { tabs, activeTabId: entry.tab.id, closedCount: closedTabs.length };
      });
      return entry.tab.id;
    },

    recentlyClosed: () =>
      closedTabs.map((e) => ({ tab: e.tab, index: e.index, closedAt: e.closedAt })),

    setSidebarWidth: (px) => {
      // Bounded so the sidebar can never be dragged to a width it cannot be
      // grabbed back from — to the registry's own bounds, fetched with the
      // schema, never to a pair of numbers written down again here.
      const width = clampWidth(Math.round(px), get().sidebarWidthRange);
      // Read before the set, because it is where a write that fails puts the
      // sidebar back — and after the set there is nothing left to read it
      // from. The queue keeps the first of these across a whole drag, so a
      // failed write returns the edge to where the gesture started.
      const previous = get().sidebarWidth;
      // Plain set, not commit: the width is a setting and rides in the
      // configuration file now, not in the session blob.
      set({ sidebarWidth: width });
      writeSetting(CONFIG_KEYS.sidebarWidth, width, previous);
    },

    toggleSidebar: () => {
      const previous = get().sidebarPinned;
      const pinned = !previous;
      set({ sidebarPinned: pinned, sidebarPeeking: false });
      writeSetting(CONFIG_KEYS.sidebarPinned, pinned, previous);
      requestTrafficLightReapply();
    },

    setSidebarPeeking: (on) => {
      const previous = get().sidebarPeeking;
      set((s) => ({
        sidebarPeeking: on,
        ...(!on && s.folderPreviewGroupId === null && s.pageFreeze !== null
          ? { pageFreeze: null }
          : {}),
      }));
      // The floating sidebar is summoned by pointer hover rather than the
      // toggle button. That path changes the titlebar/webview geometry too,
      // so repair the native traffic-light position whenever the peek state
      // actually changes, not only when the persisted pin state changes.
      if (previous !== on) requestTrafficLightReapply();
    },

    createGroup: (name, tabId) => {
      const id = crypto.randomUUID();
      commit((s) => ({
        groups: [
          ...s.groups,
          {
            id,
            name,
            colorIndex: s.groups.length % GROUP_PALETTE_SIZE,
            collapsed: false,
          },
        ],
        tabs: tabId
          ? s.tabs.map((t) => (t.id === tabId ? promoteTab(t, id) : t))
          : s.tabs,
        menu: null,
      }));
      return id;
    },

    createEmptyGroup: (parentId) => {
      const taken = new Set(get().groups.map((g) => g.name));
      let name = "New group";
      for (let n = 2; taken.has(name); n++) name = `New group ${n}`;
      const id = crypto.randomUUID();
      commit((s) => ({
        groups: [
          ...s.groups.map((g) =>
            parentId !== undefined && g.id === parentId && g.collapsed
              ? { ...g, collapsed: false }
              : g
          ),
          {
            id,
            name,
            colorIndex: s.groups.length % GROUP_PALETTE_SIZE,
            collapsed: false,
            keepWhenEmpty: true as const,
            // Dangling parents degrade to the root via rootGroups, so an
            // id that stopped existing between click and commit is safe.
            parentId,
          },
        ],
        sidebarMenu: null,
        groupMenu: null,
      }));
      // Named on the spot, the way every app that makes a folder does it —
      // a row called "New group" that has to be found and double-clicked is
      // a second step for something the user is already doing.
      set({ namingGroupId: id });
      return id;
    },

    setNamingGroup: (id) => set({ namingGroupId: id }),

    // Not through commit: which row is being renamed is about this moment,
    // not about the saved workspace (the resulting rename goes through
    // renameTab, which persists).
    setRenamingTab: (id) => set({ renamingTabId: id }),

    setPasswordsOpen: (on) => set({ passwordsOpen: on }),

    // Not through commit: what is on the clipboard is about the next few
    // seconds, not about the saved workspace.
    setFileClipboard: (entry) => set({ fileClipboard: entry }),

    // Not through commit: what a tree drag is carrying is about the gesture
    // in flight, not about the saved workspace — the same one-gesture
    // lifetime setDraggingTabs has.
    setDraggingFilePaths: (paths) => set({ draggingFilePaths: paths }),

    // Not through commit: which rows are picked out is about the next drag,
    // not about the session, and does not belong in a saved workspace.
    toggleSelected: (id) =>
      set((s) => ({
        selectedTabIds: s.selectedTabIds.includes(id)
          ? s.selectedTabIds.filter((t) => t !== id)
          : [...s.selectedTabIds, id],
        selectionAnchor: id,
      })),

    extendSelectionTo: (id) =>
      set((s) => {
        // A range means what the eye sees between two rows, so it counts in
        // drawing order — not in the array's order, which interleaves
        // groups differently from the sidebar.
        const visible = visibleOrdered(s.tabs, s.groups, s.split).map(
          (t) => t.id
        );
        const from = visible.indexOf(s.selectionAnchor ?? id);
        const to = visible.indexOf(id);
        if (from < 0 || to < 0) return { selectedTabIds: [id], selectionAnchor: id };
        const [a, b] = from <= to ? [from, to] : [to, from];
        return { selectedTabIds: visible.slice(a, b + 1) };
      }),

    clearSelection: () => set({ selectedTabIds: [], selectionAnchor: null }),

    moveTabs: (ids, beforeId) =>
      commit((s) => {
        // The order among the moved tabs is the order they already had:
        // dragging three rows must not shuffle them on arrival.
        const moving = s.tabs.filter((t) => ids.includes(t.id));
        if (moving.length === 0) return {};
        const rest = s.tabs.filter((t) => !ids.includes(t.id));
        const target = beforeId ? rest.find((t) => t.id === beforeId) : null;
        const placed = target
          ? moving.map((t) =>
              target.groupId !== null ? promoteTab(t, target.groupId) : demoteTab(t)
            )
          : moving;
        const at = target
          ? rest.findIndex((t) => t.id === beforeId)
          : rest.length;
        return { tabs: [...rest.slice(0, at), ...placed, ...rest.slice(at)] };
      }),

    renameGroup: (id, name) =>
      commit((s) => ({
        groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
      })),

    setGroupColor: (id, colorIndex) =>
      commit((s) => ({
        groups: s.groups.map((g) => (g.id === id ? { ...g, colorIndex } : g)),
      })),

    toggleGroupCollapsed: (id) =>
      commit((s) => ({
        groups: s.groups.map((g) =>
          g.id === id ? { ...g, collapsed: !g.collapsed } : g
        ),
      })),

    assignToGroup: (tabId, groupId) =>
      commit((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? groupId !== null
              ? promoteTab(t, groupId)
              : demoteTab(t)
            : t
        ),
        menu: null,
      })),

    closeGroup: (groupId) =>
      commit((s) => {
        const zone = new Set(groupSubtreeIds(s.groups, groupId));
        const sleeping = new Set(
          s.tabs
            .filter(
              (t) =>
                t.groupId !== null && zone.has(t.groupId) && t.dormant !== true
            )
            .map((t) => t.id)
        );
        if (sleeping.size === 0) return { menu: null };
        let activeTabId = s.activeTabId;
        if (activeTabId !== null && sleeping.has(activeTabId)) {
          // Same handoff as closing one pinned tab: the nearest row that
          // still has a pane.
          const drawn = visibleOrdered(s.tabs, s.groups).filter(
            (t) => t.dormant !== true
          );
          const vIdx = drawn.findIndex((t) => t.id === activeTabId);
          const left = drawn.filter((t) => !sleeping.has(t.id));
          const neighbor =
            vIdx >= 0
              ? left[Math.min(vIdx, left.length - 1)]
              : left[left.length - 1];
          activeTabId = neighbor ? neighbor.id : null;
        }
        return {
          tabs: s.tabs.map((t) => (sleeping.has(t.id) ? sleepTab(t) : t)),
          activeTabId,
          menu: null,
        };
      }),

    deleteGroup: (groupId) => {
      const doomed = new Set(groupSubtreeIds(get().groups, groupId));
      dropTabState(
        get()
          .tabs.filter((t) => t.groupId !== null && doomed.has(t.groupId))
          .map((t) => t.id)
      );
      commit((s) => {
        const dead = new Set(groupSubtreeIds(s.groups, groupId));
        const tabs = s.tabs.filter(
          (t) => t.groupId === null || !dead.has(t.groupId)
        );
        const activeStillThere = tabs.some((t) => t.id === s.activeTabId);
        return {
          tabs,
          groups: s.groups.filter(
            (g) => !dead.has(g.id) || g.preset !== undefined
          ),
          activeTabId: activeStillThere
            ? s.activeTabId
            : (tabs.filter((t) => t.dormant !== true).pop()?.id ?? null),
          menu: null,
        };
      });
    },

    dissolveGroup: (groupId) =>
      commit((s) => {
        const g = s.groups.find((x) => x.id === groupId);
        if (!g || g.preset !== undefined) return {};
        const parentId = g.parentId;
        const parentAlive =
          parentId !== undefined && s.groups.some((x) => x.id === parentId);
        return {
          tabs: s.tabs.map((t) =>
            t.groupId === groupId
              ? parentAlive
                ? promoteTab(t, parentId)
                : demoteTab(t)
              : t
          ),
          // Subfolders adopt the deleted folder's parent (or become
          // roots), keeping their own subtrees intact. Ones that end up
          // empty and were not made-as-a-place are swept by commit.
          groups: s.groups
            .filter((x) => x.id !== groupId)
            .map((x) =>
              x.parentId === groupId ? { ...x, parentId } : x
            ),
          groupMenu: null,
        };
      }),

    setGroupParent: (id, parentId) => {
      const s = get();
      const moving = s.groups.find((g) => g.id === id);
      if (!moving || moving.preset !== undefined) return false;
      if (parentId !== null) {
        if (!s.groups.some((g) => g.id === parentId)) return false;
        // An ancestor dropped into its own descendant would detach the
        // whole branch from the tree; refused with no side effects.
        if (groupSubtreeIds(s.groups, id).includes(parentId)) return false;
      }
      commit((s2) => {
        const g = s2.groups.find((x) => x.id === id);
        if (!g) return {};
        // Moved to the end of the array, which the tree walk reads as "last
        // among its new siblings" — the same place a dropped tab lands.
        const rest = s2.groups.filter((x) => x.id !== id);
        return { groups: [...rest, { ...g, parentId: parentId ?? undefined }] };
      });
      return true;
    },

    moveGroupBefore: (id, beforeId) => {
      const s = get();
      const moving = s.groups.find((g) => g.id === id);
      const target = s.groups.find((g) => g.id === beforeId);
      if (!moving || !target || id === beforeId) return false;
      if (moving.preset !== undefined) return false;
      // Adopting the target's level must not put a group inside its own
      // subtree.
      if (
        target.parentId !== undefined &&
        groupSubtreeIds(s.groups, id).includes(target.parentId)
      )
        return false;
      commit((s2) => {
        const g = s2.groups.find((x) => x.id === id);
        const t = s2.groups.find((x) => x.id === beforeId);
        if (!g || !t) return {};
        const rest = s2.groups.filter((x) => x.id !== id);
        let at = rest.findIndex((x) => x.id === beforeId);
        // Presets lead the array and the restore normalizer re-asserts it,
        // so a root-level reorder that landed in front of them would only
        // hold until the next launch. Clamped to right after them instead.
        if (t.parentId === undefined) {
          at = Math.max(at, rest.filter((x) => x.preset !== undefined).length);
        }
        return {
          groups: [
            ...rest.slice(0, at),
            { ...g, parentId: t.parentId },
            ...rest.slice(at),
          ],
        };
      });
      return true;
    },

    pinTab: (id) =>
      commit((s) => {
        const t = s.tabs.find((x) => x.id === id);
        if (!t) return {};
        if (t.type === "browser" && t.url) {
          return {
            tabs: s.tabs.map((x) =>
              x.id === id ? { ...x, pinnedUrl: x.url } : x
            ),
            menu: null,
          };
        }
        if (t.type === "files") {
          const live = s.filesOpenDir[id] ?? t.cwd;
          if (!live) return {};
          return {
            tabs: s.tabs.map((x) =>
              x.id === id ? { ...x, cwd: live } : x
            ),
            menu: null,
          };
        }
        return {};
      }),

    setArchiveThreshold: (threshold) => {
      const previous = get().archiveThreshold;
      set({ archiveThreshold: threshold });
      writeSetting(CONFIG_KEYS.archiveAfter, threshold, previous);
    },

    setArchiveOpen: (open) => set({ archiveOpen: open }),
    // The two record panels share one floating slot on screen, so opening
    // either puts the other away rather than stacking a window on a window.
    setHistoryOpen: (open) =>
      set((s) => ({
        historyOpen: open,
        downloadsOpen: open ? false : s.downloadsOpen,
      })),
    setDownloadsOpen: (open) =>
      set((s) => ({
        downloadsOpen: open,
        historyOpen: open ? false : s.historyOpen,
      })),
    setBackgroundTasks: (backgroundTasks) => set({ backgroundTasks }),
    attachBackgroundTask: (task) => {
      const id = get().addTab({
        type: "terminal",
        cwd: task.cwd ?? undefined,
        attachSessionId: task.id,
        title: TYPE_TITLES.terminal,
      });
      set({
        backgroundTasks: get().backgroundTasks.filter((item) => item.id !== task.id),
      });
      return id;
    },

    runArchiveScan: (now = Date.now()) => {
      const threshold = get().archiveThreshold;
      // Null is the configuration file not having been read yet. Shelving
      // somebody's tabs on a guess about how long "untouched" means is the
      // one thing this scan must never do, so it simply does not run until
      // the setting has arrived.
      if (threshold === null || threshold === "off") return;
      const limit = ARCHIVE_THRESHOLD_MS[threshold];
      const stale = (s: AppStore) => {
        const spared = new Set(splitPartners(s));
        return s.tabs.filter(
          (t) =>
            t.groupId === null &&
            archivableByState(t) &&
            t.id !== s.activeTabId &&
            !spared.has(t.id) &&
            now - (t.lastActiveAt ?? now) > limit &&
            (t.type !== "terminal" ||
              t.exited === true ||
              t.lastOutputAt === undefined ||
              now - t.lastOutputAt > limit)
        );
      };
      // Checked before committing: a scan that shelves nothing must cost
      // nothing — not even a rewrite of the saved session.
      if (stale(get()).length === 0) return;
      let shelvedAny = false;
      commit((s) => {
        const doomed = stale(s);
        if (doomed.length === 0) return {};
        shelvedAny = true;
        const goneIds = new Set(doomed.map((t) => t.id));
        const { kept, evicted } = evictBeyondLimit([
          ...s.archive,
          ...doomed.map((t) => archiveEntryOf(t, now)),
        ]);
        return {
          tabs: s.tabs.filter((t) => !goneIds.has(t.id)),
          archive: kept,
          archiveEvicted: s.archiveEvicted + evicted,
        };
      });
      if (!shelvedAny) return;
      saveArchive(get().archive);
    },

    archiveAllToday: (now = Date.now()) => {
      let shelvedAny = false;
      commit((s) => {
        const doomed = s.tabs.filter(
          (t) => t.groupId === null && archivableByState(t)
        );
        if (doomed.length === 0) return {};
        shelvedAny = true;
        const goneIds = new Set(doomed.map((t) => t.id));
        let activeTabId = s.activeTabId;
        if (activeTabId !== null && goneIds.has(activeTabId)) {
          // Nearest in drawing order, like closing a tab: the raw array
          // could hand focus to a row hidden in a collapsed group — and a
          // dormant row has no pane to hand focus to.
          const drawn = visibleOrdered(s.tabs, s.groups).filter(
            (t) => t.dormant !== true
          );
          const vIdx = drawn.findIndex((t) => t.id === activeTabId);
          const left = drawn.filter((t) => !goneIds.has(t.id));
          const neighbor =
            vIdx >= 0 ? left[Math.min(vIdx, left.length - 1)] : left[left.length - 1];
          activeTabId = neighbor ? neighbor.id : null;
        }
        const { kept, evicted } = evictBeyondLimit([
          ...s.archive,
          ...doomed.map((t) => archiveEntryOf(t, now)),
        ]);
        return {
          tabs: s.tabs.filter((t) => !goneIds.has(t.id)),
          activeTabId,
          archive: kept,
          archiveEvicted: s.archiveEvicted + evicted,
        };
      });
      if (!shelvedAny) return;
      saveArchive(get().archive);
    },

    archiveTabs: (ids, now = Date.now()) => {
      const wanted = new Set(ids);
      let shelvedAny = false;
      let archived = 0;
      let skipped: string[] = [];
      commit((s) => {
        const shelfable = (t: Tab) =>
          t.groupId === null && archivableByState(t);
        const doomed = s.tabs.filter((t) => wanted.has(t.id) && shelfable(t));
        skipped = s.tabs
          .filter((t) => wanted.has(t.id) && !shelfable(t))
          .map((t) => t.title);
        if (doomed.length === 0) return {};
        shelvedAny = true;
        archived = doomed.length;
        // The rest is archiveAllToday's own motion, scoped to the picking:
        // the active tab goes only after activation is handed to its
        // nearest survivor, and the shelf's limit and eviction report
        // count these entries like any others.
        const goneIds = new Set(doomed.map((t) => t.id));
        let activeTabId = s.activeTabId;
        if (activeTabId !== null && goneIds.has(activeTabId)) {
          const drawn = visibleOrdered(s.tabs, s.groups).filter(
            (t) => t.dormant !== true
          );
          const vIdx = drawn.findIndex((t) => t.id === activeTabId);
          const left = drawn.filter((t) => !goneIds.has(t.id));
          const neighbor =
            vIdx >= 0 ? left[Math.min(vIdx, left.length - 1)] : left[left.length - 1];
          activeTabId = neighbor ? neighbor.id : null;
        }
        const { kept, evicted } = evictBeyondLimit([
          ...s.archive,
          ...doomed.map((t) => archiveEntryOf(t, now)),
        ]);
        return {
          tabs: s.tabs.filter((t) => !goneIds.has(t.id)),
          activeTabId,
          archive: kept,
          archiveEvicted: s.archiveEvicted + evicted,
        };
      });
      if (shelvedAny) saveArchive(get().archive);
      // Same as the batch close: the picking has done its job.
      get().clearSelection();
      return { archived, skipped };
    },

    restoreArchive: async () => {
      // A fresh run must neither show nor touch the real archive.
      if (freshRun) return;
      const data = await loadState<Array<Record<string, unknown>>>(ARCHIVE_SCOPE);
      if (!Array.isArray(data)) return;
      const entries = data.flatMap((e): ArchiveEntry[] => {
        if (!e || typeof e.archivedAt !== "number") return [];
        if (
          typeof e.id === "string" &&
          typeof e.type === "string" &&
          (["terminal", "files", "browser"] as string[]).includes(e.type)
        ) {
          return [
            {
              id: e.id,
              type: e.type as TabType,
              title: typeof e.title === "string" ? e.title : "",
              cwd: typeof e.cwd === "string" ? e.cwd : undefined,
              url: typeof e.url === "string" ? e.url : undefined,
              archivedAt: e.archivedAt,
            },
          ];
        }
        if (typeof e.url === "string") {
          return [
            {
              id: crypto.randomUUID(),
              type: "browser",
              title: typeof e.title === "string" ? e.title : "",
              url: e.url,
              archivedAt: e.archivedAt,
            },
          ];
        }
        return [];
      });
      // A persisted file longer than the limit (an older build wrote more)
      // is trimmed on arrival; those entries count toward the eviction
      // report like any other, so the panel's line never understates by
      // exactly the run's oldest losses.
      const droppedAtRestore = Math.max(0, entries.length - ARCHIVE_LIMIT);
      set((s) => ({
        archive: entries.slice(-ARCHIVE_LIMIT),
        archiveEvicted: s.archiveEvicted + droppedAtRestore,
      }));
    },

    unarchiveEntry: (index) => {
      const entry = get().archive[index];
      if (!entry) return null;
      set((s) => ({ archive: s.archive.filter((_, i) => i !== index) }));
      saveArchive(get().archive);
      return get().addTab({
        id: entry.id,
        type: entry.type,
        title: entry.title || undefined,
        cwd: entry.cwd,
        url: entry.url,
        groupId: null,
      });
    },

    removeArchiveEntry: (index) => {
      const entry = get().archive[index];
      if (entry) dropTabState([entry.id]);
      set((s) => ({ archive: s.archive.filter((_, i) => i !== index) }));
      saveArchive(get().archive);
    },

    clearArchive: () => {
      dropTabState(get().archive.map((e) => e.id));
      set({ archive: [] });
      saveArchive([]);
    },

    setNewTabMenu: (open) => set({ newTabMenuOpen: open, menu: null }),
    setJoinDialog: (open) =>
      set({ joinDialogOpen: open, newTabMenuOpen: false, menu: null }),
    setShareDialogTab: (tabId) => set({ shareDialogTabId: tabId, menu: null }),
    setSwitcher: (open) => set({ switcherOpen: open, menu: null }),
    setCommandBar: (open) => set({ commandBarOpen: open, menu: null }),
    setShortcutsHelp: (open) => set({ shortcutsHelpOpen: open, menu: null }),
    initConfig: async () => {
      let snap: ConfigSnapshot;
      try {
        snap = await configGet();
      } catch (e) {
        // No desktop core to ask: the browser demo has no configuration
        // file, which is a normal state and not something to put a banner
        // on screen about.
        if (e === NO_CONFIG_BACKEND) return;
        // Everything else is a file the user has to be told about. The
        // rejection IS the located error — path, line, column, source line
        // and caret — so it is kept whole rather than summarized: this is
        // the one place where the raw text is the copy, because a caret
        // under column 13 is what makes the mistake findable.
        const text = errorText(e);
        set((s) => ({
          configError: text,
          configWarnings: [],
          configWarningsDismissed: false,
          configPath: configErrorPath(text),
          // The layout floor: a file that will not parse leaves the six
          // settings null, and null sidebar fields collapse the layout —
          // the grid falls back to its stylesheet column and the pinned
          // toggle cannot survive a write that must fail. The file is still
          // refused loudly above; these two fields just get working values
          // so the app stays usable while the user fixes it. Width and
          // pinning are self-healing too: the first successful drag or
          // toggle after the file is fixed writes real values over these.
          sidebarPinned: s.sidebarPinned === null ? true : s.sidebarPinned,
          sidebarWidth: s.sidebarWidth === null ? 248 : s.sidebarWidth,
        }));
        coreLog("error", "config_get failed; running on values from no file");
        return;
      }
      // The metadata table beside the values: what to draw, and — the part
      // this milestone needs — the numeric bounds the sidebar's drag has to
      // respect. Its own failure is not the file's failure, so it is asked
      // for separately and costs at most a log line.
      const schema = await configSchema().catch((e) => {
        if (e !== NO_CONFIG_BACKEND) {
          coreLog("error", `config_schema failed: ${String(e)}`);
        }
        return [];
      });
      const slice = configSlice(snap.values);
      set((s) => ({
        ...slice,
        // The theme's one derived value has to move with it, or the file's
        // preference would sit in the store while the screen kept the
        // colour the cold-start snapshot resolved to.
        ...themeFanOut(slice.themePreference, s.systemDark),
        configError: null,
        configWarnings: snap.warnings,
        configWarningsDismissed: false,
        // A load re-reads the whole file, so the store and the file agree
        // again whatever an earlier write failed to do — and a notice about
        // a change that has since been re-read is a notice about nothing.
        configWriteErrors: [],
        sidebarWidthRange:
          numberRange(schema, CONFIG_KEYS.sidebarWidth) ?? s.sidebarWidthRange,
        configPath:
          snap.sources[snap.sources.length - 1] ??
          snap.warnings[0]?.path ??
          null,
      }));
      const moved = await migrateSettingsIntoConfig(snap);
      // What was just moved into the file applies to this run too, so a
      // migrating user does not watch their sidebar width reset and come
      // back only after a restart.
      if (Object.keys(moved).length > 0) {
        set((s) => ({
          ...moved,
          ...themeFanOut(
            moved.themePreference ?? s.themePreference,
            s.systemDark
          ),
        }));
      }
    },

    dismissConfigWarnings: () => set({ configWarningsDismissed: true }),
    dismissConfigWriteErrors: () => set({ configWriteErrors: [] }),

    setSearchEngine: (engine, template) => {
      // Both fields read before either is written: the engine and the
      // template are two keys in the file and fail independently, so each
      // carries the value it alone has to be put back to.
      const before = get();
      set((s) => ({
        searchEngine: engine,
        customSearchTemplate: template ?? s.customSearchTemplate,
      }));
      writeSetting(CONFIG_KEYS.searchEngine, engine, before.searchEngine);
      if (template !== undefined) {
        writeSetting(
          CONFIG_KEYS.customSearchTemplate,
          template,
          before.customSearchTemplate
        );
      }
    },
    setThemePreference: (p) => {
      const previous = get().themePreference;
      set((s) => ({
        themePreference: p,
        resolvedTheme: resolveTheme(p, s.systemDark),
      }));
      writeSetting(CONFIG_KEYS.theme, p, previous);
      persistThemePreference(p);
    },
    onSystemTheme: (dark) =>
      set((s) => ({
        systemDark: dark,
        ...themeFanOut(s.themePreference, dark),
      })),
    openSidebarMenu: (x, y, zone = "pinned") =>
      set({ sidebarMenu: { x, y, zone }, menu: null, groupMenu: null }),
    closeSidebarMenu: () => set({ sidebarMenu: null }),
    openGroupMenu: (groupId, x, y) =>
      set({ groupMenu: { groupId, x, y }, menu: null, sidebarMenu: null }),
    closeGroupMenu: () => set({ groupMenu: null }),
    setFolderPreview: (groupId) =>
      set((s) =>
        groupId === null
          ? {
              folderPreviewGroupId: null,
              folderPreviewPendingGroupId: null,
              ...(s.sidebarPeeking ? {} : { pageFreeze: null }),
            }
          : { folderPreviewGroupId: groupId, folderPreviewPendingGroupId: null }
      ),
    setFolderPreviewPending: (groupId) =>
      set({ folderPreviewPendingGroupId: groupId }),
    setPageFreeze: (freeze) => set({ pageFreeze: freeze }),
    setAuthRequest: (req) => set({ authRequest: req }),
    setPageDialog: (dialog) => set({ pageDialog: dialog }),
    setUnloadConfirm: (req) => set({ unloadConfirm: req }),
    setUserscriptAsk: (ask) => set({ userscriptAsk: ask }),
    addScriptCommand: (tabId, cmd) =>
      set((s) => {
        const existing = s.scriptCommands[tabId] ?? [];
        // A script re-registering the same command id replaces it rather
        // than stacking a duplicate.
        const kept = existing.filter(
          (c) => !(c.scriptId === cmd.scriptId && c.cmdId === cmd.cmdId)
        );
        return {
          scriptCommands: { ...s.scriptCommands, [tabId]: [...kept, cmd] },
        };
      }),
    clearScriptCommands: (tabId) =>
      set((s) => {
        if (!(tabId in s.scriptCommands)) return {};
        const next = { ...s.scriptCommands };
        delete next[tabId];
        return { scriptCommands: next };
      }),
    setTabAudible: (tabId, audible) =>
      set((s) => {
        if (!!s.audibleTabs[tabId] === audible) return {};
        const next = { ...s.audibleTabs };
        if (audible) next[tabId] = true;
        else delete next[tabId];
        return { audibleTabs: next };
      }),
    setTabMuted: (tabId, muted) =>
      set((s) => {
        if (!!s.mutedTabs[tabId] === muted) return {};
        const next = { ...s.mutedTabs };
        if (muted) next[tabId] = true;
        else delete next[tabId];
        return { mutedTabs: next };
      }),
    openMenu: (tabId, x, y) => set({ menu: { tabId, x, y }, groupMenu: null }),
    closeMenu: () => set({ menu: null }),

    setTabTermId: (id, termId) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, termId } : t)),
      })),

    // Persisted, so a restored terminal reopens where it was left and a
    // restored browser tab returns to the page you were actually on.
    setTabCwd: (id, cwd) =>
      commit((s) => ({
        tabs: s.tabs.map((t) => (t.id === id && t.cwd !== cwd ? { ...t, cwd } : t)),
      })),

    setTabUrl: (id, url) =>
      commit((s) => ({
        tabs: s.tabs.map((t) => (t.id === id && t.url !== url ? { ...t, url } : t)),
      })),

    setTabShare: (id, share) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, share } : t)),
      })),

    setAppShare: (share) => set({ appShare: share }),

    // Presence is the one writer of the app-level roster, exactly as it is
    // for a tab's: an empty answer for a share that is not live keeps the
    // event's ordering from creating a roster out of thin air.
    setAppShareViewers: (viewers) =>
      set((s) => (s.appShare ? { appShare: { ...s.appShare, viewers } } : {})),

    setAppSharePanel: (open) => set({ appSharePanelOpen: open, menu: null }),

    setShareViewersByTab: (tabId, viewers) =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId && t.share
            ? { ...t, share: { ...t.share, viewers } }
            : t
        ),
      })),

    setRemoteViewers: (id, viewers) =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, remoteViewers: viewers } : t
        ),
      })),

    restoreSession: async () => {
      const loaded = await loadStateResult<PersistedState>(SESSION_SCOPE);
      if (loaded.kind !== "value") {
        set({ sessionRestoreResult: loaded.kind });
        return false;
      }
      const data = loaded.value;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        set({ sessionRestoreResult: "invalid-shape" });
        return false;
      }
      if (data.version !== 1) {
        set({ sessionRestoreResult: "unsupported-version" });
        return false;
      }
      if (!Array.isArray(data.tabs)) {
        set({ sessionRestoreResult: "invalid-shape" });
        return false;
      }
      if (data.tabs.length === 0) {
        set({ sessionRestoreResult: "empty-tabs" });
        return false;
      }
      const tabs: Tab[] = data.tabs.map((t) => ({
        id: t.id,
        type: t.type,
        title: t.title,
        groupId: t.groupId ?? null,
        cwd: t.cwd,
        url: t.url,
        renamed: t.renamed,
        pinnedUrl: t.pinnedUrl,
        dormant: t.dormant,
        // A v1 session carries no activity clock; stamping the restore
        // moment starts it now, instead of an absent value reading as
        // "idle forever" and shelving yesterday's whole session at boot.
        lastActiveAt: t.lastActiveAt ?? Date.now(),
        // A stored layout is data somebody could have edited by hand, so it
        // is validated rather than trusted: anything that is not a tree of
        // two or more distinctly identified panes comes back as no tree,
        // which is a single terminal — the behaviour that predates panes.
        ...paneFields(t.type === "terminal" ? readPaneTree(t.panes) : null),
      }));
      const groups = sanitizeGroupTree(
        withPresetGroups(
          (Array.isArray(data.groups) ? data.groups : []).map(hydrateGroup)
        )
      );
      const filed =
        data.zones !== undefined
          ? tabs
          : tabs.map((t) => {
              if (!t.groupId) return t;
              const g = groups.find((x) => x.id === t.groupId);
              if (!g || g.preset === undefined) return t;
              if (t.type === "browser" && t.pinnedUrl !== undefined) return t;
              return { ...t, groupId: null };
            });
      const payloaded =
        data.zones === 3
          ? filed
          : filed.map((t) =>
              t.groupId !== null &&
              t.type === "browser" &&
              t.pinnedUrl === undefined &&
              t.url !== undefined
                ? { ...t, pinnedUrl: t.url }
                : t
            );
      const savedSplit: SplitGroup | null =
        data.split && Array.isArray(data.split.ids)
          ? {
              ids: data.split.ids.filter((x): x is string => typeof x === "string"),
              ratios: Array.isArray(data.split.ratios) ? data.split.ratios : [],
              vertical: data.split.vertical === true,
            }
          : data.splitPair &&
              typeof data.splitPair.leftId === "string" &&
              typeof data.splitPair.rightId === "string"
            ? {
                ids: [data.splitPair.leftId, data.splitPair.rightId],
                ratios:
                  typeof data.splitPair.ratio === "number"
                    ? [data.splitPair.ratio, 1 - data.splitPair.ratio]
                    : [0.5, 0.5],
                vertical: false,
              }
            : null;
      const restoredDormant = payloaded.map((t) =>
        "dormant" in t && t.dormant === true ? { ...t, dormant: true as const } : t
      );
      const wokenActive =
        typeof data.activeTabId === "string"
          ? restoredDormant.map((t) =>
              t.id === data.activeTabId ? wakeTab(t) : t
            )
          : restoredDormant;
      const split = validSplit(savedSplit, wokenActive);
      // The front seat: the saved active tab whenever it survived the wire
      // (dormant rows included — a sleeping row is still the chosen row,
      // and the woken case above is the one that shows a pane at boot);
      // otherwise the first awake tab, and nobody when everything sleeps.
      const active =
        wokenActive.find((t) => t.id === data.activeTabId)?.id ??
        wokenActive.find((t) => t.dormant !== true)?.id ??
        null;
      set({
        tabs: wokenActive,
        groups,
        activeTabId: active,
        split,
        sessionRestoreResult: "restored",
      });
      return true;
    },
  };
}

/**
 * The app's own store: the one instance the UI talks to. The
 * `createAppStore` factory above exists so a second store can be built for
 * comparison — the app-share determinism tests run the same action sequence
 * through two independent instances and diff them (state/mirrorActions).
 */
export const useStore = create<AppStore>()(
  (set, get) => createAppStore(set as StoreSetter, get as StoreGetter)
);

export function sidebarShowing(s: AppStore): boolean {
  return (
    s.sidebarPinned ||
    s.sidebarPeeking ||
    s.sidebarMenu !== null ||
    s.menu !== null ||
    s.groupMenu !== null ||
    s.folderPreviewGroupId !== null
  );
}

export const FOLDER_PREVIEW_WIDTH = 300;

export function contentObstructionX(
  s: Pick<
    AppStore,
    | "sidebarPinned"
    | "sidebarPeeking"
    | "sidebarWidth"
    | "folderPreviewGroupId"
    | "pageFreeze"
  >
): number {
  if (s.pageFreeze !== null) return 0;
  if (s.folderPreviewGroupId === null) return 0;
  // An open panel's fallback: the floating sidebar's width (the slot begins
  // past a pinned sidebar, so BrowserView's r.left cancels that part there)
  // plus the panel reaching past the sidebar's right edge.
  // No width yet means no sidebar has been drawn, so nothing of it reaches
  // over the page and there is nothing for the page to give up.
  if (s.sidebarWidth === null) return FOLDER_PREVIEW_WIDTH;
  return s.sidebarWidth + FOLDER_PREVIEW_WIDTH;
}

/**
 * The groups the sidebar starts drawing from: no parent, or a parent that
 * no longer exists — a dangling link degrades to the top level rather than
 * to a group nothing can reach. Structural on purpose: the join page's
 * app shell feeds its minimal wire shapes through the same walk, so both
 * sides draw one tree or neither.
 */
/**
 * A group's id plus every descendant's, depth-first. Cycle-safe: corrupt
 * parent links must cost at worst a wrong order, never a hang.
 */
export function groupSubtreeIds(groups: Group[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (gid: string) => {
    if (seen.has(gid)) return;
    seen.add(gid);
    out.push(gid);
    for (const c of groups) if (c.parentId === gid) walk(c.id);
  };
  walk(id);
  return out;
}

function subtreeEarnsItsKeep(
  groups: Group[],
  tabs: Array<{ groupId: string | null }>,
  id: string
): boolean {
  return groupSubtreeIds(groups, id).some((gid) => {
    const g = groups.find((x) => x.id === gid);
    return g?.keepWhenEmpty === true || tabs.some((t) => t.groupId === gid);
  });
}

/**
 * Repair a restored tree so every group can be reached from a root: preset
 * groups are forced back to the top level, and a group whose parent chain
 * never reaches a root (a cycle in a corrupt file) is cut loose to the top
 * rather than left hiding its tabs forever. Exported for the app-share
 * mirror, which restores a host snapshot's groups through the same chain.
 */
export function sanitizeGroupTree(groups: Group[]): Group[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const reachesRoot = (g: Group): boolean => {
    const seen = new Set<string>([g.id]);
    let cur: Group | undefined = g;
    while (cur?.parentId !== undefined) {
      if (seen.has(cur.parentId)) return false;
      seen.add(cur.parentId);
      cur = byId.get(cur.parentId);
      if (!cur) return true; // dangling parent: rootGroups treats it as root
    }
    return true;
  };
  return groups.map((g) => {
    if (g.parentId === undefined) return g;
    if (g.preset !== undefined || !reachesRoot(g)) {
      return { ...g, parentId: undefined };
    }
    return g;
  });
}

export function visibleOrdered(
  tabs: Tab[],
  groups: Group[],
  split?: SplitGroup | null
): Tab[] {
  const out: Tab[] = [];
  const visited = new Set<string>();
  const walk = (g: Group, hidden: boolean) => {
    if (visited.has(g.id)) return; // a corrupt cycle must not hang the walk
    visited.add(g.id);
    // Collapse hides through any number of levels — but the walk still has
    // to pass through, or the rescue below would mistake "hidden by an
    // ancestor" for "unreachable" and resurrect every collapsed member.
    const hide = hidden || g.collapsed;
    for (const c of groups) if (c.parentId === g.id) walk(c, hide);
    out.push(
      ...tabs.filter(
        (t) => t.groupId === g.id && (!hide || t.dormant !== true)
      )
    );
  };
  for (const g of rootGroups(groups)) walk(g, false);
  // Tabs filed under a group the walk never reached (a stale id, or a cycle
  // it refused to enter) still exist; dropping them from this order would
  // make them unreachable from the keyboard.
  const stranded = tabs.filter(
    (t) => t.groupId !== null && !visited.has(t.groupId)
  );
  const today = tabs.filter((t) => !t.groupId && t.peek !== true);
  const all = [...out, ...stranded, ...today];
  const valid = validSplit(split, tabs);
  if (valid === null) return all;
  const merged = new Set(valid.ids.slice(1));
  return all.filter((t) => !merged.has(t.id));
}

/**
 * Whether a pointer at `x` is past the sidebar's right edge, for the two
 * settles that close a peeking sidebar (the document mousemove settle and
 * the page's left-edge exit report).
 *
 * A width that has not arrived decides nothing: with no width there is no
 * edge to have passed. Treating "unknown" as "past it" — the merge-era
 * reading, when the width moved from the session blob (always a number)
 * into the configuration file (null until read) — closed a peeking
 * sidebar the moment the settings had not loaded, and the panel snapped
 * back before it had finished sliding in. An absent x (the page could not
 * report one) decides nothing either, for the same reason: the settle
 * stays quiet until it can compare against a real width, and the
 * sidebar's own mouseleave ends the hover when the pointer really leaves.
 */
export function pointerPastSidebar(
  x: number | null | undefined,
  width: number | null
): boolean {
  if (typeof x !== "number" || width === null) return false;
  return x > width + 8;
}
