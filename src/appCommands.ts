import { confirmChoose } from "./components/Confirm";
import { runFileCloseClaim } from "./components/files/fileCloseKey";
import { leaves } from "./paneTree";
import { configGet, terminalBackgroundTasksOf } from "./state/config";
import { useStore, type Tab } from "./state/store";
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

export function closeTabAsking(tabId: string): void {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.id === tabId);
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (isTauri && tab?.type === "terminal" && tab.busy === true) {
    void (async () => {
      let backgroundTasksOn = false;
      try {
        backgroundTasksOn =
          terminalBackgroundTasksOf((await configGet()).values) === true;
      } catch {
        // A missing configuration answer means the opt-in was not proved.
        // Preserve today's stop-on-close behavior.
      }
      if (!shouldAskBeforeClosingBusyTerminal(tab, backgroundTasksOn, true)) {
        useStore.getState().closeTab(tabId);
        return;
      }
      const choice = await confirmChoose(
        STR.term.backgroundCloseAsk({ title: tab.title }),
        [
          {
            label: STR.term.backgroundKeepRunning,
            value: "background",
          },
          {
            label: STR.term.backgroundStopTask,
            value: "stop",
            danger: true,
          },
        ]
      );
      if (choice === "stop") {
        useStore.getState().closeTab(tabId);
      } else if (choice === "background") {
        if (await detachTerminalTab(tab)) {
          useStore.getState().closeTab(tabId);
        } else {
          await confirmChoose(STR.term.backgroundDetachFailed, [
            { label: STR.common.dismiss, value: "dismiss" },
          ]);
        }
      }
    })();
    return;
  }
  if (!isTauri || tab?.type !== "browser" || !tab.url || tab.dormant === true) {
    st.closeTab(tabId);
    return;
  }
  void (async () => {
    let settled = false;
    const finish = (dirty: boolean) => {
      if (settled) return;
      settled = true;
      stop?.();
      if (dirty) useStore.getState().setUnloadConfirm({ tabId, title: tab.title });
      else useStore.getState().closeTab(tabId);
    };
    let stop: (() => void) | null = null;
    const { listen } = await import("@tauri-apps/api/event");
    stop = await listen<{ tabId: string; dirty: boolean }>(
      "browser-unload-answer",
      (e) => {
        if (e.payload.tabId === tabId) finish(e.payload.dirty);
      }
    );
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_ask_unload", { tabId }).catch(() => finish(false));
    window.setTimeout(() => finish(false), 700);
  })();
}

/** Bridge the native routes — the menu, and a page reporting a key — in. */
export async function listenToMenuCommands(): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ cmd: string; from: CommandSource }>("app-command", (e) => {
    runAppCommand(e.payload.cmd as AppCommand, e.payload.from);
  });
}
