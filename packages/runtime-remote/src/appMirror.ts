import { create } from "zustand";
import {
  APP_MIRROR_ACTION_NAMES,
  TAB_TYPES,
  isAppMirrorActionName,
  type AppMirrorActionName,
  type TabType,
} from "@tabverse/runtime-contracts";
import type {
  WorkbenchSidebarTreeGroup,
  WorkbenchTabRow,
} from "@tabverse/workbench/sidebar";
import { groupColors } from "@tabverse/workbench/theme";
import type { AppFrameSinks } from "@tabverse/remote-client/app-frame";
import { receiveClip } from "@tabverse/remote-client/clipboard";

export interface RemoteMirrorTab extends WorkbenchTabRow {
  readonly cwd?: string;
  readonly renamed?: boolean;
  readonly lastActiveAt?: number;
}

export interface RemoteMirrorGroup extends WorkbenchSidebarTreeGroup {
  readonly name: string;
  readonly colorIndex: number;
  readonly collapsed: boolean;
  readonly preset?: TabType;
  readonly keepWhenEmpty?: true;
}

export interface RemoteMirrorState {
  readonly tabs: RemoteMirrorTab[];
  readonly groups: RemoteMirrorGroup[];
  readonly activeTabId: string | null;
  readonly filesOpenPath: Record<string, string>;
  readonly filesOpenDir: Record<string, string>;
}

const EMPTY_STATE: RemoteMirrorState = {
  tabs: [],
  groups: [],
  activeTabId: null,
  filesOpenPath: {},
  filesOpenDir: {},
};

const PRESET_GROUPS: ReadonlyArray<{ type: TabType; name: string }> = [
  { type: "terminal", name: "Terminals" },
  { type: "files", name: "Files" },
  { type: "browser", name: "Browser" },
];

/** The Join entry's own mirror store. It contains only host-renderable facts;
 * desktop actions, persistence and native runtime state never enter it. */
export const useRemoteMirrorStore = create<RemoteMirrorState>(() => EMPTY_STATE);

export function resetRemoteMirror(): void {
  useRemoteMirrorStore.setState({
    tabs: [],
    groups: [],
    activeTabId: null,
    filesOpenPath: {},
    filesOpenDir: {},
  });
}

const isTabType = (value: unknown): value is TabType =>
  typeof value === "string" && (TAB_TYPES as readonly string[]).includes(value);

function readTab(raw: unknown): RemoteMirrorTab | null {
  if (typeof raw !== "object" || raw === null) return null;
  const tab = raw as Record<string, unknown>;
  if (typeof tab.id !== "string" || tab.id.length === 0) return null;
  if (!isTabType(tab.type) || typeof tab.title !== "string") return null;
  return {
    id: tab.id,
    type: tab.type,
    title: tab.title,
    groupId: typeof tab.groupId === "string" ? tab.groupId : null,
    cwd: typeof tab.cwd === "string" ? tab.cwd : undefined,
    url: typeof tab.url === "string" ? tab.url : undefined,
    pinnedUrl: typeof tab.pinnedUrl === "string" ? tab.pinnedUrl : undefined,
    renamed: tab.renamed === true ? true : undefined,
    dormant: tab.dormant === true ? true : undefined,
    attention: tab.attention === true ? true : undefined,
    remoteViewers:
      typeof tab.remoteViewers === "number" ? tab.remoteViewers : undefined,
    lastActiveAt:
      typeof tab.lastActiveAt === "number" ? tab.lastActiveAt : Date.now(),
  };
}

const LEGACY_GROUP_PALETTE = groupColors("dark");

