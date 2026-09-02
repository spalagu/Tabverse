import { useEffect, useRef } from "react";
import { installDesktopTabViews } from "./desktopTabViews";

/**
 * One thing the system handed over. Mirrors `Opened` in
 * src-tauri/src/system_open.rs — the core does the sorting, so a new kind
 * added there has to be answered here and nowhere else.
 */
type SystemOpen =
  | { kind: "browser"; url: string }
  | { kind: "terminal"; command: string; cwd: string | null }
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string };
import { Sidebar } from "./components/Sidebar";
import { freezeForSidebarPeek } from "./components/FolderPreview";
import { TabContent } from "./components/TabContent";
import { NewTabMenu } from "./components/NewTabMenu";
import { JoinDialog } from "./components/JoinDialog";
import { AuthDialog } from "./components/AuthDialog";
import { PageDialog } from "./components/PageDialog";
import { UserscriptAsk } from "./components/UserscriptAsk";
import { ShareDialog } from "./components/ShareDialog";
import { AppSharePanel } from "./components/AppSharePanel";
import { Switcher } from "./components/Switcher";
import { CommandBar } from "./components/CommandBar";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { TabMenu } from "./components/TabMenu";
import { SidebarMenu } from "./components/SidebarMenu";
import { GroupMenu } from "./components/GroupMenu";
import { ConfirmHost, confirmChoose } from "./components/Confirm";
import { PassphraseHost } from "./components/Passphrase";
import { SaveTemplateDialog } from "./components/SaveTemplateDialog";
import { PasswordPanel } from "./components/PasswordPanel";
import { ArchivePanel } from "./components/ArchivePanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { DownloadsPanel } from "./components/DownloadsPanel";
import { useGlobalKeys } from "./keys";
import { listenToMenuCommands } from "./appCommands";
import { initDownloads } from "./downloads";
import { loadZoomMemory } from "./zoomMemory";
import { coreLog } from "./errlog";
import { flushAll } from "./persist";
import { flushConfigWrites } from "./state/config";
import {
  detachResidentForAppExit,
  reconcileResidentRemoteTabs,
  reconcileResidentTerminalTabs,
  residentTakeoverFailures,
  takeOverResidentRuntimes,
} from "./residentRuntime";
import {
  recoverOrInitializeSession,
  type SessionRecoveryOutcome,
} from "./sessionRecovery";
import type { ShareAccess } from "./share/framework/capability";
import { applySharePresence } from "./share/framework/actions";
import { STR } from "./strings";
import { initTheme } from "./theme/themeController";
import {
  startUiPlane,
} from "./uiPlane";
import {
  markFreshRun,
  sweepOrphanTabState,
  sidebarShowing,
  useStore,
  type PageDialog as PageDialogState,
  pointerPastSidebar,
} from "./state/store";
import { bootMirrorBroadcast } from "./state/mirrorBroadcast";
import { applyMirrorAction } from "./state/mirrorActions";
import { desktopPluginComposition } from "./pluginComposition";
import {
  createContributionBridge,
  type ContributionAckEvent,
  type ContributionIntentEvent,
  type ContributionResnapshotEvent,
  type ContributionSnapshotRequestEvent,
} from "./share/framework/contributionBridge";
import {
  isRemoteAppActionAllowed,
  remoteAppSnapshot,
} from "./share/framework/remoteBoundary";
import { fsApi } from "./backend/fs";
import { getTerm } from "./termRegistry";

