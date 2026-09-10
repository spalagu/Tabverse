import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { b64decode, b64encode } from "../backend/b64";
import type { AgentAccess, RemoteHostMsgPayload } from "../backend/types";
import {
  applyViewerFrame,
  initialViewerAgentState,
  type ViewerAgentState,
} from "../agent/viewerFrames";
import type { RemoteAgentActions } from "./RemoteAgentPane";
import {
  RemoteSessionPane,
  type RemoteRendererKind,
  type RemoteTermSink,
  type RemoteViewportHint,
} from "@tabverse/workbench/remote-session-pane";
import { coreLog } from "../errlog";
import {
  ansiErrorLines,
  describeError,
  describeSessionEnd,
  errorText,
} from "../strings/errors";
import { STR } from "../strings";
import { waitForTerminalFonts } from "../term/font";
import { terminalImageMemoryMb } from "../state/config";
import { useStore, type Tab } from "../state/store";
import {
  isDeliberateEnd,
  isPermanentJoinError,
  reconnectDelayMs,
} from "./remoteReconnect";

/** Channel payload from the core. `mode` is typed here until the shared
 * payload union in backend/types.ts picks the new frame up. */
type RemoteEvent =
  | RemoteHostMsgPayload
  | { type: "mode"; readOnly: boolean; access?: AgentAccess };

interface Props {
  tab: Tab;
  active: boolean;
}

/** Which renderer this share gets. Decided by the welcome's tabType; null
 * until the host has said (or the join has failed for good). */
const sameHint = (
  a: RemoteViewportHint | null,
  b: RemoteViewportHint,
): boolean =>
  a !== null && a.cols === b.cols && a.rows === b.rows && a.percent === b.percent;

interface RemoteConnection {
  joinId: string | null;
  pingTimer: number | null;
  disposed: boolean;
  /** Deliberate host End or unusable ticket: no further connect attempts. */
  ended: boolean;
  readOnly: boolean;
  retryAttempt: number;
  retryTimer: number | null;
  /** Invalidates channel callbacks of superseded connection attempts. */
  connectGen: number;
  /** Mirrors the `kind` state for the channel closures. */
  kind: RemoteRendererKind;
  /** The mounted terminal renderer, once there is one. */
  sink: RemoteTermSink | null;
  /** Terminal ops issued before the renderer was known or mounted. */
  pending: Array<(sink: RemoteTermSink) => void>;
}

