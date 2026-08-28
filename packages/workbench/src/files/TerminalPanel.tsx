import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ansiErrorLines, describeError } from "../strings/errors";
import { STR } from "../strings";
import { BlockTracker } from "../terminal/blocks";
import { installMacKeyConventions } from "../terminal/keys";
import {
  PANEL_FONT_STEP,
  applyTerminalFont,
  subscribeTerminalFont,
  terminalFont,
  waitForTerminalFonts,
  xtermFontOptions,
} from "../terminal/font";
import { terminalTheme, type ThemeName } from "../theme";
import {
  PANEL_DEFAULT_PX,
  cdCommand,
  clampPanelHeight,
  normalizeDir,
  syncDecision,
} from "./termSync";
import { CloseIcon } from "../icons";
import { LoadingState } from "../state/LoadingState";


function panelTheme(t: ThemeName) {
  const full = terminalTheme(t);
  return {
    background: full.background,
    foreground: full.foreground,
    cursor: full.cursor,
    cursorAccent: full.cursorAccent,
    selectionBackground: full.selectionBackground,
  };
}

/** Output this recent means something is still printing: not a free prompt. */
const QUIET_MS = 250;

/** How often a cd that had to wait for the prompt tries again. */
const IDLE_RETRY_MS = 300;

/**
 * Dragging the grip changes the box on every mouse move, and each new grid
 * size is a resize on the pty and a SIGWINCH to whatever runs in it. One
 * resize per gesture pause is enough; the visual size follows the mouse
 * regardless, because that is CSS and costs nothing.
 */
const RESIZE_DEBOUNCE_MS = 80;

export interface TerminalPanelHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: Uint8Array) => void): () => void;
  onExit(callback: (code: number | null) => void): () => void;
}

export interface TerminalPanelRuntime {
  createTerminal(options: {
    cols: number;
    rows: number;
    cwd?: string;
  }): Promise<TerminalPanelHandle>;
  reportDiagnostic(level: "warn" | "error", message: string): void;
}

export interface TerminalPanelProps {
  /** The directory the file tab is showing; the shell is driven to match. */
  cwd: string;
  /** False hides the panel without ending its shell. */
  visible: boolean;
  /** Panel height in pixels, as the tab remembers it. */
  height: number;
  /** The shell moved (OSC 7): the tab's directory should follow. */
  onCwdChange: (dir: string) => void;
  /** A finished drag; fired once per gesture, not once per frame. */
  onHeightChange: (px: number) => void;
  onClose: () => void;
  theme: ThemeName;
  runtime: TerminalPanelRuntime;
}

/** What the rest of the component may reach into the live terminal for. */
interface PanelTerm {
  term: Terminal;
  handle: TerminalPanelHandle | null;
  disposed: boolean;
  /** Hand the outstanding cd to the shell if it is free to take it. */
  pump: () => void;
  refit: () => void;
}

