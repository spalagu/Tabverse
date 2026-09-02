import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShareAccess, RemoteHostMsgPayload } from "@tabverse/runtime-contracts";
import { b64decode, b64encode } from "@tabverse/remote-client/b64";
import {
  isDeliberateEnd,
  isPermanentJoinError,
  reconnectDelayMs,
} from "@tabverse/workbench/remote-reconnect";
import {
  describeError,
  describeSessionEnd,
  errorText,
} from "@tabverse/workbench/strings/errors";
import { STR, plural } from "@tabverse/workbench/strings";
import { type TermSink } from "@tabverse/workbench/terminal/viewer";
import { Toolbar } from "./Toolbar";
import { TOOLBAR_BYTES, applyStickyCtrl, type ToolbarKey } from "./toolbarKeys";
import { ticketFromHash } from "./ticket";
import { useVisualViewportHeight } from "./useVisualViewport";
import { loadWasm } from "@tabverse/runtime-remote/wasm-loader";
import type { WasmSession } from "@tabverse/runtime-remote/wasm-api";
import {
  AppShareShell,
  defaultFitFor,
  useWideForm,
} from "@tabverse/workbench/app-shell";
import {
  applyMirrorAction,
  applyContributionState,
  mirrorSinks,
  remoteTabDefinitions,
  remoteTabSupportsPrivateStream,
  resetRemoteMirror,
  useRemoteMirrorStore,
} from "@tabverse/runtime-remote/app-mirror";
import {
  manualCopy,
  dismissManualClip,
  onManualClipNeeded,
  reconcilePaste,
  resetHostClip,
} from "@tabverse/remote-client/clipboard";
import {
  createAppChannel,
  dispatchAppFrame,
  isAppFrame,
  type AppFrameSinks,
  type AppHostFrame,
} from "@tabverse/remote-client/app-frame";
import { createContributionChannel } from "@tabverse/remote-client/contribution-channel";
import {
  createBrowserStreamClient,
  createProxyClient,
  installProxyFetchPatch,
  proxyUrlFor,
  targetFromProxyUrl,
  type ProxyClient,
} from "@tabverse/remote-client/proxy-fetch";
import { joinPluginComposition } from "./pluginComposition";
import {
  JoinPluginTabView,
  installJoinTabViews,
  type JoinTabViewContext,
} from "./pluginViews";
import type { RemoteMirrorTab } from "@tabverse/runtime-remote/app-mirror";

/** The wasm client has no dial timeout of its own (the desktop library uses
 * 20s); race the join against this so a dead relay counts as an unexpected
 * failure instead of hanging "connecting…" forever. */
const JOIN_TIMEOUT_MS = 20_000;

const OPTIMISTIC_APP_ACTIONS: Record<string, true> = { activateTab: true };

/** Channel payload from the host. `mode` is typed here until the shared
 * payload union in backend/types.ts picks the frame up (same note as the
 * app's RemoteView). */
type HostMsg =
  | RemoteHostMsgPayload
  | AppHostFrame
  | { type: "mode"; readOnly: boolean; access?: ShareAccess };

/** Which renderer this share gets. Decided by the welcome's tabType; null
 * until the host has said (or the join has failed for good). */
type RendererKind = "terminal" | "app";

type StatusKind = "idle" | "busy" | "live" | "bad";

/** The mutable connection state, kept out of React state on purpose: timers,
 * generation counters and the wasm session are lifecycle, not rendering. */
interface Inst {
  session: WasmSession | null;
  pingTimer: number;
  retryTimer: number;
  retryAttempt: number;
  /** Invalidates callbacks of superseded connection attempts: teardown and
   * every retry bump it, and stale events compare against it. */
  connectGen: number;
  closing: boolean;
  readOnly: boolean;
  ctrlArmed: boolean;
  kind: RendererKind | null;
  attachmentId: string | null;
  attachmentGeneration: number | null;
  /** The mounted terminal renderer, once there is one. */
  sink: TermSink | null;
  /** Terminal ops issued before the renderer was known or mounted. */
  pending: Array<(sink: TermSink) => void>;
}

