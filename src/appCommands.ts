import { confirmChoose } from "./components/Confirm";
import { runFileCloseClaim } from "./components/files/fileCloseKey";
import { leaves } from "./paneTree";
import { configGet, terminalBackgroundTasksOf } from "./state/config";
import { groupSubtreeIds, useStore, type Tab } from "./state/store";
import { STR } from "./strings";
import { stopAppShare } from "./share/framework/actions";
import { coreLog } from "./errlog";
import { getPaneTerm, getTerm, type TermApi } from "./termRegistry";

/**
 * One name per user-facing action, whether it arrives from a menu key
 * equivalent or from a plain window keydown.
 *
 * Both routes exist because they reach different places. A keydown only ever
 * reaches the UI's own webview, so it is dead while a browser tab's page has
 * focus; a menu key equivalent is offered to the application before any view
 * sees the event, so it works everywhere — but menus are macOS-only here.
 */
export type AppCommand =
  | "new-terminal"
  | "new-files"
  | "new-browser"
  | "new-tab-menu"
  | "duplicate-tab"
  | "reopen-closed"
  | "toggle-sidebar"
  | "join"
  | "close-tab"
  | "switcher"
  | "command-bar"
  | "history-panel"
  | "downloads-panel"
  | "clear-terminal"
  | "split-pane-vertical"
  | "split-pane-horizontal"
  | "focus-pane-dir"
  | "zoom-pane"
  | "resize-pane-dir"
  | "next-tab"
  | "prev-tab"
  | "toggle-pin"
  | "location-bar"
  | "find"
  | "reload"
  | "back"
  | "forward"
  | "open-external"
  | "copy-url"
  | "print"
  | "share-app"
  | "stop-app-share"
  | "go-pinned"
  | "shortcuts-help"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  // ⌘1 … ⌘9
  | `jump-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

type Listener = (cmd: AppCommand) => void;
const listeners = new Set<Listener>();

type Store = ReturnType<typeof useStore.getState>;

const WINDOW_COMMANDS: Partial<Record<AppCommand, (st: Store) => void>> = {
  "new-terminal": (st) => {
    st.addTab({ type: "terminal" });
  },
  "new-files": (st) => {
    // Always a NEW explorer, exactly like ⌘T always opens a new terminal.
    // Focusing an existing one instead made ⌘E look broken: press it with
    // an explorer already open and nothing appears to happen. Two keys in
    // the same family must not answer to two different rules.
    st.addTab({ type: "files" });
  },
  "new-browser": (st) => {
    st.addTab({ type: "browser" });
  },
  "new-tab-menu": (st) => st.setNewTabMenu(true),
  "duplicate-tab": (st) => {
    if (st.activeTabId) st.duplicateTab(st.activeTabId);
  },
  "reopen-closed": (st) => {
    st.reopenClosedTab();
  },
  "toggle-sidebar": (st) => st.toggleSidebar(),
  join: (st) => st.setJoinDialog(true),
  "close-tab": (st) => {
    if (st.peekTabId !== null) {
      st.discardPeek();
      return;
    }
    if (runFileCloseClaim()) return;
    if (st.activeTabId) closeTabAsking(st.activeTabId);
  },
  switcher: (st) => st.setSwitcher(true),
  // A toggle, unlike the switcher: ⌘⇧B with the bar already up is the same
  // hand asking for it to go away, and Esc is not reachable while a browser
  // page holds the keyboard the moment before the bar takes it.
  "command-bar": (st) => st.setCommandBar(!st.commandBarOpen),
  "history-panel": (st) => st.setHistoryOpen(!st.historyOpen),
  // A toggle like the command bar: ⌘/ with the overlay up closes it.
  "shortcuts-help": (st) => st.setShortcutsHelp(!st.shortcutsHelpOpen),
  "downloads-panel": (st) => st.setDownloadsOpen(!st.downloadsOpen),
  "next-tab": (st) => st.cycleTab(1),
  "prev-tab": (st) => st.cycleTab(-1),
  print: (st) => {
    const active = st.tabs.find((t) => t.id === st.activeTabId);
    if (
      !active ||
      active.type !== "browser" ||
      !active.url ||
      active.dormant === true
    )
      return;
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("browser_print", { tabId: active.id }).catch(() => {})
      );
    }
  },
  "share-app": (st) => {
    st.setAppSharePanel(true);
  },
  // Stop when a share is live; with none, nothing to do (like print on a
  // non-browser tab) and the panel goes away either way.
  "stop-app-share": (st) => {
    if (st.appShare) {
      void stopAppShare().catch((e) =>
        coreLog("error", `app_share_stop failed: ${String(e)}`)
      );
    }
    st.setAppSharePanel(false);
  },
  "toggle-pin": (st) => {
    const active = st.tabs.find((t) => t.id === st.activeTabId);
    if (!active) return;
    if (active.groupId) {
      st.assignToGroup(active.id, null);
    } else {
      const preset = st.groups.find((g) => g.preset === active.type);
      if (preset) st.assignToGroup(active.id, preset.id);
    }
  },
};

export function commandRunsAnywhere(cmd: string): boolean {
  return cmd in WINDOW_COMMANDS;
}

/** Subscribe a view to the commands only it can carry out. */
export function onAppCommand(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Where a command came from: a keydown here, a menu item, or a page. */
export type CommandSource = "key" | "menu" | "page";

const lastRun = new Map<AppCommand, { at: number; from: CommandSource }>();

/**
 * Carry out a command: window-level ones here, view-level ones by broadcast.
 *
 * One key press can arrive twice — a page reports it *and* the menu claims it —
 * and opening two tabs for one ⌘T would be a bug. Two presses in quick
 * succession are not: someone opening three terminals presses ⌘T three times
 * as fast as they can. Only a repeat that arrives by a *different* route is an
 * echo, so that is the only one dropped.
 */
export function runAppCommand(
  cmd: AppCommand,
  from: CommandSource = "key"
): void {
  const now = Date.now();
  const prev = lastRun.get(cmd);
  // close-tab is exempt: closing a tab moves the keyboard focus, so two real
  // rapid ⌘W presses legitimately arrive by different routes — for every
  // other command a cross-route repeat this fast is a double delivery, but
  // here it would eat the user's second close.
  if (cmd !== "close-tab" && prev && prev.from !== from && now - prev.at < 300)
    return;
  lastRun.set(cmd, { at: now, from });

  const st = useStore.getState();
  const jump = /^jump-([1-9])$/.exec(cmd);
  if (jump) {
    st.activateIndex(Number(jump[1]) - 1);
    return;
  }
  const handler = WINDOW_COMMANDS[cmd];
  if (handler) {
    handler(st);
    return;
  }
  // Everything left belongs to whichever view is in front.
  listeners.forEach((fn) => fn(cmd));
}

export function shouldAskBeforeClosingBusyTerminal(
  tab: Tab | undefined,
  backgroundTasksOn: boolean,
  isTauri: boolean
): boolean {
  return Boolean(
    isTauri &&
      backgroundTasksOn &&
      tab?.type === "terminal" &&
      tab.busy === true
  );
}

function terminalApisForTab(tab: Tab): TermApi[] {
  if (!tab.panes) {
    const api = getTerm(tab.id);
    return api ? [api] : [];
  }
  const found = leaves(tab.panes)
    .map((paneId) => getPaneTerm(tab.id, paneId))
    .filter((api): api is TermApi => api !== undefined);
  return [...new Set(found)];
}

export async function detachTerminalTab(tab: Tab): Promise<boolean> {
  const apis = terminalApisForTab(tab);
  const expected = tab.panes ? leaves(tab.panes).length : 1;
  if (apis.length !== expected) return false;
  try {
    await Promise.all(apis.map((api) => api.detach()));
    return true;
  } catch {
    return false;
  }
}

// One confirmation queue: concurrent close requests must not replace a
// ConfirmHost question and leave its original promise hanging forever.
let closeQueue = Promise.resolve();
const closingTabs = new Map<string, Promise<void>>();
const closeGenerations = new Map<string, number>();
useStore.subscribe((next, previous) => {
  for (const tab of previous.tabs) {
    const now = next.tabs.find((t) => t.id === tab.id);
    if (
      !now ||
      (now.dormant === true) !== (tab.dormant === true) ||
      now.url !== tab.url ||
      now.cwd !== tab.cwd ||
      now.dirty !== tab.dirty ||
      now.busy !== tab.busy ||
      now.termId !== tab.termId ||
      now.attachSessionId !== tab.attachSessionId ||
      now.share?.shareId !== tab.share?.shareId
    ) {
      closeGenerations.set(tab.id, (closeGenerations.get(tab.id) ?? 0) + 1);
    }
  }
});

export function closeTabAsking(tabId: string, expectedDormant?: boolean): Promise<void> {
  const state = useStore.getState();
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || (expectedDormant !== undefined && (tab.dormant === true) !== expectedDormant)) return Promise.resolve();
  const pending = closingTabs.get(tabId);
  if (pending) return pending;
  const dormant = tab.dormant === true;
  const generation = closeGenerations.get(tabId) ?? 0;
  const stillCurrent = () => {
    const now = useStore.getState().tabs.find((t) => t.id === tabId);
    return now !== undefined && (now.dormant === true) === dormant &&
      (closeGenerations.get(tabId) ?? 0) === generation;
  };
  const finish = () => { if (stillCurrent()) useStore.getState().closeTab(tabId, dormant); };
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const needsGuard = !dormant && (!!tab.dirty || !!tab.busy || !!tab.share ||
    (native && tab.type === "browser" && !!tab.url));
  // Simple closes remain synchronous, preserving rapid Cmd-W and neighbour
  // handoff. The captured state prevents a second delivery becoming remove.
  if (!needsGuard) { finish(); return Promise.resolve(); }
  const task = closeQueue.then(async () => {
    if (!stillCurrent()) return;
    const text = STR.common.sidebar;
    if (native && tab.type === "terminal" && tab.busy) {
      let allowBackground = false;
      try { allowBackground = terminalBackgroundTasksOf((await configGet()).values) === true; } catch { /* No opt-in proof. */ }
      if (!stillCurrent()) return;
      if (allowBackground) {
        const choice = await confirmChoose(STR.term.backgroundCloseAsk({ title: tab.title }), [
          { label: STR.term.backgroundKeepRunning, value: "background" },
          { label: STR.term.backgroundStopTask, value: "stop", danger: true },
        ]);
        if (!stillCurrent()) return;
        if (choice === "stop") finish();
        else if (choice === "background") {
          if (await detachTerminalTab(tab)) finish();
          else await confirmChoose(STR.term.backgroundDetachFailed, [{ label: STR.common.dismiss, value: "dismiss" }]);
        }
        return;
      }
    }
    if (native && tab.type === "browser" && tab.url) {
      const safe = await browserCanClose(tabId);
      if (!stillCurrent()) return;
      if (safe === true && !tab.dirty) { finish(); return; }
      const choice = await confirmChoose(safe === null ? text.closeUnverified : text.closeProtected({ title: tab.title }),
        [{ label: STR.common.close, value: "close", danger: true }]);
      if (choice === "close") finish();
      return;
    }
    const choice = await confirmChoose(text.closeProtected({ title: tab.title }),
      [{ label: STR.common.close, value: "close", danger: true }]);
    if (choice === "close") finish();
  }).catch((error) => coreLog("error", `Close kept tab ${tabId}: ${String(error)}`));
  closingTabs.set(tabId, task);
  closeQueue = task;
  void task.finally(() => { if (closingTabs.get(tabId) === task) closingTabs.delete(tabId); });
  return task;
}

/** null means no trustworthy answer, never implied permission to close. */
async function browserCanClose(tabId: string): Promise<boolean | null> {
  try {
    const [{ listen }, { invoke }] = await Promise.all([
      import("@tauri-apps/api/event"), import("@tauri-apps/api/core"),
    ]);
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let answer!: (value: boolean | null) => void;
    const result = new Promise<boolean | null>((resolve) => { answer = resolve; });
    const finish = (value: boolean | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stop?.(); answer(value);
    };
    stop = await listen<{ tabId: string; dirty: boolean }>("browser-unload-answer", (event) => {
      if (event.payload.tabId === tabId) finish(!event.payload.dirty);
    });
    if (settled) { stop(); return result; }
    timer = setTimeout(() => finish(null), 700);
    void invoke("browser_ask_unload", { tabId }).catch(() => finish(null));
    return await result;
  } catch { return null; }
}

/** Batch intent is captured once, and each runtime gets the same close guard. */
export async function closeTabsAsking(ids: string[]): Promise<void> {
  const targets = [...new Set(ids)].map((id) => ({ id,
    dormant: useStore.getState().tabs.find((t) => t.id === id)?.dormant === true }));
  for (const { id, dormant } of targets) await closeTabAsking(id, dormant);
  useStore.getState().clearSelection();
}

/** Delete a folder only after every contained tab has passed normal close protection. */
export async function deleteGroupAsking(groupId: string): Promise<boolean> {
  const initial = useStore.getState();
  const groupIds = new Set(groupSubtreeIds(initial.groups, groupId));
  const ids = initial.tabs
    .filter((tab) => tab.groupId !== null && groupIds.has(tab.groupId))
    .map((tab) => tab.id);
  for (const id of ids) {
    const before = useStore.getState().tabs.find((tab) => tab.id === id);
    if (!before) continue;
    await closeTabAsking(id, before.dormant === true);
    let current = useStore.getState().tabs.find((tab) => tab.id === id);
    if (current && current.dormant === before.dormant) return false;
    // A live saved tab first becomes dormant. The explicit folder deletion
    // then removes that saved entry without waking it or bypassing its guard.
    if (current?.dormant === true) {
      await closeTabAsking(id, true);
      current = useStore.getState().tabs.find((tab) => tab.id === id);
      if (current) return false;
    }
  }
  const state = useStore.getState();
  if (
    state.tabs.some(
      (tab) => tab.groupId !== null && groupIds.has(tab.groupId)
    )
  ) {
    return false;
  }
  state.deleteGroup(groupId);
  return true;
}

/** Bridge the native routes — the menu, and a page reporting a key — in. */
export async function listenToMenuCommands(): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ cmd: string; from: CommandSource }>("app-command", (e) => {
    runAppCommand(e.payload.cmd as AppCommand, e.payload.from);
  });
}
