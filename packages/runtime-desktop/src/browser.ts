import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AsyncDisposable,
  BrowserCloseReason,
  BrowserCommandResult,
  BrowserEngine,
  BrowserEventEnvelope,
  BrowserSessionHandle,
  BrowserSessionPort,
  BrowserSessionSpec,
} from "@tabverse/tab-browser";

type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
type Listen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<UnlistenFn>;

interface NativeHandle {
  readonly tabId: string;
  readonly sessionGeneration: number;
  readonly engine: BrowserEngine;
}

interface NativeEvent {
  readonly tabId: string;
  readonly sessionGeneration: number;
  readonly eventSeq: number;
  readonly event: BrowserEventEnvelope["event"];
}

interface OwnedSession {
  readonly spec: BrowserSessionSpec;
  readonly handle: BrowserSessionHandle;
  attached: boolean;
}

const capabilities = {
  navigation: true,
  history: true,
  find: true,
  zoom: true,
  permissionPrompt: true,
  basicAuthPrompt: true,
  certificateErrorPrompt: true,
  download: true,
  popup: true,
  devtools: false,
  crashRecovery: true,
} as const;

/** Native Wry/CEF adapter; generation conversion is confined to the IPC seam. */
export function createTauriBrowserSessionPort(
  invoke: Invoke = tauriInvoke,
  listen: Listen = tauriListen,
): BrowserSessionPort {
  const sessions = new Map<string, OwnedSession>();
  let selectedEngine: BrowserEngine = "system-webview";

  return {
    get engine() {
      return selectedEngine;
    },
    capabilities,
    async ensureSession(spec) {
      const native = await invoke<NativeHandle>("browser_session_ensure", {
        tabId: spec.tabId,
        profileId: spec.profileId,
        initialUrl: spec.initialUrl,
        network: spec.network,
        privateMode: spec.privateMode,
      });
      selectedEngine = native.engine;
      const handle = {
        tabId: native.tabId,
        sessionGeneration: BigInt(native.sessionGeneration),
      };
      const current = sessions.get(spec.tabId);
      sessions.set(spec.tabId, {
        spec,
        handle,
        attached:
          current?.handle.sessionGeneration === handle.sessionGeneration
            ? current.attached
            : false,
      });
      return handle;
    },
    async attachSurface(tabId, slot) {
      const owned = sessions.get(tabId);
      if (owned === undefined) throw new Error("SESSION_GONE");
      const command = owned.attached ? "browser_set_bounds" : "browser_create";
      await invoke(command, {
        tabId,
        generation: Number(owned.handle.sessionGeneration),
        slotRevision: Number(slot.slotRevision),
        bounds: slot.bounds,
        visible: slot.visible ?? true,
      });
      owned.attached = true;
    },
    async command(tabId, command) {
      const owned = sessions.get(tabId);
      if (owned === undefined) return { ok: false, code: "SESSION_GONE" };
      return await invoke<BrowserCommandResult>("browser_session_command", {
        tabId,
        generation: Number(owned.handle.sessionGeneration),
        command,
      });
    },
    subscribe(tabId, sink): AsyncDisposable {
      let disposed = false;
      const pending = listen<NativeEvent>(
        "browser-session-event",
        ({ payload }) => {
          if (disposed || payload.tabId !== tabId) return;
          sink({
            tabId: payload.tabId,
            sessionGeneration: BigInt(payload.sessionGeneration),
            eventSeq: BigInt(payload.eventSeq),
            event: payload.event,
          });
        },
      );
      return {
        async dispose() {
          disposed = true;
          const unlisten = await pending;
          unlisten();
        },
      };
    },
    async closeSession(tabId, reason: BrowserCloseReason) {
      const owned = sessions.get(tabId);
      if (owned === undefined) return;
      await invoke("browser_close", {
        tabId,
        generation: Number(owned.handle.sessionGeneration),
        reason,
      });
      sessions.delete(tabId);
    },
  };
}