export function RemoteView({ tab, active }: Props) {
  // An agent share arrives on the same connection as a terminal one; every
  // frame goes through this fold, which collects what a transcript needs.
  const [agentState, setAgentState] = useState<ViewerAgentState>(initialViewerAgentState);
  const [kind, setKind] = useState<RemoteRendererKind>(null);
  const instRef = useRef<RemoteConnection | null>(null);
  const invokeRef = useRef<typeof import("@tauri-apps/api/core").invoke | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [viewport, setViewport] = useState<RemoteViewportHint | null>(null);
  const inSplitPane = useStore(
    (state) => state.split !== null && state.split.ids.includes(tab.id)
  );

  /** Input path for the terminal renderer. Wired once per renderer mount;
   * reconnects swap inst.joinId under this closure. */
  const sendInput = useCallback((data: string) => {
    const inst = instRef.current;
    const invoke = invokeRef.current;
    // Read-only gating is UX only — the host drops input frames from
    // read-only viewers authoritatively.
    if (!inst || !invoke || inst.disposed || inst.readOnly || !inst.joinId) return;
    void invoke("remote_input", { id: inst.joinId, dataB64: b64encode(data) });
  }, []);

  /** Viewport report path for the terminal renderer (it does the measuring). */
  const sendViewport = useCallback((cols: number, rows: number) => {
    const inst = instRef.current;
    const invoke = invokeRef.current;
    if (!inst || !invoke || inst.disposed || !inst.joinId) return;
    void invoke("remote_viewport", { id: inst.joinId, cols, rows }).catch(() => {});
  }, []);

  /** The agent pane's send side: the desktop's invoke commands, wrapped so
   * the pane never names a transport. Reconnects swap inst.joinId under
   * these closures, exactly as they do under sendInput above. */
  const agentActions = useMemo<RemoteAgentActions>(
    () => ({
      prompt: (text) => {
        const inst = instRef.current;
        const invoke = invokeRef.current;
        if (!inst || !invoke || inst.disposed || !inst.joinId) return;
        void invoke("remote_agent_prompt", { id: inst.joinId, text }).catch(() => {});
      },
      answer: (callId, allow) => {
        const inst = instRef.current;
        const invoke = invokeRef.current;
        if (!inst || !invoke || inst.disposed || !inst.joinId) return;
        void invoke("remote_agent_answer", {
          id: inst.joinId,
          callId,
          allow,
          reason: null,
        }).catch(() => {});
      },
      cancel: () => {
        const inst = instRef.current;
        const invoke = invokeRef.current;
        if (!inst || !invoke || inst.disposed || !inst.joinId) return;
        void invoke("remote_agent_cancel", { id: inst.joinId }).catch(() => {});
      },
    }),
    []
  );

  /** The terminal renderer plugs in here on mount; buffered ops replay so a
   * snapshot that raced the mount is not lost. Returns the detach fn. */
  const attachTerm = useCallback((sink: RemoteTermSink) => {
    const inst = instRef.current;
    if (!inst) return () => {};
    inst.sink = sink;
    const ops = inst.pending;
    inst.pending = [];
    for (const op of ops) op(sink);
    return () => {
      if (inst.sink === sink) inst.sink = null;
    };
  }, []);

  useEffect(() => {
    if (instRef.current) return;

    const inst: RemoteConnection = {
      joinId: null,
      pingTimer: null,
      disposed: false,
      ended: false,
      readOnly: false,
      retryAttempt: 0,
      retryTimer: null,
      connectGen: 0,
      kind: null,
      sink: null,
      pending: [],
    };
    instRef.current = inst;
    setKind(null);
    setAgentState(initialViewerAgentState);
    setReadOnly(false);
    setReconnectAttempt(0);

    /** Route a terminal op: dropped for an agent share, buffered until the
     * terminal renderer mounts, delivered live afterwards. */
    const toTerm = (op: (sink: RemoteTermSink) => void) => {
      if (inst.disposed || inst.kind === "agent") return;
      if (inst.sink) op(inst.sink);
      else inst.pending.push(op);
    };

    toTerm((t) => t.write("\x1b[90mConnecting to remote session…\x1b[0m\r\n"));
    // Icons in the host's prompt come from the bundled font; start loading it
    // before the stream starts painting.
    void waitForTerminalFonts();

    const st = () => useStore.getState();

    (async () => {
      const { invoke, Channel } = await import("@tauri-apps/api/core");
      if (inst.disposed) return;
      invokeRef.current = invoke;

      /** Release the current join (dead or superseded) without ending. */
      const dropJoin = () => {
        if (inst.pingTimer !== null) {
          window.clearInterval(inst.pingTimer);
          inst.pingTimer = null;
        }
        if (inst.joinId) {
          const id = inst.joinId;
          inst.joinId = null;
          void invoke("remote_leave", { id }).catch(() => {});
        }
      };

      /** A failure before any welcome leaves no renderer to say so. The
       * terminal pane is the fallback voice: it mounts and replays the
       * buffered status lines, exactly what a v1 share always showed. */
      const fallBackToTerminal = () => {
        if (inst.kind !== null) return;
        inst.kind = "terminal";
        setKind("terminal");
      };

      /** Terminal state: host ended the session on purpose, or the ticket
       * can never work. No retry. */
      const endSession = (reason: string) => {
        inst.ended = true;
        if (inst.retryTimer !== null) {
          window.clearTimeout(inst.retryTimer);
          inst.retryTimer = null;
        }
        setReconnectAttempt(0);
        dropJoin();
        st().markTabExited(tab.id);
        fallBackToTerminal();
        const ended = describeSessionEnd(reason);
        toTerm((t) =>
          t.write(
            `\r\n\x1b[90m${ended.line}\x1b[0m\r\n` +
              (ended.detail ? `\x1b[90m${ended.detail}\x1b[0m\r\n` : "")
          )
        );
      };

      /** Unexpected loss: back off exponentially and re-invoke remote_join.
       * Unlimited attempts; welcome resets the backoff. */
      const scheduleReconnect = () => {
        if (inst.disposed || inst.ended || inst.retryTimer !== null) return;
        inst.connectGen += 1; // late frames of the dead join are stale now
        dropJoin();
        inst.retryAttempt += 1;
        setReconnectAttempt(inst.retryAttempt);
        inst.retryTimer = window.setTimeout(() => {
          inst.retryTimer = null;
          void connect();
        }, reconnectDelayMs(inst.retryAttempt));
      };

      const connect = async () => {
        if (inst.disposed || inst.ended) return;
        const gen = ++inst.connectGen;
        try {
          const ch = new Channel<RemoteEvent>();
          ch.onmessage = (msg) => {
            if (inst.disposed || gen !== inst.connectGen) return;
            // Every frame goes through the same fold, which is where the agent
            // side of a share is decided. Keeping it out of the switch below is
            // what lets those rules be tested — a reconnect resending the whole
            // run is not something this component can be made to do on demand.
            setAgentState((prev) => applyViewerFrame(prev, msg));
            switch (msg.type) {
              case "welcome": {
                // Host accepted us (again): the rejoin succeeded, so the
                // next drop starts the backoff over at 1s.
                inst.retryAttempt = 0;
                setReconnectAttempt(0);
                // The welcome names the share's kind (absent = terminal, all
                // a v1 host could send). Only now does a renderer mount — an
                // agent share never constructs xterm at all.
                const k: Exclude<RemoteRendererKind, null> =
                  msg.tabType === "agent" ? "agent" : "terminal";
                if (inst.kind !== k) {
                  inst.kind = k;
                  if (k === "agent") inst.pending = [];
                  setKind(k);
                }
                toTerm((t) => {
                  t.resize(msg.cols, msg.rows);
                  t.rescale();
                });
                st().setTabTitle(tab.id, `⇄ ${msg.tabTitle}`);
                break;
              }
              case "mode":
                inst.readOnly = msg.readOnly;
                setReadOnly(msg.readOnly);
                break;
              case "snapshot":
                toTerm((t) => {
                  t.reset();
                  t.resize(msg.cols, msg.rows);
                  t.write(b64decode(msg.b64));
                  t.rescale();
                });
                break;
              case "output":
                toTerm((t) => t.write(b64decode(msg.b64)));
                break;
              case "resize":
                toTerm((t) => {
                  t.resize(msg.cols, msg.rows);
                  t.rescale();
                });
                break;
              case "presence":
                st().setRemoteViewers(tab.id, msg.viewers);
                break;
              case "end":
                // A host-sent End is deliberate: show the reason and stop.
                // The client library folds transport loss into a synthesized
                // End with a recognizable reason — that one reconnects.
                if (isDeliberateEnd(msg.reason)) {
                  endSession(msg.reason);
                } else {
                  scheduleReconnect();
                }
                break;
              case "pong":
                break;
            }
          };

          const joinId = await invoke<string>("remote_join", {
            ticket: tab.joinTicket ?? "",
            onEvent: ch,
          });
          if (inst.disposed || gen !== inst.connectGen) {
            void invoke("remote_leave", { id: joinId }).catch(() => {});
            return;
          }
          inst.joinId = joinId;
          inst.pingTimer = window.setInterval(() => {
            void invoke("remote_ping", { id: joinId }).catch(() => {});
          }, 10_000);
          // Report what the pane could display, now and shortly after —
          // rAF-free retries: the first attempts can race the welcome frame,
          // and rAF is frozen while the window is occluded.
          toTerm((t) => t.reportViewport());
          window.setTimeout(() => toTerm((t) => t.reportViewport()), 400);
          window.setTimeout(() => toTerm((t) => t.reportViewport()), 1500);
          // Only the first connect steals focus; a background rejoin must
          // not yank the user out of whatever tab they are typing in.
          if (gen === 1) toTerm((t) => t.focus());
        } catch (e) {
          if (inst.disposed || gen !== inst.connectGen) return;
          const message = errorText(e);
          coreLog("error", `remote_join failed: ${message}`);
          if (isPermanentJoinError(message)) {
            // A bad ticket fails identically forever; retrying would loop
            // with no hope.
            inst.ended = true;
            setReconnectAttempt(0);
            st().markTabExited(tab.id);
            fallBackToTerminal();
            toTerm((t) =>
              t.write(
                ansiErrorLines(describeError(e, STR.errors.actions.joinSession))
              )
            );
          } else {
            scheduleReconnect();
          }
        }
      };

      void connect();
    })();

    return () => {
      inst.disposed = true;
      if (inst.retryTimer !== null) window.clearTimeout(inst.retryTimer);
      if (inst.pingTimer !== null) window.clearInterval(inst.pingTimer);
      if (inst.joinId) {
        const id = inst.joinId;
        import("@tauri-apps/api/core").then(({ invoke }) =>
          invoke("remote_leave", { id }).catch(() => {})
        );
      }
      instRef.current = null;
      invokeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  const showViewport = inSplitPane && viewport !== null;
  return (
    <RemoteSessionPane
      kind={kind}
      terminal={{
        active,
        attach: attachTerm,
        sendInput,
        sendViewport,
        onViewportHint: (next) =>
          setViewport((previous) =>
            sameHint(previous, next) ? previous : next,
          ),
        imageMemoryMb: terminalImageMemoryMb(),
      }}
      agent={{
        events: agentState.events ?? [],
        access: agentState.access,
        notice: agentState.notice,
        onDismissNotice: () =>
          setAgentState((state) => ({ ...state, notice: null })),
        actions: instRef.current?.joinId ? agentActions : null,
        reconnectAttempt,
      }}
      readOnly={readOnly}
      reconnectAttempt={reconnectAttempt}
      viewport={viewport}
      showViewport={showViewport}
    />
  );
}