export function TerminalPanel({
  cwd,
  visible,
  height,
  onCwdChange,
  onHeightChange,
  onClose,
  theme,
  runtime,
}: TerminalPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<PanelTerm | null>(null);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Nothing is built until the panel is shown for the first time, and nothing
  // is torn down when it is hidden again: a hidden panel that spawned a shell
  // would cost a process per file tab nobody asked for, and one that killed
  // its shell on every toggle would lose whatever was running in it.
  const [everShown, setEverShown] = useState(visible);
  // Bumping this rebuilds the terminal — the one case being a shell the user
  // exited, which is replaced the next time the panel is opened.
  const [generation, setGeneration] = useState(0);
  const [shellCwd, setShellCwd] = useState<string | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [spawning, setSpawning] = useState(true);

  // Live values for the callbacks that outlive the render that made them:
  // xterm parser handlers and pty subscriptions are installed once and would
  // otherwise keep answering with the props of the first render forever.
  const tabCwdRef = useRef<string | null>(null);
  tabCwdRef.current = normalizeDir(cwd);
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;

  /**
   * The directory this panel has committed the shell to and not yet seen it
   * reach. Set when the decision is made rather than when the bytes go out,
   * so a cd waiting for a busy prompt still counts as asked for and cannot be
   * asked for twice.
   */
  const pendingCdRef = useRef<string | null>(null);
  /** Whether the pending cd has actually been written into the shell. */
  const cdWrittenRef = useRef(false);
  const exitedRef = useRef(false);
  const wasVisibleRef = useRef(visible);

  useEffect(() => {
    if (visible) setEverShown(true);
  }, [visible]);

  useEffect(() => {
    const inst = instRef.current;
    if (inst && !inst.disposed) inst.term.options.theme = panelTheme(theme);
  }, [theme]);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    []
  );

  // A shell the user exited stays on screen, exit message and all, for as
  // long as the panel is open — that message is the answer to what they just
  // did. Reopening the panel is a fresh request, and answers it with a shell.
  useEffect(() => {
    const revealed = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!revealed) return;
    if (exitedRef.current) {
      exitedRef.current = false;
      setGeneration((g) => g + 1);
    } else {
      // Opening the panel is a request to type in it.
      window.setTimeout(() => instRef.current?.term.focus(), 0);
    }
  }, [visible]);

  useEffect(() => {
    if (!everShown) return;
    const el = bodyRef.current;
    if (!el) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      // A panel is for one command and its answer, not for a day of history;
      // the terminal tab is where a long scrollback belongs.
      scrollback: 2000,
      ...(xtermFontOptions(terminalFont(), PANEL_FONT_STEP) ?? {}),
      macOptionIsMeta: true,
      theme: panelTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    /** When output last arrived, to tell a busy shell from a waiting one. */
    let lastOutputAt = 0;
    /** Whether a half-typed command is sitting at the prompt. */
    let typedLine = false;
    let retryTimer: number | null = null;
    let resizeTimer: number | null = null;
    let created = false;
    let firstByteSeen = false;
    setSpawning(true);
    /** Where the shell was asked to start, or null when nothing was asked. */
    let spawnedIn: string | null = null;
    /** Whether the shell has printed a prompt yet. */
    let firstReportSeen = false;
    let unsubscribeHandleData: (() => void) | null = null;
    let unsubscribeHandleExit: (() => void) | null = null;

    /**
     * The shell integration, used here for one thing: OSC 7 is how a panel
     * learns that the user cd'd. (Registering the tracker also swallows the
     * OSC 133 prompt marks, which would otherwise print as text.)
     */
    const blocks = new BlockTracker(term, {
      onCwd: (dir) => {
        const incoming = normalizeDir(dir);
        if (!incoming) return;
        setShellCwd(incoming);
        // This prompt is the answer to whatever cd we wrote: it either landed
        // (the report matches) or it did not (the directory vanished under
        // us, the shell refused it). Both end the in-flight window — a guard
        // that outlived a failed cd would stop the tab following the shell
        // for the rest of the session.
        if (cdWrittenRef.current) {
          pendingCdRef.current = null;
          cdWrittenRef.current = false;
        }
        // The first prompt says where the shell really started, which is not
        // always where it was asked to: a login rc file that cds is ordinary.
        // The panel was opened for the directory the tab is showing, so that
        // one exchange goes the other way — the shell is sent back rather than
        // the file tab being dragged off to wherever a dotfile pointed. Only
        // when the directory we asked for was accepted, though: after a
        // fallback the shell is somewhere else precisely because the tab's
        // directory could not be opened, and sending it there would only
        // print the same failure again.
        const startupDrift =
          !firstReportSeen &&
          spawnedIn !== null &&
          tabCwdRef.current !== null &&
          incoming !== tabCwdRef.current;
        firstReportSeen = true;
        if (startupDrift) {
          pendingCdRef.current = tabCwdRef.current;
          cdWrittenRef.current = false;
          pump();
          return;
        }
        const action = syncDecision(
          "shell",
          tabCwdRef.current,
          incoming,
          pendingCdRef.current
        );
        if (action === "follow") onCwdChangeRef.current(incoming);
      },
    });

    const inst: PanelTerm = {
      term,
      handle: null,
      disposed: false,
      pump: () => {},
      // Both are replaced below, once the functions they stand for exist.
      refit: () => {},
    };
    instRef.current = inst;

    const stopRetry = () => {
      if (retryTimer !== null) {
        window.clearInterval(retryTimer);
        retryTimer = null;
      }
    };

    /**
     * Is the shell free to be typed at?
     *
     * A cd written while something else owns the input does not run: it is
     * appended to the user's half-typed command, or eaten by whatever
     * full-screen program is on the alternate buffer (vim would take `cd` as
     * two motions). None of this can be known exactly from the outside, hence
     * three cheap signals that together cover what actually happens: a
     * program that redraws the screen, output still arriving, and a line the
     * user has started and not sent.
     */
    const idle = () =>
      term.buffer.active.type === "normal" &&
      !typedLine &&
      Date.now() - lastOutputAt > QUIET_MS;

    const pump = () => {
      if (inst.disposed) return;
      const target = pendingCdRef.current;
      if (!target || cdWrittenRef.current || !inst.handle || exitedRef.current) {
        stopRetry();
        return;
      }
      if (!idle()) {
        // Not dropped: the user's directory click is still what they want,
        // it just waits for the prompt to be theirs again.
        if (retryTimer === null) {
          retryTimer = window.setInterval(pump, IDLE_RETRY_MS);
        }
        return;
      }
      stopRetry();
      cdWrittenRef.current = true;
      inst.handle.write(cdCommand(target));
    };
    inst.pump = pump;

    /** Enter sends the line, Ctrl+C and Ctrl+U throw it away. */
    const noteTyping = (s: string) => {
      if (/[\r\n\x03\x15]/.test(s)) typedLine = false;
      else if (/[^\x00-\x1f\x7f]/.test(s)) typedLine = true;
    };

    // A laid-out-but-unmeasured container reports a few pixels, and fitting
    // to that spawns the shell on a 2-column grid whose prompt draws wrapped.
    // The height bar is far below the terminal tab's on purpose: this panel is
    // meant to be short, and a user who dragged it to its minimum must still
    // get a shell.
    const ready = () => el.offsetWidth >= 80 && el.offsetHeight >= 24;

    const applySize = () => {
      if (inst.disposed || !ready()) return;
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
        return;
      }
      const cols = Math.max(2, dims.cols);
      const rows = Math.max(2, dims.rows);
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    };
    inst.refit = applySize;

    const spawn = (dir: string | undefined) =>
      runtimeRef.current
        .createTerminal({ cols: term.cols, rows: term.rows, cwd: dir })
        .then((handle) => {
          spawnedIn = dir ?? null;
          return handle;
        })
        .catch((err) => {
          if (dir === undefined) throw err;
          // The tab can be showing a directory the shell cannot enter (a
          // volume that went away, permissions). A panel with no shell in it
          // is worse than a shell in the wrong place.
          runtimeRef.current.reportDiagnostic(
            "error",
            `panel shell spawn in ${dir} failed: ${err}`
          );
          term.write(
            `\r\n\x1b[33m${STR.term.openCwdFallback({ dir })}\x1b[0m\r\n`
          );
          spawnedIn = null;
          return runtimeRef.current.createTerminal({
            cols: term.cols,
            rows: term.rows,
          });
        });

    // IMPORTANT: never behind requestAnimationFrame and never behind the font
    // load — an occluded webview suspends the frame loop, and a webfont can
    // take forever, and either would leave a visible panel with no shell in
    // it. Fonts only change cell metrics, so they re-measure when they land.
    const startSession = () => {
      if (inst.disposed || created || !ready()) return;
      created = true;
      spawn(tabCwdRef.current ?? undefined)
        .then((handle) => {
          if (inst.disposed) {
            handle.kill();
            return;
          }
          inst.handle = handle;
          if (spawnedIn) {
            // The shell was created in the tab's directory, so it is already
            // where a cd would have sent it — writing one anyway would print
            // a pointless command into a terminal the user is looking at, and
            // leave it in their shell history.
            setShellCwd(spawnedIn);
            if (pendingCdRef.current === spawnedIn && !cdWrittenRef.current) {
              pendingCdRef.current = null;
            }
          }
          unsubscribeHandleData = handle.onData((bytes) => {
            if (inst.disposed) return;
            if (!firstByteSeen) {
              firstByteSeen = true;
              setSpawning(false);
            }
            lastOutputAt = Date.now();
            term.write(bytes);
          });
          unsubscribeHandleExit = handle.onExit(() => {
            if (inst.disposed) return;
            exitedRef.current = true;
            if (!firstByteSeen) {
              firstByteSeen = true;
              setSpawning(false);
            }
            term.write(
              `\r\n\x1b[90m${STR.term.panelExitedLine}\x1b[0m\r\n`
            );
          });
          installMacKeyConventions(term, (data) => handle.write(data));
          term.onData((s) => {
            noteTyping(s);
            handle.write(s);
          });
          term.onBinary((s) => {
            const bytes = new Uint8Array(s.length);
            for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
            handle.write(bytes);
          });
          term.onResize(({ cols, rows }) => handle.resize(cols, rows));
          term.focus();
          // A directory change can arrive before the shell does.
          pump();
        })
        .catch((err) => {
          if (inst.disposed) return;
          // The wait is over either way — what follows is the error.
          setSpawning(false);
          term.write(
            ansiErrorLines(describeError(err, STR.errors.actions.startShell))
          );
        });
    };

    if (ready()) {
      applySize();
      startSession();
    }
    void waitForTerminalFonts().then(() => {
      if (inst.disposed) return;
      applySize();
    });

    const ro = new ResizeObserver(() => {
      if (inst.disposed) return;
      // Debounced together: a drag would otherwise resize the pty on every
      // frame. A panel born hidden starts its shell here, once it has a size.
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        applySize();
        startSession();
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(el);

    return () => {
      inst.disposed = true;
      stopRetry();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      ro.disconnect();
      blocks.dispose();
      unsubscribeHandleData?.();
      unsubscribeHandleExit?.();
      unsubscribeHandleData = null;
      unsubscribeHandleExit = null;
      // The tab is going away and so is its shell: this panel's process is
      // not something anything else can reattach to.
      inst.handle?.kill();
      term.dispose();
      instRef.current = null;
      pendingCdRef.current = null;
      cdWrittenRef.current = false;
    };
  }, [everShown, generation]);

  useEffect(
    () =>
      subscribeTerminalFont(() => {
        const inst = instRef.current;
        if (!inst || inst.disposed) return;
        if (applyTerminalFont(inst.term, terminalFont(), PANEL_FONT_STEP)) {
          inst.refit();
        }
      }),
    []
  );

  // The tab moved (tree, ⌘L, or a restore): take the shell along. Listed
  // among the dependencies are the two things that create a shell — the first
  // reveal and a restart — because a directory change that arrived while
  // there was nothing to send it to still has to be sent.
  useEffect(() => {
    const inst = instRef.current;
    if (!inst) return;
    const target = normalizeDir(cwd);
    if (!target) return;
    const action = syncDecision("tab", shellCwd, target, pendingCdRef.current);
    if (action !== "send-cd") {
      // The tab has arrived where the shell already is. A cd that was decided
      // but never got a free prompt to be written into is now obsolete, and
      // sending it later would drag the shell off the directory the user is
      // looking at. (A cd waiting for the same target keeps its place.)
      if (!cdWrittenRef.current && pendingCdRef.current !== target) {
        pendingCdRef.current = null;
      }
      return;
    }
    pendingCdRef.current = target;
    cdWrittenRef.current = false;
    inst.pump();
  }, [cwd, shellCwd, everShown, generation]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragCleanupRef.current?.();
    const startY = e.clientY;
    const startH = panelRef.current?.offsetHeight ?? height;
    const pane = panelRef.current?.parentElement?.clientHeight ?? 0;
    let latest = startH;
    const move = (ev: MouseEvent) => {
      latest = clampPanelHeight(startH + (startY - ev.clientY), pane);
      setDragHeight(latest);
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };
    const up = () => {
      cleanup();
      setDragHeight(null);
      onHeightChange(latest);
    };
    dragCleanupRef.current = cleanup;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Built lazily, so a panel that has never been opened costs nothing at all.
  if (!everShown) return null;

  const shown = shellCwd ?? normalizeDir(cwd) ?? "";
  return (
    <div
      ref={panelRef}
      className="file-term-panel"
      style={{
        height: dragHeight ?? height,
        display: visible ? undefined : "none",
      }}
    >
      <div
        className="file-term-grip"
        title={STR.files.termPanel.gripHint}
        onMouseDown={startDrag}
        onDoubleClick={() => onHeightChange(PANEL_DEFAULT_PX)}
      />
      <div className="file-term-head">
        <span className="file-term-cwd" title={shown}>
          {shown}
        </span>
        <button
          className="file-term-close"
          title={STR.files.termPanel.hideHint}
          aria-label={STR.files.termPanel.hideHint}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      {spawning && everShown && (
        <div className="term-loading">
          <LoadingState inline label={STR.term.startingShell} />
        </div>
      )}
      <div
        ref={bodyRef}
        className="file-term-body"
        onMouseDown={() => instRef.current?.term.focus()}
      />
    </div>
  );
}