/** Input logging is available only in the local development server. */
const debugInput =
  import.meta.env.DEV && new URLSearchParams(location.search).has("debug");

/** The browser CI build can replay host frames without a live desktop host. */
const replayMode =
  import.meta.env.VITE_JOIN_TEST_HARNESS === "1" &&
  new URLSearchParams(location.search).has("replay");

function JoinApp() {
  const instRef = useRef<Inst | null>(null);
  if (!instRef.current) {
    instRef.current = {
      session: null,
      pingTimer: 0,
      retryTimer: 0,
      retryAttempt: 0,
      connectGen: 0,
      closing: false,
      readOnly: false,
      ctrlArmed: false,
      kind: null,
      attachmentId: null,
      attachmentGeneration: null,
      sink: null,
      pending: [],
    };
  }
  const inst = instRef.current;

  const [ticket, setTicket] = useState(() => ticketFromHash(location.hash));
  const [status, setStatus] = useState<{ text: string; kind: StatusKind }>({
    text: STR.remote.web.pasteToBegin,
    kind: "idle",
  });
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [tabTitle, setTabTitle] = useState("");
  const [viewers, setViewers] = useState<number | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [kind, setKind] = useState<RendererKind | null>(null);
  const [, setReconnectAttempt] = useState(0);
  const [showGate, setShowGate] = useState(true);
  const [showStage, setShowStage] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  /** The fit default is form- and kind-dependent (see defaultFitFor): a
 * gridless app share on a phone starts at 100% with the pane's own
 * scroll instead of crushing the host's desktop grid. The toolbar's
 * toggle is the user's word — once flipped, it is never overridden. */
  const wideForm = useWideForm();
  const [fitMode, setFitMode] = useState(true);
  const fitTouched = useRef(false);
  useEffect(() => {
    if (!fitTouched.current) setFitMode(defaultFitFor(kind, wideForm));
  }, [kind, wideForm]);
  const [fitLabel, setFitLabel] = useState<string>(STR.remote.web.fit);
  /** The host's tab list and folder tree for the app shell. The remote
   * mirror rows implement the shared presentation DTOs directly, so the
   * arrays pass through without per-field copies. */
  const mirrorTabs = useRemoteMirrorStore((s) => s.tabs);
  const mirrorGroups = useRemoteMirrorStore((s) => s.groups);
  /** The host's active tab, subscribed for the same reason as the list:
   * the optimistic activateTab replay and the host's actionApplied
   * broadcast can each change it alone, and a render-time getState() read
   * would go stale until something else re-rendered the page. */
  const mirrorActiveId = useRemoteMirrorStore((s) => s.activeTabId);

  const proxy = useMemo<ProxyClient>(
    () =>
      createProxyClient((id, head, body) => {
        inst.session?.sendProxyReq(BigInt(id), head, body);
      }),
    [inst]
  );

  const browserStream = useMemo(
    () => createBrowserStreamClient(
      {
        open: (frame) => inst.session?.sendBrowserOpen(
          BigInt(frame.streamId),
          frame.tabId,
          frame.grantId,
          frame.attachmentId,
          BigInt(frame.attachmentGeneration),
          frame.method,
          frame.url,
          frame.headers,
          frame.bodyLen === undefined ? undefined : BigInt(frame.bodyLen),
        ),
        requestChunk: (streamId, seq, b64) =>
          inst.session?.sendBrowserRequestChunk(BigInt(streamId), BigInt(seq), b64),
        requestEnd: (streamId) => inst.session?.sendBrowserRequestEnd(BigInt(streamId)),
        credit: (streamId, bytes) =>
          inst.session?.sendBrowserCredit(BigInt(streamId), BigInt(bytes)),
        cancel: (streamId, reason) =>
          inst.session?.sendBrowserCancel(BigInt(streamId), reason),
      },
      () => inst.attachmentId === null || inst.attachmentGeneration === null
        ? null
        : { id: inst.attachmentId, generation: inst.attachmentGeneration },
    ),
    [inst],
  );

  /** The app-frame sinks with the proxy owner attached: the mirror
   * hears actions and snapshots, the clipboard channel hears clipSync,
   * and proxyRes settles onto the client above (the no-op sink
   * mirrorSinks ships for terminal-only joins is overridden here). */
  const appSinks = useMemo<AppFrameSinks>(
    () => ({
      ...mirrorSinks(),
      onProxy: (id, head, body) => proxy.settle(id, head, body),
    }),
    [proxy]
  );

  const appChannel = useMemo(
    () =>
      createAppChannel((id, cmd, args) => {
        inst.session?.sendRpc(BigInt(id), cmd, args);
      }),
    [inst]
  );

  const contributionChannel = useMemo(
    () => createContributionChannel({
      resolve: async (kind, tabId) => {
        const instance = await joinPluginComposition().createInstance(kind, `remote:${tabId}`);
        const contribution = instance.contribution.remote;
        if (contribution === undefined) {
          await instance.dispose();
          throw new Error(`tab contribution is not remote-capable: ${kind}`);
        }
        return {
          contribution,
          dispose: () => instance.dispose(),
        };
      },
      sendAck: (tabId, epoch, frameSeq) => {
        inst.session?.sendRemoteAck(tabId, epoch, frameSeq);
      },
      requestSnapshot: (tabId, epoch) => {
        inst.session?.requestRemoteSnapshot(tabId, epoch);
      },
      onState: (tabId, tabKind, state) => {
        applyContributionState(tabId, tabKind, state);
      },
    }),
    [inst],
  );

  useEffect(() => () => {
    void contributionChannel.dispose();
  }, [contributionChannel]);

  /** The pane's fetch handle — the client above, nothing more. */
  /** The selected host row. Workbench owns dispatch from its type to a View. */
  const activeMirrorTab = useMemo(
    () => mirrorTabs.find((tab) => tab.id === mirrorActiveId) ?? null,
    [mirrorTabs, mirrorActiveId],
  );

  const fetchViaHost = useCallback(
    (url: string) => {
      if (
        activeMirrorTab === null ||
        !remoteTabSupportsPrivateStream(activeMirrorTab.type, "browser.http")
      ) {
        return Promise.reject(new Error("active Tab has no browser.http stream"));
      }
      return browserStream.requestViaHost(activeMirrorTab.id, url);
    },
    [activeMirrorTab, browserStream],
  );

  const [manualClip, setManualClip] = useState<string | null>(null);
  useEffect(
    () =>
      onManualClipNeeded((text) => {
        setManualClip(text);
      }),
    [],
  );

  const filesOpenDir = useRemoteMirrorStore((s) => s.filesOpenDir);
  const filesOpenPath = useRemoteMirrorStore((s) => s.filesOpenPath);

  useEffect(() => {
    if (!connected || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const d = event.data as { type?: string; url?: string };
      const url = d?.url;
      if (d?.type !== "tabverse-proxy-fetch" || typeof url !== "string") return;
      const port = (event as MessageEvent & { ports: MessagePort[] }).ports[0];
      if (port === undefined) return;
      void (async () => {
        try {
          const target = targetFromProxyUrl(new URL(url));
          if (target === null) throw new Error("not a proxy endpoint url");
          if (
            activeMirrorTab === null ||
            !remoteTabSupportsPrivateStream(activeMirrorTab.type, "browser.http")
          ) {
            throw new Error("active Tab has no browser.http stream");
          }
          const res = await browserStream.requestViaHost(activeMirrorTab.id, target);
          const buf = new Uint8Array(await res.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) {
            bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          }
          port.postMessage({
            status: res.status,
            contentType: res.headers.get("content-type") ?? "",
            finalUrl: res.headers.get("x-tabverse-final-url") ?? target,
            bodyB64: btoa(bin),
          });
        } catch {
          port.postMessage({ status: 502, contentType: "", bodyB64: "" });
        }
      })();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [activeMirrorTab, browserStream, connected]);

  useEffect(() => {
    if (!connected) return;
    return installProxyFetchPatch({ requestViaProxy: fetchViaHost });
  }, [connected, fetchViaHost]);

  const [ctrlArmed, setCtrlArmed] = useState(false);

  useVisualViewportHeight();

  const setStatusLine = useCallback((text: string, k: StatusKind) => {
    setStatus({ text, kind: k });
    // Anything that is not a failure clears the failure detail with it.
    if (k !== "bad") setStatusDetail(null);
  }, []);

  const toTerm = useCallback(
    (op: (sink: TermSink) => void) => {
      if (inst.sink) op(inst.sink);
      else inst.pending.push(op);
    },
    [inst]
  );

  /** The terminal renderer plugs in here on mount; buffered ops replay so a
   * snapshot that raced the mount is not lost. Returns the detach fn. */
  const attachTerm = useCallback(
    (sink: TermSink) => {
      inst.sink = sink;
      const ops = inst.pending;
      inst.pending = [];
      for (const op of ops) op(sink);
      return () => {
        if (inst.sink === sink) inst.sink = null;
      };
    },
    [inst]
  );

  /** Release the live session without touching the page chrome. Proxy
   * waiters go with it: a pane mid-fetch surfaces the drop as an error
   * instead of riding out its own budget. */
  const dropSession = useCallback(() => {
    if (inst.pingTimer) window.clearInterval(inst.pingTimer);
    inst.pingTimer = 0;
    inst.session?.leave();
    inst.session = null;
    proxy.failAll("the session ended");
    browserStream.failAll("the session ended");
    appChannel.failAll("the session ended");
    inst.attachmentId = null;
    inst.attachmentGeneration = null;
    setConnected(false);
  }, [appChannel, browserStream, inst, proxy]);
  const cancelRetry = useCallback(() => {
    if (inst.retryTimer) window.clearTimeout(inst.retryTimer);
    inst.retryTimer = 0;
    inst.retryAttempt = 0;
    setReconnectAttempt(0);
  }, [inst]);

  /** Terminal state: deliberate end, user leave, or an unusable ticket.
   * Cancels any pending retry — this is the "never retry" path. */
  const teardown = useCallback(
    (reason: string, detail?: string) => {
      if (inst.closing) return;
      inst.closing = true;
      inst.connectGen += 1;
      cancelRetry();
      dropSession();
      inst.readOnly = false;
      setReadOnly(false);
      setStatusLine(reason, "bad");
      setStatusDetail(detail ?? null);
      setConnectBusy(false);
      setShowGate(true);
      // Allow a fresh connect attempt to report status again.
      setTimeout(() => {
        inst.closing = false;
      }, 500);
      // The clipboard channel's memory dies with the session: residue
      // from one share must not shape the next (a terminal share has no
      // channel, and its pastes have nothing to reconcile against).
      resetHostClip();
      resetRemoteMirror();
    },
    [cancelRetry, dropSession, inst, setStatusLine]
  );

  // connect() and scheduleReconnect() call each other; a ref breaks the cycle
  // without re-creating either per render.
  const connectRef = useRef<() => Promise<void>>(async () => {});

  // The controlled ticket state, mirrored for the connect closure (a retry
  // fired from a timer must read what is in the box now, not at bind time).
  const ticketRef = useRef(ticket);
  useEffect(() => {
    ticketRef.current = ticket;
  }, [ticket]);

  /** Unexpected loss: keep the stage up, back off exponentially, retry
   * forever. A successful rejoin (welcome frame) resets the backoff. */
  const scheduleReconnect = useCallback(() => {
    if (inst.closing || inst.retryTimer) return;
    inst.connectGen += 1;
    dropSession();
    inst.retryAttempt += 1;
    setReconnectAttempt(inst.retryAttempt);
    setStatusLine(
      STR.remote.reconnectChip({ attempt: inst.retryAttempt }),
      "busy"
    );
    // The gate's Connect button doubles as "retry now" while it is visible.
    setConnectBusy(false);
    inst.retryTimer = window.setTimeout(() => {
      inst.retryTimer = 0;
      void connectRef.current();
    }, reconnectDelayMs(inst.retryAttempt));
  }, [dropSession, inst, setStatusLine]);

  const handle = useCallback(
    (msg: HostMsg) => {
      // The app family first: its frames never reach the terminal branch.
      // The proxy client gets the
      // first offer — the host answers a ProxyReq it could not run with
      // an rpcResult carrying the same id, and only the ids it is
      // waiting on are claimed; every other frame falls to the sinks.
      if (isAppFrame(msg)) {
        if (browserStream.consume(msg)) return;
        if (
          msg.type === "contributionSnapshot" ||
          msg.type === "contributionFrame"
        ) {
          void contributionChannel.consume(msg as AppHostFrame);
          return;
        }
        if (!proxy.consumeRpcResult(msg) && !appChannel.consume(msg as Record<string, unknown>)) {
          dispatchAppFrame(msg, appSinks);
        }
        return;
      }
      switch (msg.type) {
        case "welcome": {
          // The host accepted us (again) — a successful rejoin resets the
          // backoff so the next drop starts over at 1s.
          inst.retryAttempt = 0;
          setReconnectAttempt(0);
          setTabTitle(msg.tabTitle);
          inst.attachmentId = msg.attachmentId ?? null;
          inst.attachmentGeneration = msg.attachmentGeneration ?? null;
          // The welcome names the share's kind (absent = terminal). Whole-app
          // and one-tab contribution shares both mount the app shell; the
          // contribution snapshot decides whether that shell contains one or
          // many tabs.
          const k: RendererKind =
            msg.tabType === "app" || msg.tabType === "contribution"
              ? "app"
              : "terminal";
          if (inst.kind !== k) {
            inst.kind = k;
            if (k === "app") inst.pending = [];
            setKind(k);
          }
          // A gridless app share travels 0x0 here: its viewers
          // lay their own chrome out. xterm refuses a 0x0 resize, so the
          // fit op waits for the terminal-bearing frames that DO carry a
          // real grid (a tab share's welcome, an app share's terminal
          // snapshot).
          if (msg.cols > 0 && msg.rows > 0) {
            toTerm((t) => {
              t.resize(msg.cols, msg.rows);
              t.rescale();
            });
          }
          setStatusLine(STR.remote.web.connected, "live");
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
          setViewers(msg.viewers);
          break;
        case "end":
          // Host-sent End is deliberate (stopped/kicked/expired): terminal,
          // no retry. The client library folds transport loss into a
          // synthesized End with a recognizable reason — that one reconnects.
          if (isDeliberateEnd(msg.reason)) {
            const ended = describeSessionEnd(msg.reason);
            teardown(ended.line, ended.detail);
          } else {
            scheduleReconnect();
          }
          break;
        case "pong":
          break;
      }
    },
    [appChannel, appSinks, browserStream, contributionChannel, inst, proxy, scheduleReconnect, setStatusLine, teardown, toTerm]
  );

  const handleRef = useRef(handle);
  useEffect(() => {
    handleRef.current = handle;
  }, [handle]);

  const connect = useCallback(async () => {
    const t = ticketRef.current.trim();
    if (!t) return;
    // One attempt in flight at a time: a manual click while a retry is
    // pending replaces that retry instead of racing it.
    if (inst.retryTimer) {
      window.clearTimeout(inst.retryTimer);
      inst.retryTimer = 0;
    }
    const gen = ++inst.connectGen;
    setConnectBusy(true);
    if (inst.retryAttempt === 0)
      setStatusLine(STR.remote.web.loadingClient, "busy");
    try {
      // Load the icon font before any terminal is measured: xterm sizes its
      // cell grid from the fonts available at open() time, and a webfont
      // that lands afterwards would leave every icon the wrong width.
      if (document.fonts) {
        // Probe with a glyph the font actually has: the default probe string
        // is Latin, and this font carries icons only.
        await document.fonts
          .load('13px "Tabverse Symbols"', "\ue0b0")
          .catch(() => {});
      }
      const wasm = await loadWasm();
      if (inst.retryAttempt === 0)
        setStatusLine(STR.remote.web.connectingRelay, "busy");
      const joining = wasm.joinShare(t, browserName(), (json) => {
        // Frames from a superseded connection (torn down, or a join that
        // timed out here but resolved later) must not touch current state.
        if (gen !== inst.connectGen) return;
        try {
          handleRef.current(JSON.parse(json) as HostMsg);
        } catch {
          // A malformed frame is not worth killing the session over.
        }
      });
      // If the dial resolves after this attempt was superseded (timed out
      // below, user left, or a newer attempt started), close the orphan so
      // it does not linger on the relay.
      void joining
        .then((s) => {
          if (gen !== inst.connectGen) s.leave();
        })
        .catch(() => {});
      const fresh = await Promise.race([
        joining,
        new Promise<never>((_, reject) =>
          window.setTimeout(
            () => reject(new Error("join timeout")),
            JOIN_TIMEOUT_MS
          )
        ),
      ]);
      if (gen !== inst.connectGen) return;
      inst.session = fresh;
      // This channel survives transport reconnects. Existing cursors ask
      // the new attachment for same-epoch replay; a first join has none.
      await contributionChannel.resume();
      setConnected(true);
      setShowGate(false);
      setShowStage(true);
      // The welcome frame often lands before joinShare resolves, so the
      // report attempted at terminal creation found session still null.
      // Report again now that both exist (setTimeout also fires in
      // background tabs, where rAF is frozen).
      requestAnimationFrame(() => toTerm((s) => s.reportViewport()));
      setTimeout(() => toTerm((s) => s.reportViewport()), 400);
      setTimeout(() => toTerm((s) => s.reportViewport()), 1500);
      // Keep the relay path warm and notice a dead peer.
      inst.pingTimer = window.setInterval(() => inst.session?.ping(), 10_000);
      toTerm((s) => s.reportViewport());
    } catch (e) {
      if (gen !== inst.connectGen) return;
      const message = errorText(e);
      // If the dial eventually succeeds after losing the timeout race, that
      // orphan session must not linger on the relay.
      if (message.includes("join timeout")) {
        inst.connectGen += 1;
      }
      if (isPermanentJoinError(message)) {
        // A bad ticket fails identically forever; retrying would loop with
        // no hope. Show it and hand control back.
        const d = describeError(e, STR.errors.actions.connect);
        teardown(d.next ? `${d.title} ${d.next}` : d.title, d.detail);
      } else {
        scheduleReconnect();
      }
    }
  }, [contributionChannel, inst, scheduleReconnect, setStatusLine, teardown, toTerm]);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  /** Input from the terminal renderer or the toolbar, one gate for both:
   * read-only drops it (UX only — the host drops input from read-only
   * viewers authoritatively), the sticky Ctrl transforms the next key. */
  const onTermInput = useCallback(
    (data: string) => {
      if (inst.readOnly) return;
      const r = applyStickyCtrl(data, inst.ctrlArmed);
      if (r.consumed) {
        inst.ctrlArmed = false;
        setCtrlArmed(false);
      }
      inst.session?.sendInput(b64encode(r.bytes));
    },
    [inst]
  );

  const onToolbarKey = useCallback(
    (key: ToolbarKey) => {
      if (inst.readOnly) return;
      // Toolbar keys are their own encodings; the sticky Ctrl applies to
      // typed letters, not to these.
      inst.session?.sendInput(b64encode(TOOLBAR_BYTES[key]));
    },
    [inst]
  );

  const onCtrlToggle = useCallback(() => {
    inst.ctrlArmed = !inst.ctrlArmed;
    setCtrlArmed(inst.ctrlArmed);
  }, [inst]);

  const onSummonKeyboard = useCallback(() => {
    // xterm's helper textarea is a real focusable element; focusing it from
    // this user gesture is what raises the soft keyboard.
    toTerm((t) => t.focus());
  }, [toTerm]);

  const sendViewport = useCallback(
    (cols: number, rows: number) => {
      inst.session?.viewport(cols, rows);
    },
    [inst]
  );

  /** The app shell's send side: one gate for every host-bound action.
   * View level is dropped before the wire (UX only — the host gates Steer
   * authoritatively, the same double cover the terminal input uses), Steer
   * goes out as an action frame, and the light UI actions replay locally
   * so the click answers immediately. */
  const onAppAction = useCallback(
    (name: string, args: unknown) => {
      if (inst.readOnly) return;
      if (replayMode) {
        const replayWindow = window as unknown as Record<string, unknown>;
        const actions = replayWindow.__replayActions as Array<{ name: string; args: unknown }> | undefined;
        actions?.push({ name, args });
      }
      inst.session?.sendAction(name, args);
      if (OPTIMISTIC_APP_ACTIONS[name] === true) applyMirrorAction(name, args);
    },
    [inst]
  );

  const onMirrorCopy = useCallback(
    (text: string) => {
      if (!text) return;
      void navigator.clipboard.writeText(text).catch(() => {});
      if (inst.kind === "app" && !inst.readOnly) {
        inst.session?.sendClipPush(text);
      }
    },
    [inst]
  );

  const onMirrorPaste = useCallback(
    (text: string) => {
      if (inst.kind !== "app" || inst.readOnly) return;
      reconcilePaste(text, (t) => inst.session?.sendClipPush(t));
    },
    [inst]
  );

  // Page lifetime wiring: pagehide = user-initiated disconnect (no retry may
  // survive it), plus hash auto-connect and the browser-CI replay seam.
  useEffect(() => {
    const onPageHide = () => {
      if (inst.retryTimer) window.clearTimeout(inst.retryTimer);
      inst.retryTimer = 0;
      inst.connectGen += 1;
      inst.session?.leave();
    };
    window.addEventListener("pagehide", onPageHide);
    if (replayMode) {
      const replayWindow = window as unknown as Record<string, unknown>;
      replayWindow.__replayActions = [];
      replayWindow.__replayFrame = (
        frame: unknown
      ) => {
        setShowGate(false);
        setShowStage(true);
        handleRef.current(frame as HostMsg);
      };
    } else if (ticketRef.current) {
      // The fragment promised "click the link, you're in", so connect
      // without waiting for a click. On failure teardown() restores the
      // manual state: the ticket stays editable and Connect works as usual.
      void connectRef.current();
    }
    return () => window.removeEventListener("pagehide", onPageHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConnectClick = useCallback(() => {
    // A click is fresh user intent: restart the backoff from scratch.
    cancelRetry();
    void connectRef.current();
  }, [cancelRetry]);

  const onLeaveClick = useCallback(() => {
    teardown("disconnected");
    setShowStage(false);
    setKind(null);
    inst.kind = null;
    inst.pending = [];
    setTabTitle("");
    setViewers(null);
  }, [inst, teardown]);

  /** Transport facts are injected once; each enabled contribution owns its renderer. */
  const remoteViewContext: JoinTabViewContext = {
    terminal: {
      attach: attachTerm,
      onInput: onTermInput,
      sendViewport,
      fitMode,
      onScaleLabel: setFitLabel,
      debugInput,
      onCopy: onMirrorCopy,
      onPaste: onMirrorPaste,
    },
    files: {
      openPath: filesOpenPath,
      openDir: filesOpenDir,
      rpc: appChannel.rpc,
      readOnly,
    },
    browser: {
      requestViaHost: (tabId, url) => browserStream.requestViaHost(tabId, url),
      resolveProxyUrl: proxyUrlFor,
    },
  };

  const directShareTab: RemoteMirrorTab | null =
    kind === "terminal"
      ? {
          id: `shared-${kind}`,
          type: kind,
          title: tabTitle || `Shared ${kind}`,
          groupId: null,
        }
      : null;

  return (
    <div id="app">
      <header>
        <span className="brand">Tabverse</span>
        <span className="tabtitle">{tabTitle}</span>
        <span className="spacer" />
        {viewers !== null && (
          <span className="viewers">{plural(viewers, "viewer")}</span>
        )}
        {readOnly && (
          <span
            className="badge-ro"
            title="The host shared this tab as view-only; keystrokes are not sent"
          >
            {STR.remote.viewOnlyChip}
          </span>
        )}
        {(kind === "terminal" || kind === "app") && showStage && (
          <button
            className="ghost"
            id="zoom"
            title="Fit the host's screen, or show it at actual size"
            onClick={() => {
              fitTouched.current = true;
              setFitMode((f) => !f);
            }}
          >
            {fitLabel}
          </button>
        )}
        <span className={`status ${status.kind}`}>{status.text}</span>
        {connected && (
          <button className="ghost" id="leave" onClick={onLeaveClick}>
            Leave
          </button>
        )}
      </header>

      <main>
        {showGate && (
          <section id="gate">
            <h1>Control a shared terminal</h1>
            {statusDetail && (
              <details className="status-detail">
                <summary>Details</summary>
                <pre>{statusDetail}</pre>
              </details>
            )}
            <p>
              Paste the ticket from the Tabverse tab you shared. The
              connection is end-to-end encrypted — it travels through a
              public relay that can never read what it carries.
            </p>
            <textarea
              id="ticket"
              autoComplete="off"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
            />
            <div className="row">
              <button id="connect" disabled={connectBusy} onClick={onConnectClick}>
                Connect
              </button>
              <span className="note" style={{ margin: 0 }}>
                No account, no server, nothing to install.
              </span>
            </div>
            {!__JOIN_PAGES_BUILD__ && (
              <p className="note">
                This page is one self-contained file — you can keep a copy
                anywhere and open it straight from disk. A ticket after{" "}
                <code>#</code> in the address connects on load, and never
                leaves your machine.
              </p>
            )}
          </section>
        )}

        {manualClip !== null && (
          <div className="clip-panel" role="status">
            <span className="clip-panel-text" title={manualClip}>
              The host copied something the browser would not write without
              a click.
            </span>
            <button
              type="button"
              onClick={() => {
                void manualCopy().then((ok) => {
                  if (ok) setManualClip(null);
                });
              }}
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                dismissManualClip();
                setManualClip(null);
              }}
            >
              Dismiss
            </button>
          </div>
        )}


        <section id="stage" hidden={!showStage}>
          {directShareTab !== null ? (
            <JoinPluginTabView
              tab={directShareTab}
              context={remoteViewContext}
              composition={joinPluginComposition()}
            />
          ) : kind === "app" ? (
            <AppShareShell
              tabs={mirrorTabs}
              groups={mirrorGroups}
              activeId={mirrorActiveId}
              readOnly={readOnly}
              tabDefinitions={remoteTabDefinitions()}
              onSelect={(id) => onAppAction("activateTab", id)}
              onCreateTab={
                readOnly
                  ? undefined
                  : (type, initial) => onAppAction("addTab", { type, ...initial })
              }
              onToggleGroup={
                readOnly ? undefined : (id) => onAppAction("toggleGroupCollapsed", id)
              }
            >
              <JoinPluginTabView
                tab={activeMirrorTab}
                context={remoteViewContext}
                composition={joinPluginComposition()}
              />
            </AppShareShell>
          ) : (
            <div className="remote-connecting">Connecting to remote session…</div>
          )}
        </section>
      </main>

      {kind === "terminal" && showStage && (
        <Toolbar
          ctrlArmed={ctrlArmed}
          onKey={onToolbarKey}
          onCtrlToggle={onCtrlToggle}
          onSummonKeyboard={onSummonKeyboard}
          onCopy={() => {
            // The toolbar's Copy: a touch device has no Ctrl+Shift+C, and
            // xterm's selection is not a DOM selection the browser's own
            // menu could take. The same one copy route as the keyboard's
            // copy — board write here, push-back when an app share lives.
            const text = inst.sink?.getSelection() ?? "";
            if (text) onMirrorCopy(text);
          }}
        />
      )}
    </div>
  );
}

installJoinTabViews();

export function App() {
  return <JoinApp />;
}

function browserName(): string {
  const ua = navigator.userAgent;
  const which = /Firefox/.test(ua)
    ? "Firefox"
    : /Edg/.test(ua)
      ? "Edge"
      : /Chrome/.test(ua)
        ? "Chrome"
        : /Safari/.test(ua)
          ? "Safari"
          : "browser";
  return `${which} (web)`;
}
