import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ansiErrorLines, describeError } from "../strings/errors";
import { STR } from "../strings";
import { formatKeys } from "../strings/formatKeys";
import { keysFor } from "../shortcuts";
import { onAppCommand } from "../appCommands";
import { onLocalKeys, terminalKeyAction } from "../localKeys";
import { backend } from "../backend";
import {
  sendTerminalShareSnapshot,
  type TermHandle,
} from "@tabverse/runtime-desktop/terminal";
import { b64encode } from "../backend/b64";
import { fsApi } from "../backend/fs";
import { coreLog } from "../errlog";
import { deleteState, flushAll, loadState, saveState } from "../persist";
import { notifyCommandFinished } from "../notify";
import {
  openDirectoryInFilesPane,
  openTerminalLink,
} from "../term/links";
import { type TerminalLink } from "@tabverse/workbench/terminal/links";
import { BlockTracker, type Block } from "@tabverse/workbench/terminal/blocks";
import {
  BlockDecorations,
  rulerYToBufferLine,
} from "@tabverse/workbench/terminal/decorations";
import {
  InputLine,
  type CompletionOffer,
  type CompletionSpec,
} from "@tabverse/workbench/terminal/completion";
import { loadCompletionSpec } from "../term/completionSpec";
import { installMacKeyConventions } from "@tabverse/workbench/terminal/keys";
import {
  confirmedPaste,
  countLines,
  guardPaste,
  type PasteGuardPorts,
} from "@tabverse/workbench/terminal/paste-guard";
import { createTerminalPathLinkProvider } from "@tabverse/workbench/terminal/path-links";
import { createWorkspaceTerminal } from "@tabverse/workbench/terminal/create-workspace-terminal";
import { handleTerminalCompletionKey } from "@tabverse/workbench/terminal/completion-keys";
import { shortHost } from "@tabverse/workbench/terminal/remote-state";
import {
  applyTerminalFont,
  subscribeTerminalFont,
  terminalFont,
  terminalLigatures,
  waitForTerminalFonts,
  xtermFontOptions,
} from "@tabverse/workbench/terminal/font";
import { registerTerm, unregisterTerm, getPaneTerm } from "../termRegistry";
import { profileBadgeVar, terminalTheme, themeColors } from "../theme/tokens";
import { findLeaf, paneCount, leaves, type PaneId } from "../paneTree";
import { terminalImageMemoryMb, terminalPasteGuard } from "../state/config";
import { useStore, type Tab } from "../state/store";
import {
  TerminalBlockStatusPill as BlockStatusPill,
} from "@tabverse/workbench/terminal/block-status-pill";
import {
  TerminalCompletionPopup as CompletionPopup,
} from "@tabverse/workbench/terminal/completion-popup";
import { SearchBar } from "./terminal/SearchBar";
import { TerminalWorkspacePane } from "@tabverse/workbench/terminal/workspace-pane";
import { useProfiles } from "./useProfiles";
import {
  readTermMemory,
  spawnCwd,
  termScope,
} from "@tabverse/workbench/terminal/session-memory";
import { createTerminalSessionMemoryController } from "@tabverse/workbench/terminal/session-memory-controller";
import { createTerminalViewportController } from "@tabverse/workbench/terminal/viewport-controller";
import {
  splitTerminalTransferDestination,
  useTerminalFileTransfer,
} from "@tabverse/workbench/terminal/file-transfer";
import { installTerminalInputController } from "@tabverse/workbench/terminal/input-controller";
import { createTerminalShareSnapshotController } from "@tabverse/workbench/terminal/share-snapshot-controller";
import { installTerminalOutputController } from "@tabverse/workbench/terminal/output-controller";
import { createTerminalSpawnController } from "@tabverse/workbench/terminal/spawn-controller";
import { createTerminalBlockController } from "@tabverse/workbench/terminal/block-controller";
import { runTerminalCleanup } from "@tabverse/workbench/terminal/cleanup-controller";
import { installTerminalSessionRegistration } from "@tabverse/workbench/terminal/session-registration";
import {
  broadcastTerminalInput,
  navigateTerminalBlock,
  runTerminalWorkspaceAction,
} from "@tabverse/workbench/terminal/workspace-controller";


interface Props {
  tab: Tab;
  active: boolean;
  paneId?: PaneId;
}

