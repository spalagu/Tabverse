import { sessionSnapshot, type AppStore, type Tab } from "../../state/store";

export const REMOTE_APP_TAB_KINDS = [
  "terminal",
  "files",
  "browser",
] as const;

export type RemoteAppTabKind = (typeof REMOTE_APP_TAB_KINDS)[number];

const remoteKinds = new Set<string>(REMOTE_APP_TAB_KINDS);

export function isRemoteAppTabKind(kind: unknown): kind is RemoteAppTabKind {
  return typeof kind === "string" && remoteKinds.has(kind);
}

export function isRemoteAppTab(
  tab: Tab | undefined,
): tab is Tab & { readonly type: RemoteAppTabKind } {
  return tab !== undefined && isRemoteAppTabKind(tab.type);
}

function remoteGroupIds(state: Pick<AppStore, "tabs" | "groups">): Set<string> {
  const groups = new Map(state.groups.map((group) => [group.id, group]));
  const keep = new Set<string>();
  for (const tab of state.tabs) {
    if (!isRemoteAppTabKind(tab.type) || tab.groupId === null) continue;
    let groupId: string | undefined = tab.groupId;
    const seen = new Set<string>();
    while (groupId !== undefined && !seen.has(groupId)) {
      seen.add(groupId);
      keep.add(groupId);
      groupId = groups.get(groupId)?.parentId;
    }
  }
  return keep;
}

export function isRemoteAppGroup(state: AppStore, groupId: string): boolean {
  return remoteGroupIds(state).has(groupId);
}

const objectValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** Authoritative webview-side gate for legacy v3 app actions. */
export function isRemoteAppActionAllowed(
  state: AppStore,
  name: string,
  args: unknown,
): boolean {
  const visibleTab = (id: unknown): boolean =>
    typeof id === "string" && isRemoteAppTab(
      state.tabs.find((tab) => tab.id === id),
    );
  switch (name) {
    case "addTab":
      return isRemoteAppTabKind(objectValue(args)?.type);
    case "activateTab":
      return visibleTab(typeof args === "string" ? args : objectValue(args)?.id);
    case "closeTab":
    case "openMenu":
    case "renameTab":
      return visibleTab(
        typeof args === "string"
          ? args
          : objectValue(args)?.tabId ?? objectValue(args)?.id,
      );
    case "splitWith":
      return visibleTab(args) && visibleTab(state.activeTabId);
    case "toggleGroupCollapsed":
      return typeof args === "string" && isRemoteAppGroup(state, args);
    case "setFilesOpenPath":
    case "setFilesOpenDir": {
      const tabId = objectValue(args)?.tabId;
      return typeof tabId === "string" &&
        state.tabs.find((tab) => tab.id === tabId)?.type === "files";
    }
    case "toggleSidebar":
    case "setSidebarPeeking":
    case "unsplit":
    case "closeMenu":
      return true;
    default:
      return false;
  }
}

function filteredStringMap(
  source: Record<string, string>,
  tabIds: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(([tabId]) => tabIds.has(tabId)),
  );
}

/** The only v3 whole-app snapshot allowed onto the wire. */
export function remoteAppSnapshot(state: AppStore): Record<string, unknown> {
  const snapshot = sessionSnapshot(state);
  const groupsToKeep = remoteGroupIds(state);
  const tabs = snapshot.tabs
    .filter((tab) => isRemoteAppTabKind("kind" in tab ? tab.kind : tab.type))
    .map((tab) => ({
      ...tab,
      groupId:
        tab.groupId !== null && groupsToKeep.has(tab.groupId)
          ? tab.groupId
          : null,
    }));
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const groups = snapshot.groups.filter((group) => groupsToKeep.has(group.id));
  const activeTabId =
    snapshot.activeTabId !== null && tabIds.has(snapshot.activeTabId)
      ? snapshot.activeTabId
      : (tabs[0]?.id ?? null);

  const splitPairs = (snapshot.split?.ids ?? []).flatMap((id, index) =>
    tabIds.has(id) ? [{ id, ratio: snapshot.split?.ratios[index] ?? 1 }] : [],
  );
  const ratioTotal = splitPairs.reduce((sum, pair) => sum + pair.ratio, 0);
  const split = splitPairs.length >= 2
    ? {
        ids: splitPairs.map((pair) => pair.id),
        ratios: splitPairs.map((pair) =>
          ratioTotal > 0 ? pair.ratio / ratioTotal : 1 / splitPairs.length,
        ),
        vertical: snapshot.split?.vertical ?? false,
      }
    : undefined;

  return {
    ...snapshot,
    tabs,
    groups,
    activeTabId,
    split,
    filesOpenPath: filteredStringMap(state.filesOpenPath, tabIds),
    filesOpenDir: filteredStringMap(state.filesOpenDir, tabIds),
  };
}