type PageDialogKind = PageDialogState["kind"];

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function DesktopApp() {
  useGlobalKeys();
  // Startup effects that open tabs must wait until recovery has decided whether session.json is
  // absent or must be preserved, otherwise any one could write over a broken
  // existing session before the recovery dialog appears.
  const sessionBoot = useRef<Promise<SessionRecoveryOutcome> | null>(null);
  const resolveSessionBoot = useRef<
    ((outcome: SessionRecoveryOutcome) => void) | null
  >(null);
  if (sessionBoot.current === null) {
    sessionBoot.current = new Promise<SessionRecoveryOutcome>((resolve) => {
      resolveSessionBoot.current = resolve;
    });
  }

  const showing = useStore(sidebarShowing);

  const sidebarPeeking = useStore((s) => s.sidebarPeeking);
  const activeTabId = useStore((s) => s.activeTabId);

  useEffect(() => {
    // A child WKWebView and the main WKWebView can both contribute native
    // cursor updates while they overlap on macOS. Freeze the Browser page
    // before the auto-hidden sidebar floats over it, so only the main
    // WebView participates in pointer hit testing during the overlay.
    if (!isTauri || !sidebarPeeking) return;
    void freezeForSidebarPeek();
  }, [sidebarPeeking, activeTabId]);

  useEffect(() => startUiPlane(), []);

  useEffect(() => {
    if (!isTauri || activeTabId === null) return;
    const st = useStore.getState();
    const active = st.tabs.find((t) => t.id === activeTabId);
    if (!active || active.type !== "browser" || active.url === undefined) return;
    let cancelled = false;
    const warm = window.setTimeout(() => {
      if (cancelled) return;
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("browser_snapshot", { tabId: active.id }).catch(() => {})
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(warm);
    };
  }, [activeTabId]);
  // Serialised: two of these are independent async calls, and the one sent
  // first can land second — which left the buttons showing after a request
  // to hide them.
  const buttonQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!isTauri) return;
    buttonQueue.current = buttonQueue.current
      .then(() => import("@tauri-apps/api/core"))
      .then(({ invoke }) =>
        invoke("window_buttons", { visible: showing }).then(() =>
          // AppKit can rebuild the titlebar button layout when visibility
          // changes. Reapply after that native mutation, otherwise the
          // hover-peek path can leave the traffic lights at the old origin.
          invoke("traffic_light_reapply")
        )
      )
      .catch(() => {});
  }, [showing]);

  // The settle: a menu opening under the pointer consumes the sidebar's
  // own mouseleave, so after the menu closes nothing would ever tell it to
  // go. Any pointer position clearly past its right edge does.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = useStore.getState();
      if (st.sidebarPinned || !st.sidebarPeeking) return;
      if (st.sidebarMenu || st.menu || st.groupMenu || st.folderPreviewGroupId)
        return;
      // An unread width decides nothing (see pointerPastSidebar): the
      // settle stays quiet rather than closing a sidebar it cannot yet
      // place. The sidebar's own mouseleave still ends the hover when the
      // pointer really leaves.
      if (pointerPastSidebar(e.clientX, st.sidebarWidth))
        st.setSidebarPeeking(false);
    };
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, []);

  // What only the page can see: a press inside it (which must dismiss our
  // menus, since no DOM event ever fires there) and the pointer reaching
  // its left edge (which is where an unpinned sidebar is summoned from).
  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{
        kind: string;
        tabId?: string;
        x?: number | null;
      }>(
        "browser-pointer",
        (e) => {
        const st = useStore.getState();
        if (e.payload.kind === "page-press") {
          st.closeSidebarMenu();
          st.closeMenu();
          st.closeGroupMenu();
          const sp = st.split;
          const pressed = e.payload.tabId;
          if (
            sp !== null &&
            pressed !== undefined &&
            pressed !== st.activeTabId &&
            st.activeTabId !== null &&
            sp.ids.includes(pressed) &&
            sp.ids.includes(st.activeTabId)
          ) {
            st.activateTab(pressed);
          }
        } else if (e.payload.kind === "page-corner") {
          const sp = st.split;
          const who = e.payload.tabId;
          if (
            who !== undefined &&
            sp !== null &&
            sp.ids.includes(who) &&
            st.activeTabId !== null &&
            sp.ids.includes(st.activeTabId)
          ) {
            st.setPaneHover(who);
          }
        } else if (e.payload.kind === "page-left-edge" && !st.sidebarPinned) {
          st.setSidebarPeeking(true);
        } else if (e.payload.kind === "page-left-edge-exit") {
          // The same settle, for the one surface our own mousemove never
          // reaches. "Left the 10px strip" is NOT "left the sidebar": the
          // strip is only where the sidebar is summoned from, and hiding on
          // that crossing made the sidebar disappear as soon as the pointer
          // moved onto it (2026-08-12 feedback 1). The pointer's own x decides,
          // against the same width the mouse settle above uses.
          // The same rule as the settle above: an unread width decides
          // nothing. This event fires while the pointer is still inside the
          // page's left strip — on its way to the sidebar, not away from
          // it — so "unknown width" closing the sidebar was the snap-back
          // a hand crossing from the page felt.
          if (
            pointerPastSidebar(e.payload.x, st.sidebarWidth) &&
            !st.sidebarMenu &&
            !st.menu &&
            !st.groupMenu &&
            !st.folderPreviewGroupId
          ) {
            st.setSidebarPeeking(false);
          }
        }
      }).then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      })
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  // The menu's key equivalents are the only shortcuts that reach us while a
  // browser tab's page holds the keyboard.
  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void listenToMenuCommands().then((fn) => {
      if (cancelled) fn();
      else stop = fn;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    return bootMirrorBroadcast(useStore);
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    void Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]).then(async ([{ invoke }, { listen }]) => {
      const bridge = createContributionBridge({
        composition: desktopPluginComposition(),
        invoke: (command, args) => invoke(command, args),
        executeIntent: async (tabId, name, payload) => {
          if (name === "terminal.input") {
            const terminal = getTerm(tabId);
            if (terminal === undefined) throw new Error("terminal is not attached");
            terminal.write(payload as string);
            return null;
          }
          if (name === "files.open") {
            useStore.getState().setFilesOpenPath(
              tabId,
              (payload as { path: string }).path,
            );
            return null;
          }
          if (name === "files.write") {
            const write = payload as { path: string; content: string };
            await fsApi.write(write.path, write.content);
            return null;
          }
          if (name === "browser.navigate") {
            useStore.getState().setTabUrl(
              tabId,
              (payload as { url: string }).url,
            );
            return null;
          }
          throw new Error(`unsupported remote intent: ${name}`);
        },
        reportError: (message) =>
          coreLog("error", `contribution bridge failed: ${message}`),
      });
      const sync = () => {
        const state = useStore.getState();
        const selected = state.appShare === null
          ? state.tabs.filter((tab) => tab.share !== undefined)
          : state.tabs;
        const tabs = selected.map((tab) =>
          tab.type === "files"
            ? {
                ...tab,
                openPath: state.filesOpenPath[tab.id],
                cwd: state.filesOpenDir[tab.id] ?? tab.cwd,
              }
            : tab,
        );
        if (tabs.length === 0) return bridge.clear();
        return bridge.sync(tabs, state.activeTabId);
      };
      const stopStore = useStore.subscribe((state, previous) => {
        if (
          state.appShare !== previous.appShare ||
          state.tabs !== previous.tabs ||
          state.filesOpenPath !== previous.filesOpenPath ||
          state.filesOpenDir !== previous.filesOpenDir ||
          state.activeTabId !== previous.activeTabId
        ) {
          void sync().catch(() => {});
        }
      });
      if (useStore.getState().appShare !== null) await sync();
      const stopSnapshot = await listen("app-share-snapshot-request", () => {
        const state = useStore.getState();
        void bridge
          .sync(state.tabs, state.activeTabId)
          .then(() => bridge.snapshotAll())
          .then(() =>
            invoke("app_share_snapshot_deliver", {
              snapshot: remoteAppSnapshot(useStore.getState()),
            }),
          )
          .catch((e) =>
            coreLog("error", `app_share_snapshot_deliver failed: ${e}`),
          );
      });
      const stopIntent = await listen<ContributionIntentEvent>(
        "app-share-remote-intent",
        (event) => {
          void bridge.handleIntent(event.payload).catch(() => {});
        },
      );
      const stopTabSnapshot = await listen<ContributionSnapshotRequestEvent>(
        "tab-share-contribution-snapshot-request",
        (event) => {
          const state = useStore.getState();
          const tab = state.tabs.find((candidate) => candidate.id === event.payload.tabId);
          if (tab === undefined || tab.share === undefined) return;
          void sync()
            .then(() => bridge.snapshotTab(event.payload.tabId, event.payload.viewer))
            .catch(() => {});
        },
      );
      const stopAck = await listen<ContributionAckEvent>(
        "app-share-remote-ack",
        (event) => {
          void bridge.handleAck(event.payload).catch(() => {});
        },
      );
      const stopResnapshot = await listen<ContributionResnapshotEvent>(
        "app-share-remote-resnapshot",
        (event) => {
          void bridge.handleResnapshot(event.payload).catch(() => {});
        },
      );
      if (cancelled) {
        stopStore();
        stopSnapshot();
        stopIntent();
        stopTabSnapshot();
        stopAck();
        stopResnapshot();
        await bridge.dispose();
      } else {
        cleanup = () => {
          stopStore();
          stopSnapshot();
          stopIntent();
          stopTabSnapshot();
          stopAck();
          stopResnapshot();
          void bridge.dispose();
        };
      }
    }).catch((e) => coreLog("error", `contribution bridge setup failed: ${e}`));
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ name: string; args: unknown }>("app-share-action", (e) => {
        if (!isRemoteAppActionAllowed(
          useStore.getState(),
          e.payload.name,
          e.payload.args,
        )) {
          coreLog("warn", `app-share action dropped at remote boundary: ${e.payload.name}`);
          return;
        }
        const applied = applyMirrorAction(e.payload.name, e.payload.args);
        if (!applied) {
          coreLog(
            "warn",
            `app-share action dropped, not whitelisted: ${e.payload.name}`
          );
        }
      }).then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      })
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    void import("./share/framework/appTermBridge").then((m) =>
      m.bootAppTermBridge()
    );
  }, []);
  /**
   * Something the system asked us to open: a double-clicked file, a clicked
   * link, a script, a folder.
   *
   * Two channels, and both are needed. The event covers everything that
   * arrives while the app is already up. The drain covers the cold-start case
   * — the open that *launched* the app reaches the core before this listener
   * exists, so the core holds it until asked. Draining first also flips the
   * core over to broadcast-only, which is what keeps an item from being
   * handled twice.
   */
  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;

    const receive = async (items: SystemOpen[]) => {
      if ((await sessionBoot.current) === "preserved" || cancelled) return;
      const st = useStore.getState();
      for (const item of items) {
        switch (item.kind) {
          case "browser":
            st.addTab({ type: "browser", url: item.url });
            break;
          case "terminal":
            st.addTab({
              type: "terminal",
              cwd: item.cwd ?? undefined,
              runOnStart: item.command || undefined,
            });
            break;
          case "file":
            // The file itself, not just the folder around it — see Tab.openPath.
            st.addTab({ type: "files", openPath: item.path });
            break;
          case "folder":
            st.addTab({ type: "files", cwd: item.path });
            break;
        }
      }
    };

    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const buffered = await invoke<SystemOpen[]>("system_open_drain").catch(
        () => [] as SystemOpen[]
      );
      if (cancelled) return;
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<SystemOpen[]>("system-open", (e) =>
        void receive(e.payload)
      );
      if (cancelled) unlisten();
      else stop = unlisten;
      // After the listener is attached, so an open that lands in between is
      // caught by one of the two rather than falling between them.
      void receive(buffered);
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ url: string }>("browser-open-tab", (e) => {
        void (async () => {
          if ((await sessionBoot.current) !== "preserved" && !cancelled && e.payload.url) {
            useStore.getState().addTab({ type: "browser", url: e.payload.url });
          }
        })();
      }).then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      })
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ tabId: string; url: string }>("browser-open-peek", async (e) => {
        if (!e.payload.url) return;
        const st = useStore.getState();
        if (st.peekTabId !== null) {
          if (e.payload.tabId !== st.activeTabId) {
            coreLog("info", "peek request from a background tab dropped");
            return;
          }
          st.discardPeek();
        }
        const baseId = useStore.getState().activeTabId;
        const base = st.tabs.find((t) => t.id === baseId);
        if (baseId && base?.type === "browser" && base.url) {
          // The page under the scrim is parked behind its own still frame on
          // every desktop platform. This keeps the host and child webviews
          // from competing for native cursor ownership while the peek layer
          // is active, and gives the scrim the same pixels on every OS.
          const { freezeActivePage } = await import(
            "./components/FolderPreview"
          );
          await freezeActivePage(
            baseId,
            () => useStore.getState().activeTabId === baseId
          );
        }
        useStore.getState().openPeek({ type: "browser", url: e.payload.url });
      }).then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      })
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ tabId: string }>("browser-peek-escape", (e) => {
        const st = useStore.getState();
        if (st.peekTabId !== null && e.payload.tabId === st.peekTabId) {
          st.discardPeek();
        }
      }).then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      })
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{
        dialogId: number;
        kind: PageDialogKind;
        origin: string;
        message: string;
        defaultText: string;
      }>("browser-dialog", (e) => {
        useStore.getState().setPageDialog(e.payload);
      }).then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      })
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ tabId: string; audible: boolean }>("browser-media", (e) => {
        useStore.getState().setTabAudible(e.payload.tabId, e.payload.audible);
      }).then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      })
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{
        challengeId: number;
        host: string;
        realm: string;
        failedUsername?: string | null;
      }>("browser-auth-request", (e) => {
        useStore.getState().setAuthRequest(e.payload);
      }).then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      })
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    const unsubs: Array<() => void> = [];
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<{
        askId: number;
        scriptId: string;
        scriptName: string;
        host: string;
      }>("userscript-xhr-ask", (e) => {
        useStore.getState().setUserscriptAsk(e.payload);
      }).then((fn) => (cancelled ? fn() : unsubs.push(fn)));
      void listen<{
        tabId: string;
        scriptId: string;
        cmdId: number;
        name: string;
      }>("userscript-menu", (e) => {
        useStore.getState().addScriptCommand(e.payload.tabId, {
          scriptId: e.payload.scriptId,
          cmdId: e.payload.cmdId,
          name: e.payload.name,
        });
      }).then((fn) => (cancelled ? fn() : unsubs.push(fn)));
      void listen<{ tabId: string }>("userscript-menu-reset", (e) => {
        useStore.getState().clearScriptCommands(e.payload.tabId);
      }).then((fn) => (cancelled ? fn() : unsubs.push(fn)));
    });
    return () => {
      cancelled = true;
      unsubs.forEach((f) => f());
    };
  }, []);

  const menuOpen = useStore((s) => s.newTabMenuOpen);

  useEffect(() => {
    let scanCancelled = false;
    let scanTimer: number | null = null;
    const boot = async (fresh: boolean): Promise<SessionRecoveryOutcome> => {
      let outcome: SessionRecoveryOutcome = "preserved";
      try {
        const st = useStore.getState();
        if (fresh) markFreshRun();
        await initTheme();
        await st.initConfig();
        if (st.tabs.length === 0) {
          outcome = await recoverOrInitializeSession({
            fresh,
            restore: async () => {
              const restored = await st.restoreSession();
              return restored
                ? "restored"
                : (useStore.getState().sessionRestoreResult ?? "read-failed");
            },
            initialize: () => {
              // This is the one explicit transition from “preserve the
              // unusable file” to “replace it with a new session”.
              useStore.setState({ sessionRestoreResult: "missing" });
              st.addTab({ type: "terminal" });
            },
            ask: async (reason) =>
              (await confirmChoose(STR.dialogs.sessionRecovery.problem({ reason }), [
                {
                  label: STR.dialogs.sessionRecovery.initialize,
                  value: "initialize",
                  danger: true,
                },
              ])) === "initialize",
          });
        } else {
          outcome = "restored";
        }
        if (isTauri && outcome !== "preserved") {
          try {
            const residentReplays = await takeOverResidentRuntimes();
            reconcileResidentRemoteTabs(residentReplays);
            await reconcileResidentTerminalTabs(residentReplays);
            for (const failure of residentTakeoverFailures()) {
              coreLog(
                "warn",
                `resident takeover failed for ${failure.runtime.runtimeId}: ${String(failure.error)}`,
              );
            }
          } catch (error) {
            // First run and installations without a Supervisor are normal.
            // A failed takeover must never make session recovery unusable.
            coreLog("warn", `resident takeover unavailable: ${String(error)}`);
          }
        }
        // A preserved session has no trustworthy live-tab list. Do not let
        // orphan sweeping erase its per-tab files while recovery is pending.
        if (outcome !== "preserved") void sweepOrphanTabState();
        return outcome;
      } finally {
        resolveSessionBoot.current?.(outcome);
      }
    };
    const startArchiveScans = async () => {
      await useStore.getState().restoreArchive();
      if (scanCancelled) return;
      useStore.getState().runArchiveScan();
      scanTimer = window.setInterval(
        () => useStore.getState().runArchiveScan(),
        10 * 60 * 1000
      );
    };
    const stopArchiveScans = () => {
      scanCancelled = true;
      if (scanTimer !== null) window.clearInterval(scanTimer);
    };
    if (!isTauri) {
      // The browser demo keeps the ?fresh URL hook — it has no env to read.
      const fresh =
        import.meta.env.DEV &&
        new URLSearchParams(window.location.search).has("fresh");
      void boot(fresh).then(
        (outcome) => {
          if (outcome === "preserved") return;
          void startArchiveScans();
          // After boot on purpose: whether this run is fresh is settled
          // there, and the ledger's zero-trace rule reads that answer.
          initDownloads();
          void loadZoomMemory();
        }
      );
      return stopArchiveScans;
    }
    void boot(false).then((outcome) => {
      if (outcome === "preserved") return;
      void startArchiveScans();
      initDownloads();
      void loadZoomMemory();
    });
    return stopArchiveScans;
  }, []);

  useEffect(() => {
    // Teardown backstop, both platforms: the browser demo has no close
    // request to intercept, and on the desktop some exits skip the window
    // close path entirely (macOS ⌘Q quits the app directly) — flush whatever
    // the page's death still lets through.
    // Both doorways: the state scopes and the configuration file. Settings
    // writes are debounced for the same reason saves are (a dragged sidebar
    // edge is one gesture, not forty writes), so the last change before a
    // quit needs the same flush the session gets.
    const onHide = () => void Promise.all([flushAll(), flushConfigWrites()]);
    window.addEventListener("pagehide", onHide);
    if (!isTauri) return () => window.removeEventListener("pagehide", onHide);
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let closing = false;
    let resolvingClose = false;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      void win
        .onCloseRequested((e) => {
          if (closing) return; // already prepared and flushed; let it through
          e.preventDefault();
          if (resolvingClose) return;
          resolvingClose = true;
          void (async () => {
            try {
              // Only the Supervisor may own work beyond GUI lifetime. Kill
              // every legacy helper session; resident sessions use separate
              // worker endpoints and are detached below.
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("term_helper_kill_all");
              closing = true;
              await Promise.race([
                Promise.all([
                  flushAll(),
                  flushConfigWrites(),
                  detachResidentForAppExit(),
                ]),
                new Promise((resolve) => setTimeout(resolve, 1500)),
              ]);
              await win.destroy();
            } catch {
              resolvingClose = false;
              await confirmChoose(STR.term.backgroundQuitFailed, [
                { label: STR.common.dismiss, value: "dismiss" },
              ]);
            }
          })();
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        });
    });
    return () => {
      window.removeEventListener("pagehide", onHide);
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // The helper is the sole truth for sessions that outlive a tab or this
  // process. Refresh once on startup, then only on helper lifecycle events —
  // no timer polls and no session.json copy to reconcile.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const refresh = async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const tasks = await invoke<
        Array<{
          id: number[];
          generation: number;
          cwd: string | null;
          exited: number | null;
          attached: boolean;
        }>
      >("term_helper_list");
      if (cancelled) return;
      useStore.getState().setBackgroundTasks(
        tasks
          .filter((task) => !task.attached)
          .map((task) => ({
            ...task,
            id: task.id.map((byte) => byte.toString(16).padStart(2, "0")).join(""),
          }))
      );
    };
    void refresh().catch(() => {});
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("background-tasks-changed", () => void refresh().catch(() => {})).then(
        (stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        }
      )
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Host-side presence updates for shared tabs.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{
        tabId: string;
        viewers: { id: number; name: string; access: ShareAccess }[];
      }>(
        "share-presence",
        (e) => {
          applySharePresence(e.payload.tabId, e.payload.viewers);
        }
      ).then((fn) => {
        unlisten = fn;
      });
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const sidebarPinned = useStore((s) => s.sidebarPinned);
  const passwordsOpen = useStore((s) => s.passwordsOpen);
  const setPasswordsOpen = useStore((s) => s.setPasswordsOpen);
  const archiveOpen = useStore((s) => s.archiveOpen);
  const setArchiveOpen = useStore((s) => s.setArchiveOpen);
  const historyOpen = useStore((s) => s.historyOpen);
  const setHistoryOpen = useStore((s) => s.setHistoryOpen);
  const downloadsOpen = useStore((s) => s.downloadsOpen);
  const setDownloadsOpen = useStore((s) => s.setDownloadsOpen);
  return (
    <div
      className="app"
      style={{
        // Unpinned, the sidebar floats over the content instead of
        // holding a column — the column is what makes it "pinned".
        // Undefined — not a number — while either answer is missing: the
        // stylesheet's own .row rule then lays the grid out, instead of this
        // overriding it with a width nobody has said yet. Once the settings
        // are read this takes over, as it always has.
        gridTemplateColumns:
          sidebarPinned === null || sidebarWidth === null
            ? undefined
            : `${sidebarPinned ? sidebarWidth : 0}px 1fr`,
      }}
    >
      <ConfirmHost />
      <PassphraseHost />
      <SaveTemplateDialog />
      {passwordsOpen && (
        <PasswordPanel onClose={() => setPasswordsOpen(false)} />
      )}
      {archiveOpen && <ArchivePanel onClose={() => setArchiveOpen(false)} />}
      {historyOpen && <HistoryPanel onClose={() => setHistoryOpen(false)} />}
      {downloadsOpen && (
        <DownloadsPanel onClose={() => setDownloadsOpen(false)} />
      )}
      {/* The strip that calls an unpinned sidebar back. */}
      {!sidebarPinned && (
        <div
          className="sidebar-peek-zone"
          onMouseEnter={() => useStore.getState().setSidebarPeeking(true)}
        />
      )}
      <Sidebar />
      <TabContent />
      {menuOpen && <NewTabMenu />}
      <JoinDialog />
      <AuthDialog />
      <PageDialog />
      <UserscriptAsk />
      <ShareDialog />
      <AppSharePanel />
      <Switcher />
      <CommandBar />
      <ShortcutsOverlay />
      <TabMenu />
      <SidebarMenu />
      <GroupMenu />
    </div>
  );
}

installDesktopTabViews();

export default function App() {
  return <DesktopApp />;
}