interface TermInstance {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  blocks: BlockTracker;
  decorations: BlockDecorations;
  handle: TermHandle | null;
  disposed: boolean;
  /** The one-shot command from a system open has already been sent. */
  ranHandover: boolean;
  ligatures: boolean;
  /**
   * Measure the grid again and tell the shell its new size — the mount
   * effect's Workbench viewport controller, kept here so the font effect
   * below can reach it. A new font means new cell metrics and therefore a
   * different number of columns in the same pixels; it does not mean a
   * different shell.
   */
  refit: () => void;
  /** The same viewer cap `refit` honours, set from outside: the app
   * share's bridge applies its joint viewport here, tab-share events
   * apply theirs through the `share-viewport` listener. */
  setViewerCap: (viewport: { cols: number; rows: number } | null) => void;
}

/** The non-empty profile name this tab was opened under, if it has one. */
function tabProfile(tab: Tab): string | undefined {
  return typeof tab.profile === "string" && tab.profile !== ""
    ? tab.profile
    : undefined;
}

const providePathLinks = createTerminalPathLinkProvider({
  exists: async (absolutePath) => {
    try {
      await fsApi.read(absolutePath);
      return true;
    } catch {
      return false;
    }
  },
  open: openTerminalLink,
});

export function TerminalView({ tab, active, paneId }: Props) {
  // The pane this instance IS, as one value with no absent case. An
  // un-split tab's terminal is the pane wearing the tab's id, which is why
  // every key derived from this reads the same before and after a tree
  // grows around it — and why the mount effect below does not re-run when
  // ⌘D hands this same instance a `paneId` for the first time.
  const paneKey = paneId ?? tab.id;
  const paneRef = useRef(paneKey);
  paneRef.current = paneKey;
  // Which profile's font this terminal draws with, held in a ref because
  // both the mount effect and the font effect read it and neither may be
  // re-run merely because it was read again.
  const profileRef = useRef(tabProfile(tab));
  profileRef.current = tabProfile(tab);
  // Whether the keyboard is HERE, as against merely in this tab: with
  // several panes only one of them answers keys and holds the caret, while
  // "the tab is in front" still decides whether a finished command is worth
  // a notification (the user can see every pane of the tab they are on).
  const focused =
    active && (tab.panes === undefined || tab.activePaneId === paneKey);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const containerRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<TermInstance | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<Block | null>(null);
  const [running, setRunning] = useState<Block | null>(null);
  const [copied, setCopied] = useState<"cmd" | "out" | null>(null);
  const [spawning, setSpawning] = useState(true);
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const [hoverTarget, setHoverTarget] = useState<TerminalLink | null>(null);
  const [remoteHost, setRemoteHost] = useState<string | null>(null);
  const remoteHostRef = useRef<string | null>(null);
  remoteHostRef.current = remoteHost;
  // A working directory the FAR side reported while this pane was remote
  // (OSC 7 during the running ssh block — the local shell is blocked inside
  // it, so any report is the remote's). Prefills the upload destination;
  // null when the remote never said.
  const [remoteCwd, setRemoteCwd] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [pasteAsk, setPasteAsk] = useState<string | null>(null);
  const pastePortsRef = useRef<PasteGuardPorts | null>(null);
  const [completion, setCompletion] = useState<{
    offer: CompletionOffer;
    sel: number;
  } | null>(null);
  // The listener runs outside React's render cycle; the ref is the truth it
  // reads, kept in step with the state by assignment on every render.
  const completionRef = useRef(completion);
  completionRef.current = completion;
  // The keystroke channel the popup's pick sends through — sendKeys, held
  // the same way the paste routes hold it (see pastePortsRef).
  const typingRef = useRef<((data: string) => void) | null>(null);
  // The line model the popup's click-side pick feeds, held the same way:
  // the model itself lives in the mount effect, the click handler above it.
  const inputLineRef = useRef<InputLine | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Mount once per PANE; the terminal is kept alive across tab switches —
  // and across the tab growing or losing a pane tree around it, which is
  // why the dependency is `paneKey` and not `paneId`.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || instRef.current) return;

    const scope = termScope(tab.id, paneKey);
    const memoryLoad = loadState<unknown>(scope)
      .then(readTermMemory)
      .catch(() => null);

    const ligatures = terminalLigatures(profileRef.current) === true;

    let blocks!: BlockTracker;
    const { term, fit, search, serialize } = createWorkspaceTerminal({
      container: el,
      theme: terminalTheme(useStore.getState().resolvedTheme),
      fontOptions:
        xtermFontOptions(terminalFont(profileRef.current), 0, ligatures) ??
        undefined,
      ligatures,
      imageMemoryMb: terminalImageMemoryMb(),
      providePathLinks,
      currentCwd: () => blocks?.currentCwd ?? null,
      openLink: openTerminalLink,
      setHover: (text, link) => {
        setHoverLink(text);
        setHoverTarget(link);
      },
    });

    const onDomPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const ports = pastePortsRef.current;
      if (text !== "" && ports !== null) guardPaste(text, ports);
    };
    el.addEventListener("paste", onDomPaste, true);

    const inputLine = new InputLine();
    inputLineRef.current = inputLine;
    let spec: CompletionSpec | null = null;
    void loadCompletionSpec().then((s) => {
      spec = s;
    });
    const onCompletionKeys = (event: KeyboardEvent) => {
      handleTerminalCompletionKey(event, {
        current: () => completionRef.current,
        update: setCompletion,
        inputLine,
        type: (data) => typingRef.current?.(data),
      });
    };
    el.addEventListener("keydown", onCompletionKeys, true);

    const decorations = new BlockDecorations(term, () => ({
      danger: themeColors(useStore.getState().resolvedTheme).danger,
    }));

    const blockController = createTerminalBlockController({
      createTracker: (events) => new BlockTracker(term, events),
      decorations,
      setRunning,
      setSelected: setSelectedBlock,
      setRemoteHost,
      setRemoteCwd,
      setTabRemote: (target) =>
        useStore.getState().setTabRemote(tab.id, target),
      setPaneBusy: (busy) =>
        useStore.getState().setPaneBusy(tab.id, paneRef.current, busy),
      setPaneCwd: (cwd) =>
        useStore.getState().setPaneCwd(tab.id, paneRef.current, cwd),
      active: () => activeRef.current,
      documentFocused: () => document.hasFocus(),
      notifyFinished: (block, durationMs) =>
        notifyCommandFinished(
          tab.title,
          block.command,
          block.exitCode,
          durationMs
        ),
      setAttention: () => useStore.getState().setAttention(tab.id, true),
    });
    blocks = blockController.tracker;

    const inst: TermInstance = {
      term,
      fit,
      search,
      serialize,
      blocks,
      decorations,
      handle: null,
      disposed: false,
      ranHandover: false,
      ligatures,
      // Replaced with the real measurement below, once it exists.
      refit: () => {},
      setViewerCap: () => {},
    };
    instRef.current = inst;

    // The Workbench owns transcript restore and save cadence. The desktop host
    // only supplies persistence and platform lifecycle events.
    const memoryController = createTerminalSessionMemoryController({
      load: memoryLoad,
      serialize: (options) => serialize.serialize(options),
      cwd: () => blocks.currentCwd,
      cols: () => term.cols,
      write: (data, callback) => term.write(data, callback),
      save: (memory) => saveState(scope, memory),
      remove: () => deleteState(scope),
      flush: flushAll,
      disposed: () => inst.disposed,
    });
    const flushOnExit = memoryController.flushOnExit;
    window.addEventListener("pagehide", flushOnExit);
    let unlistenClose: (() => void) | null = null;
    if (backend.kind === "tauri") {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow()
          .onCloseRequested(flushOnExit)
          .then((fn) => {
            if (inst.disposed) fn();
            else unlistenClose = fn;
          })
          .catch((e) => coreLog("error", `term exit hook failed: ${e}`))
      );
    }

    // Shells that emit OSC 0/2 window titles drive the tab title for free.
    term.onTitleChange((title) => {
      if (title.trim().length > 0) {
        useStore.getState().setTabTitle(tab.id, title);
      }
    });

    const viewportController = createTerminalViewportController({
      proposeDimensions: () => fit.proposeDimensions() ?? undefined,
      currentSize: () => ({ cols: term.cols, rows: term.rows }),
      resize: (cols, rows) => term.resize(cols, rows),
      onSized: memoryController.markSized,
    });
    // The one measurement path, reachable from outside this closure: the
    // font effect re-measures through it rather than calling fit() itself,
    // so a shared session's viewer cap is honoured for a font change exactly
    // as it is for a window resize.
    inst.refit = viewportController.fit;
    // The app share's bridge drives the same cap programmatically: its
    // viewers' joint viewport arrives as an event in Rust, is emitted to
    // the bridge, and lands here — one cap mechanism, two arrivals.
    inst.setViewerCap = viewportController.setViewerCap;
    let unlistenViewport: (() => void) | null = null;
    if (backend.kind === "tauri") {
      import("@tauri-apps/api/event").then(({ listen }) => {
        listen<{ sessionId: string; cols: number | null; rows: number | null }>(
          "share-viewport",
          (e) => {
            if (inst.disposed) return;
            if (e.payload.sessionId !== inst.handle?.id) return;
            viewportController.setViewerCap(
              e.payload.cols && e.payload.rows
                ? { cols: e.payload.cols, rows: e.payload.rows }
                : null
            );
          }
        ).then((fn) => {
          if (inst.disposed) fn();
          else unlistenViewport = fn;
        });
      });
    }

    const spawnController = createTerminalSpawnController<TermHandle>({
      size: () => ({ cols: term.cols, rows: term.rows }),
      attachId:
        paneRef.current === tab.id ? tab.attachSessionId ?? null : null,
      tabId: paneRef.current === tab.id ? tab.id : null,
      create: (options) => backend.createTerminal(options),
      reportCwdFailure: (cwd, error) =>
        coreLog("error", `shell spawn in ${cwd} failed: ${error}`),
      writeCwdFallback: (cwd) =>
        term.write(
          `\r\n\x1b[33m${STR.term.openCwdFallback({ dir: cwd })}\x1b[0m\r\n`
        ),
    });

    // A container that exists but hasn't been laid out yet measures a few
    // pixels, and fit() would then spawn the shell on a 2-column grid — the
    // prompt draws wrapped and every later resize has to repaint it. Wait for
    // a plausible size instead.
    const READY_PX = 80;
    const ready = () => el.offsetWidth >= READY_PX && el.offsetHeight >= READY_PX;

    // IMPORTANT: never gate session creation on requestAnimationFrame or on
    // ResizeObserver's initial delivery — WKWebView suspends the frame loop
    // for occluded windows, which would silently defer the shell forever.
    let created = false;
    const startSession = () => {
      if (inst.disposed || created) return;
      created = true;
      const owner = useStore.getState().tabs.find((t) => t.id === tab.id);
      const paneLeaf = owner?.panes
        ? findLeaf(owner.panes, paneRef.current)
        : null;
      const paneDir =
        paneLeaf?.cwd ?? owner?.cwd ?? tab.cwd;
      spawnController
        .spawn(spawnCwd(paneDir, memoryController.loadedMemory()?.cwd), {
          profile: paneLeaf?.profile ?? profileRef.current,
          runOnStart: paneLeaf?.runOnStart,
        })
        .then(async (handle) => {
          if (inst.disposed) {
            handle.kill();
            return;
          }
          inst.handle = handle;
          useStore.getState().setPaneTermId(tab.id, paneRef.current, handle.id);
          installTerminalSessionRegistration({
            handle,
            register: (api) => registerTerm(tab.id, api, paneRef.current),
            size: () => ({ cols: term.cols, rows: term.rows }),
            serialize: () => serialize.serialize(),
            focus: () => term.focus(),
            openSearch: () => setSearchOpen(true),
            setViewerCap: (vp) => inst.setViewerCap(vp),
            cwd: () => blocks.currentCwd,
            debugWriteOutput: (data: string) => term.write(data),
            debugThemeBackground: () => String(term.options.theme?.background ?? ""),
            debugPersistNow: memoryController.saveNow,
            debugLastBlockOutput: () => {
              const b = blocks.blocks[blocks.blocks.length - 1];
              return b ? { command: b.command, output: blocks.outputOf(b) } : null;
            },
            primary: paneRef.current === tab.id,
            handoverCommand: tab.runOnStart,
            handoverDone: () => inst.ranHandover,
            markHandoverDone: () => {
              inst.ranHandover = true;
            },
          });
          const snapshotController = createTerminalShareSnapshotController({
            currentShareId: () =>
              useStore
                .getState()
                .tabs.find((candidate) => candidate.id === tab.id)?.share
                ?.shareId ?? null,
            write: (data, callback) => term.write(data, callback),
            serialize: (options) => serialize.serialize(options),
            encode: b64encode,
            size: () => ({ cols: term.cols, rows: term.rows }),
            send: sendTerminalShareSnapshot,
            reportError: (error) =>
              coreLog("error", `share_snapshot failed: ${error}`),
          });
          handle.onSnapshotRequest(snapshotController.handleRequest);
          installTerminalOutputController({
            disposed: () => inst.disposed,
            onData: (listener) => {
              handle.onData(listener);
            },
            onExit: (listener) => {
              handle.onExit(listener);
            },
            write: (data) => term.write(data),
            endSpawnWait: () => setSpawning(false),
            markMemoryOutput: memoryController.markOutput,
            scheduleMemorySave: memoryController.scheduleSave,
            reportOutputAt: (timestamp) =>
              useStore.getState().setTabOutputAt(tab.id, timestamp),
            handleExit: (code) => {
              const state = useStore.getState();
              state.setPaneBusy(tab.id, paneRef.current, false);
              const owner = state.tabs.find((candidate) => candidate.id === tab.id);
              if (owner?.panes && paneCount(owner.panes) > 1) {
                state.removeTerminalPane(tab.id, paneRef.current);
                return null;
              }
              state.markTabExited(tab.id);
              const closeKeys = formatKeys(keysFor("close-tab"));
              return `\r\n\x1b[90m${
                code !== null
                  ? STR.term.exitedLine({ code, keys: closeKeys })
                  : STR.term.exitedLineNoCode({ keys: closeKeys })
              }\x1b[0m\r\n`;
            },
          });
          installTerminalInputController({
            write: (data) => handle.write(data),
            resize: (cols, rows) => handle.resize(cols, rows),
            broadcast: (data) =>
              broadcastTerminalInput(data, {
                enabled: () =>
                  useStore.getState().broadcastTabs[tab.id] === true,
                currentPane: paneRef.current,
                paneIds: () => {
                  const owner = useStore
                    .getState()
                    .tabs.find((candidate) => candidate.id === tab.id);
                  return owner?.panes ? leaves(owner.panes) : [];
                },
                writePane: (paneId, text) =>
                  getPaneTerm(tab.id, paneId)?.write(text),
              }),
            onData: (listener) => {
              term.onData(listener);
            },
            onBinary: (listener) => {
              term.onBinary(listener);
            },
            onResize: (listener) => {
              term.onResize(listener);
            },
            plainPaste: (text) => term.paste(text),
            askPaste: (text) => setPasteAsk(text),
            pasteGuardEnabled: terminalPasteGuard,
            setPastePorts: (ports) => {
              pastePortsRef.current = ports;
            },
            setTyping: (typing) => {
              typingRef.current = typing;
            },
            setCompletion,
            completionSpec: () => spec,
            inputLine,
            installConventions: (send, paste) =>
              installMacKeyConventions(term, send, paste),
            recordConventionInput: import.meta.env.DEV
              ? (data) => {
                  const hex = [...data]
                    .map((character) =>
                      character.charCodeAt(0).toString(16).padStart(2, "0")
                    )
                    .join(" ");
                  document.body.dataset.tabverseSent =
                    `${document.body.dataset.tabverseSent ?? ""}|${hex}`;
                }
              : undefined,
            focus: () => term.focus(),
          });
        })
        .catch((err) => {
          // The wait is over either way — what follows is the error.
          setSpawning(false);
          term.write(
            ansiErrorLines(describeError(err, STR.errors.actions.startShell))
          );
        });
    };

    // The bundled icon font must be loaded before the first measurement, or
    // the grid is sized for a font that is about to change under it.
    // Start the shell as soon as the pane has a size. NEVER gate this on font
    // loading: a webfont that is slow (or never resolves) would leave the user
    // staring at an empty terminal with no session behind it. Fonts only
    // affect cell metrics, so re-measure once they land.
    if (ready()) {
      viewportController.fit();
      startSession();
    }
    void waitForTerminalFonts().then(() => {
      if (inst.disposed || !ready()) return;
      viewportController.fit();
    });

    // Refit when our pane changes size (window resize, sidebar toggle, …) and
    // start the session for panes that were born hidden once they get size.
    const ro = new ResizeObserver(() => {
      if (inst.disposed || !ready()) return;
      viewportController.fit();
      startSession();
    });
    ro.observe(el);

    return () =>
      runTerminalCleanup({
        disposeMemory: memoryController.dispose,
        detachLifecycle: () => {
          window.removeEventListener("pagehide", flushOnExit);
          unlistenClose?.();
        },
        sessionState: () => {
          const state = useStore.getState();
          const owner = state.tabs.find((candidate) => candidate.id === tab.id);
          return {
            ownerExists: owner !== undefined,
            paneGone:
              owner?.panes !== undefined &&
              findLeaf(owner.panes, paneRef.current) === null,
            archived: state.archive.some((entry) => entry.id === tab.id),
          };
        },
        captureMemory: memoryController.capture,
        removeMemory: () => deleteState(scope),
        markDisposed: () => {
          inst.disposed = true;
        },
        disconnectLayout: () => ro.disconnect(),
        detachInput: () => {
          el.removeEventListener("paste", onDomPaste, true);
          el.removeEventListener("keydown", onCompletionKeys, true);
        },
        clearInputPorts: () => {
          pastePortsRef.current = null;
          typingRef.current = null;
          inputLineRef.current = null;
        },
        detachViewport: () => unlistenViewport?.(),
        unregister: () => unregisterTerm(tab.id, paneRef.current),
        clearPaneBusy: () =>
          useStore.getState().setPaneBusy(tab.id, paneRef.current, false),
        remoteActive: () => remoteHostRef.current !== null,
        clearTabRemote: () => useStore.getState().setTabRemote(tab.id, null),
        clearRemoteHost: () => {
          remoteHostRef.current = null;
        },
        disposeBlocks: blockController.dispose,
        killHandle: () => inst.handle?.kill(),
        disposeTerminal: () => term.dispose(),
        clearInstance: () => {
          instRef.current = null;
        },
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, paneKey]);

  const resolvedTheme = useStore((s) => s.resolvedTheme);
  useEffect(() => {
    const inst = instRef.current;
    if (inst && !inst.disposed) {
      inst.term.options.theme = terminalTheme(resolvedTheme);
      inst.decorations.refreshTheme();
    }
  }, [resolvedTheme]);

  useEffect(
    () =>
      subscribeTerminalFont(() => {
        const inst = instRef.current;
        if (!inst || inst.disposed) return;
        // The last argument is what this instance was BORN with, not what the
        // setting says now: the ligature face leads the stack only for a
        // terminal that is running the renderer able to shape it, and the
        // switch takes effect on the terminals opened after it.
        if (
          applyTerminalFont(
            inst.term,
            terminalFont(profileRef.current),
            0,
            inst.ligatures
          )
        ) {
          // Cell metrics moved, so the grid holds a different number of
          // columns in the same pixels; the shell has to be told.
          inst.refit();
        }
      }),
    []
  );

  // On activation: refit (size may have changed while hidden) and focus.
  // The caret follows the FOCUSED pane, so ⌘⌥→ moves it — a tab's other
  // panes are on screen and running, and simply do not hold the keyboard.
  useEffect(() => {
    if (!focused) return;
    const inst = instRef.current;
    if (!inst) return;
    const t = window.setTimeout(() => {
      if (inst.disposed) return;
      // A background tab is `display:none`; while it is hidden, xterm's
      // WebGL texture atlas can keep an invalid glyph image. `resize` with
      // unchanged dimensions only re-measures, so it cannot repair that
      // image. Discard the atlas then explicitly redraw the whole viewport
      // after React has made this pane visible again. Canvas renderers treat
      // clearTextureAtlas as a no-op; the DOM renderer is also safe here.
      inst.term.clearTextureAtlas?.();
      inst.term.refresh?.(0, Math.max(0, inst.term.rows - 1));
      // Nudge the ResizeObserver path (cap-aware) rather than raw fit().
      inst.term.resize?.(inst.term.cols, inst.term.rows);
      window.dispatchEvent(new Event("resize"));
      if (!searchOpen) inst.term.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [focused, searchOpen]);

  // A command the agent ran, put in front of the user to look at.
  //
  // Typed in, not executed: the agent has already run it, and running it again
  // on a click could be `rm -rf`, `git push --force`, or a deploy. The user
  // reads it, edits it if they want, and decides whether to press return. The
  // nonce is what lets the same command land twice — an agent runs the same
  // test command over and over.
  const deliveredCommand = useRef<number | null>(null);
  const rulerPressY = useRef<number | null>(null);
  useEffect(() => {
    const pending = tab.command;
    if (!pending) return;
    if (deliveredCommand.current === pending.nonce) return;
    const inst = instRef.current;
    if (!inst || inst.disposed) return;
    deliveredCommand.current = pending.nonce;
    inst.handle?.write(pending.text);
    inst.term.focus();
  }, [tab.command]);

  // The menu's Find… item speaks the command bus, not keydown; while this tab
  // is in front, "find" means search the scrollback — of the pane the caret
  // is in, since a menu item has one terminal to act on and that is it.
  useEffect(() => {
    if (!focused) return;
    return onAppCommand((cmd) => {
      if (cmd === "find") setSearchOpen(true);
      else if (cmd === "clear-terminal") {
        // Screen and scrollback both, the way ⌘K works in iTerm2 — and
        // without sending anything to the shell, so a half-typed command
        // line survives being cleared around it.
        instRef.current?.term.clear();
      }
    });
  }, [focused]);

  // Terminal-scoped shortcuts, only while the caret is in THIS pane. Which
  // keys they are is the composition's answer (`localKeys.ts`) — including
  // the Mac guard that keeps Ctrl for the programs inside the terminal, and
  // the ⌃⌘ chord the shared reader cannot spell, both of which live there
  // with the reasons written out. This effect holds only what the keys DO
  // here: this terminal's scrollback search, its command blocks, and the
  // five pane keys, which act on the tab's tree through the store.
  //
  // Installed by the focused pane alone, so exactly one listener answers a
  // press however many panes the tab has.
  useEffect(() => {
    if (!focused) return;
    return onLocalKeys(terminalKeyAction, (action, e) => {
      const inst = instRef.current;
      if (!inst) return;
      e.preventDefault();
      e.stopPropagation();
      const st = useStore.getState();
      runTerminalWorkspaceAction(action, {
        openSearch: () => setSearchOpen(true),
        jumpBlock,
        currentCwd: () => inst.blocks.currentCwd,
        splitPane: (vertical, cwd) =>
          st.splitTerminalPane(tab.id, vertical, cwd),
        focusPane: (direction) => st.focusPaneDir(tab.id, direction),
        resizePane: (direction) => st.resizePaneDir(tab.id, direction),
        zoomPane: () => st.togglePaneZoom(tab.id),
        toggleBroadcast: () => st.toggleBroadcast(tab.id),
        writeBroadcastRefusal: () =>
          inst.term.write(
            `\r\n\x1b[33m${STR.common.sidebar.shareNeedsNoBroadcast}\x1b[0m\r\n`
          ),
        scrollToTop: () => inst.term.scrollToTop(),
        scrollToBottom: () => inst.term.scrollToBottom(),
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, tab.id]);

  const jumpBlock = useCallback(
    (direction: -1 | 1) => {
      const inst = instRef.current;
      if (!inst) return;
      navigateTerminalBlock(direction, {
        blocks: () => inst.blocks.liveBlocks,
        selected: () => selectedBlock,
        select: setSelectedBlock,
        scrollToLine: (line) => inst.term.scrollToLine(line),
      });
    },
    [selectedBlock]
  );

  const copy = async (text: string, kind: "cmd" | "out") => {
    try {
      await navigator.clipboard.writeText(text);
      // Show "copied" briefly; silent success looks like a dead button.
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      // Clipboard access can be denied; the selection still works.
    }
  };

  const broadcasting = useStore((s) => s.broadcastTabs[tab.id] === true);
  const paneTotal =
    tab.panes === undefined ? 1 : paneCount(tab.panes);

  const { list: profileList } = useProfiles();
  const profileBadgeName = profileList.find(
    (p) => p.name === profileRef.current
  )?.badge;
  const profileBadge =
    profileBadgeName !== undefined && profileBadgeName.trim() !== ""
      ? profileBadgeName.trim()
      : undefined;

  const pullTarget =
    hoverTarget !== null && hoverTarget.kind === "path"
      ? hoverTarget.path
      : null;
  const transfer = useTerminalFileTransfer({
    remoteHost,
    remoteCwd,
    pullTarget,
    pull: backend.transferPull,
    push: (host, dir, name, bytes) =>
      backend.transferPush(host, dir, name, b64encode(bytes)),
    openLocalPath: (path) =>
      openTerminalLink({ kind: "path", path }, false, false),
    pullError: (error) =>
      describeError(error, STR.errors.actions.pullFile),
    pushError: (error) =>
      describeError(error, STR.errors.actions.pushFile),
    uploadTooLarge: (file) => ({
      title: STR.term.uploadTooLarge({ mb: Math.round(file.size / 1048576) }),
      detail: file.name,
    }),
    uploadDone: (count, host) => STR.term.uploadDone({ count, host }),
  });
  const uploadDestination =
    transfer.uploadPrompt === null
      ? null
      : splitTerminalTransferDestination(transfer.uploadPrompt.destination);

  const confirmPaste = () => {
    const text = pasteAsk;
    const ports = pastePortsRef.current;
    setPasteAsk(null);
    if (text === null || ports === null) return;
    confirmedPaste(text, ports);
    instRef.current?.term.focus();
  };

  const dismissPaste = () => {
    setPasteAsk(null);
    instRef.current?.term.focus();
  };

  return (
    <TerminalWorkspacePane
      containerRef={containerRef}
      broadcasting={broadcasting}
      focused={focused}
      paneCount={paneTotal}
      broadcastKeys={formatKeys(keysFor("toggle-broadcast"))}
      hoverLink={hoverLink}
      badge={
        remoteHost !== null
          ? {
              text: remoteHost,
              title: STR.term.remoteHostHint({ host: remoteHost }),
            }
          : profileBadge !== undefined
            ? {
                text: profileRef.current ?? "",
                title: STR.common.sidebar.profileBadgeHint({
                  name: profileRef.current ?? "",
                }),
                color: profileBadgeVar(profileBadge),
                profile: true,
              }
            : null
      }
      transferBusy={transfer.busy}
      transferNotice={transfer.notice}
      transferError={transfer.error}
      onDismissTransferError={transfer.dismissError}
      contextMenu={ctxMenu}
      onDismissContextMenu={() => setCtxMenu(null)}
      onToggleBroadcast={() => {
        useStore.getState().toggleBroadcast(tab.id);
        setCtxMenu(null);
      }}
      pullAction={
        remoteHost === null
          ? null
          : {
              label: STR.term.pullFrom({ host: shortHost(remoteHost) }),
              disabled: pullTarget === null || transfer.busy,
              title: pullTarget === null ? STR.term.pullNeedsPath : undefined,
              onRun: () => {
                void transfer.pullFromRemote();
                setCtxMenu(null);
              },
            }
      }
      onOpenCwd={() => {
        openDirectoryInFilesPane(
          instRef.current?.blocks.currentCwd ?? tab.cwd ?? undefined,
        );
        setCtxMenu(null);
      }}
      blockActions={
        selectedBlock === null
          ? null
          : {
              copied:
                copied === "cmd"
                  ? ("command" as const)
                  : copied === "out"
                    ? ("output" as const)
                    : null,
              canRerun: !running && selectedBlock.command !== "",
              onCopyCommand: () => {
                void copy(selectedBlock.command, "cmd");
                setCtxMenu(null);
              },
              onCopyOutput: () => {
                const inst = instRef.current;
                if (inst !== null) {
                  void copy(inst.blocks.outputOf(selectedBlock), "out");
                }
                setCtxMenu(null);
              },
              onRerun: () => {
                const inst = instRef.current;
                inst?.handle?.write(`${selectedBlock.command}\n`);
                inst?.term.focus();
                setCtxMenu(null);
              },
            }
      }
      uploadPrompt={
        transfer.uploadPrompt === null
          ? null
          : {
              host: uploadDestination?.host ?? remoteHost ?? "",
              files: transfer.uploadPrompt.files,
              destination: transfer.uploadPrompt.destination,
              valid: uploadDestination !== null,
            }
      }
      onDismissUpload={transfer.dismissUpload}
      onUploadDestinationChange={transfer.setUploadDestination}
      onSubmitUpload={() => void transfer.submitUpload()}
      pastePrompt={
        pasteAsk === null
          ? null
          : { text: pasteAsk, lineCount: countLines(pasteAsk) }
      }
      onDismissPaste={dismissPaste}
      onPasteChange={setPasteAsk}
      onSubmitPaste={confirmPaste}
      completion={
        completion === null ? null : (
          <CompletionPopup
            offer={completion.offer}
            selected={completion.sel}
            onPick={(item) => {
              if (completion.offer.kind !== "flags") return;
              const word = completion.offer.word;
              const suffix = `${
                item.startsWith(word) ? item.slice(word.length) : item
              } `;
              inputLineRef.current?.push(suffix);
              typingRef.current?.(suffix);
              setCompletion(null);
            }}
          />
        )
      }
      search={
        searchOpen && instRef.current !== null ? (
          <SearchBar
            search={instRef.current.search}
            onClose={() => {
              setSearchOpen(false);
              instRef.current?.term.focus();
            }}
          />
        ) : null
      }
      spawning={spawning}
      allowFileTransfer={remoteHost !== null}
      onFilesDropped={transfer.startUpload}
      onOpenContextMenu={(x, y) => setCtxMenu({ x, y })}
      onFocusPane={() => {
        useStore.getState().focusPane(tab.id, paneKey);
        instRef.current?.term.focus();
      }}
      onRulerPointerDown={(clientY) => {
        rulerPressY.current = clientY;
      }}
      onRulerClick={(clientY, top, height) => {
        const inst = instRef.current;
        if (inst === null || inst.disposed) return;
        if (
          rulerPressY.current !== null &&
          Math.abs(clientY - rulerPressY.current) > 4
        ) {
          return;
        }
        const line = rulerYToBufferLine(
          clientY - top,
          height,
          inst.term.buffer.active.length,
        );
        const target = inst.blocks.blockAt(line);
        if (target !== null) {
          setSelectedBlock(target);
          inst.term.scrollToLine(Math.max(0, target.start.line - 1));
          inst.term.focus();
        }
      }}
      status={<BlockStatusPill finished={running ?? selectedBlock} />}
    />
  );
}