function legacyColorIndex(color: string): number {
  const channels = (value: string): [number, number, number] | null => {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
      value.trim(),
    );
    return match
      ? [
          Number.parseInt(match[1], 16),
          Number.parseInt(match[2], 16),
          Number.parseInt(match[3], 16),
        ]
      : null;
  };
  const target = channels(color);
  if (target === null) return 0;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  LEGACY_GROUP_PALETTE.forEach((candidate, index) => {
    const value = channels(candidate);
    if (value === null) return;
    const distance =
      (value[0] - target[0]) ** 2 +
      (value[1] - target[1]) ** 2 +
      (value[2] - target[2]) ** 2;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

function readGroup(raw: unknown): RemoteMirrorGroup | null {
  if (typeof raw !== "object" || raw === null) return null;
  const group = raw as Record<string, unknown>;
  if (
    typeof group.id !== "string" ||
    group.id.length === 0 ||
    typeof group.name !== "string" ||
    typeof group.collapsed !== "boolean"
  ) {
    return null;
  }
  return {
    id: group.id,
    name: group.name,
    collapsed: group.collapsed,
    colorIndex:
      typeof group.colorIndex === "number"
        ? group.colorIndex
        : typeof group.color === "string"
          ? legacyColorIndex(group.color)
          : 0,
    parentId: typeof group.parentId === "string" ? group.parentId : undefined,
    preset: isTabType(group.preset) ? group.preset : undefined,
    keepWhenEmpty: group.keepWhenEmpty === true ? true : undefined,
  };
}

function sanitizeGroupTree(groups: RemoteMirrorGroup[]): RemoteMirrorGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const reachesRoot = (group: RemoteMirrorGroup): boolean => {
    const seen = new Set<string>([group.id]);
    let current: RemoteMirrorGroup | undefined = group;
    while (current?.parentId !== undefined) {
      if (seen.has(current.parentId)) return false;
      seen.add(current.parentId);
      current = byId.get(current.parentId);
      if (current === undefined) return true;
    }
    return true;
  };
  return groups.map((group) =>
    group.parentId !== undefined &&
    (group.preset !== undefined || !reachesRoot(group))
      ? { ...group, parentId: undefined }
      : group,
  );
}

function withPresetGroups(groups: RemoteMirrorGroup[]): RemoteMirrorGroup[] {
  const presets = PRESET_GROUPS.map(({ type, name }, colorIndex) => {
    const id = `preset-${type}`;
    const existing = groups.find(
      (group) => group.preset === type || group.id === id,
    );
    return {
      ...(existing ?? {
        id,
        name,
        colorIndex: colorIndex % LEGACY_GROUP_PALETTE.length,
        collapsed: false,
      }),
      preset: type,
      parentId: undefined,
    } satisfies RemoteMirrorGroup;
  });
  const custom = groups.filter(
    (group) => !presets.some((preset) => preset.id === group.id),
  );
  return [...presets, ...custom];
}

function stringMapForTabs(
  raw: unknown,
  tabs: RemoteMirrorTab[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return out;
  const tabIds = new Set(tabs.map((tab) => tab.id));
  for (const [tabId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (tabIds.has(tabId) && typeof value === "string") out[tabId] = value;
  }
  return out;
}

export function applyMirrorSnapshot(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const snapshot = raw as Record<string, unknown>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.tabs)) return false;
  const tabs = snapshot.tabs
    .map(readTab)
    .filter((tab): tab is RemoteMirrorTab => tab !== null);
  const groups = sanitizeGroupTree(
    withPresetGroups(
      (Array.isArray(snapshot.groups) ? snapshot.groups : [])
        .map(readGroup)
        .filter((group): group is RemoteMirrorGroup => group !== null),
    ),
  );
  const activeTabId =
    typeof snapshot.activeTabId === "string" &&
    tabs.some((tab) => tab.id === snapshot.activeTabId)
      ? snapshot.activeTabId
      : (tabs[0]?.id ?? null);
  useRemoteMirrorStore.setState({
    tabs,
    groups,
    activeTabId,
    filesOpenPath: stringMapForTabs(snapshot.filesOpenPath, tabs),
    filesOpenDir: stringMapForTabs(snapshot.filesOpenDir, tabs),
  });
  return true;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function updateStringMap(
  key: "filesOpenPath" | "filesOpenDir",
  tabId: string,
  value: string | null,
): void {
  useRemoteMirrorStore.setState((state) => {
    const next = { ...state[key] };
    if (value === null) delete next[tabId];
    else next[tabId] = value;
    return { [key]: next } as Pick<RemoteMirrorState, typeof key>;
  });
}

const REMOTE_ACTIONS: Record<AppMirrorActionName, (args: unknown) => void> = {
  addTab: (args) => {
    if (!isObject(args)) return;
    const tab = readTab({ ...args, groupId: args.groupId ?? null });
    if (tab === null) return;
    useRemoteMirrorStore.setState((state) => ({
      tabs: [tab, ...state.tabs.filter((candidate) => candidate.id !== tab.id)],
      activeTabId: tab.id,
    }));
  },
  closeTab: (args) => {
    if (typeof args !== "string") return;
    useRemoteMirrorStore.setState((state) => {
      const closing = state.tabs.find((tab) => tab.id === args);
      if (closing === undefined) return state;
      if (closing.groupId !== null) {
        const tabs = state.tabs.map((tab) =>
          tab.id === args ? { ...tab, dormant: true as const } : tab,
        );
        const nextActive = tabs.find(
          (tab) => tab.id !== args && tab.dormant !== true,
        )?.id;
        return {
          tabs,
          activeTabId:
            state.activeTabId === args ? (nextActive ?? null) : state.activeTabId,
        };
      }
      const index = state.tabs.findIndex((tab) => tab.id === args);
      const tabs = state.tabs.filter((tab) => tab.id !== args);
      const nextActive = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
      return {
        tabs,
        activeTabId:
          state.activeTabId === args ? nextActive : state.activeTabId,
      };
    });
  },
  activateTab: (args) => {
    const id =
      typeof args === "string"
        ? args
        : isObject(args) && typeof args.id === "string"
          ? args.id
          : null;
    if (id === null) return;
    const now =
      isObject(args) && typeof args.now === "number" ? args.now : Date.now();
    useRemoteMirrorStore.setState((state) => ({
      activeTabId: id,
      tabs: state.tabs.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              dormant: undefined,
              attention: undefined,
              lastActiveAt: now,
            }
          : tab,
      ),
    }));
  },
  renameTab: (args) => {
    if (
      !isObject(args) ||
      typeof args.id !== "string" ||
      typeof args.title !== "string"
    ) {
      return;
    }
    useRemoteMirrorStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === args.id
          ? { ...tab, title: args.title as string, renamed: true }
          : tab,
      ),
    }));
  },
  toggleGroupCollapsed: (args) => {
    if (typeof args !== "string") return;
    useRemoteMirrorStore.setState((state) => ({
      groups: state.groups.map((group) =>
        group.id === args ? { ...group, collapsed: !group.collapsed } : group,
      ),
    }));
  },
  setFilesOpenPath: (args) => {
    if (!isObject(args) || typeof args.tabId !== "string") return;
    if (args.path === null || typeof args.path === "string") {
      updateStringMap("filesOpenPath", args.tabId, args.path);
    }
  },
  setFilesOpenDir: (args) => {
    if (!isObject(args) || typeof args.tabId !== "string") return;
    if (args.dir === null || typeof args.dir === "string") {
      updateStringMap("filesOpenDir", args.tabId, args.dir);
    }
  },
  toggleSidebar: () => {},
  setSidebarPeeking: () => {},
  closeMenu: () => {},
  openMenu: () => {},
  splitWith: () => {},
  unsplit: () => {},
};

/** Exposed for the host/remote contract test; the names originate in
 * runtime-contracts and every one has a guarded remote handler. */
export const REMOTE_MIRROR_ACTION_NAMES: readonly AppMirrorActionName[] =
  APP_MIRROR_ACTION_NAMES;

export function applyMirrorAction(name: string, args: unknown): boolean {
  if (!isAppMirrorActionName(name)) return false;
  REMOTE_ACTIONS[name](args);
  return true;
}

export function mirrorSinks(): AppFrameSinks {
  return {
    onSnapshot: (state) => {
      applyMirrorSnapshot(state);
    },
    onAction: (name, args) => {
      applyMirrorAction(name, args);
    },
    onClip: (seq, text) => {
      receiveClip(seq, text);
    },
    onProxy: () => {},
  };
}
