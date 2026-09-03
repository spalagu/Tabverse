import {
  serviceToken,
  type ContinuousResidentContribution,
  type InstalledPlugin,
  type RemoteStateProvider,
  type TabRendererArgs,
} from "@tabverse/tab-contracts";

export const BROWSER_PLUGIN_ID = "tabverse.tab.browser";
export const BROWSER_KIND = "browser";
export const BROWSER_STATE_VERSION = 1;

export interface BrowserTabState extends Readonly<Record<string, unknown>> {
  readonly title?: string;
  readonly url?: string;
  readonly pinnedUrl?: string;
}

export interface BrowserTabViewRequest extends TabRendererArgs<BrowserTabState> {
  readonly runtimeKind: "desktop" | "remote" | "test";
  readonly kind: typeof BROWSER_KIND;
  readonly session?: BrowserSessionPort;
}

export interface BrowserRemoteFrame {
  readonly type: "replace";
  readonly state: BrowserTabState;
}

export interface AsyncDisposable {
  dispose(): void | Promise<void>;
}

/** Browser engines are provider choices; plugins never import Wry or CEF types. */
export type BrowserEngine = "system-webview" | "cef";

export type BrowserNetworkMode =
  | { readonly kind: "system" }
  | { readonly kind: "direct" }
  | {
      readonly kind: "doh";
      readonly resolverId: string;
      readonly fallback: "fail-closed" | "system";
    }
  | { readonly kind: "proxy"; readonly proxyId: string };

export interface BrowserEngineCapabilities {
  readonly navigation: true;
  readonly history: boolean;
  readonly find: boolean;
  readonly zoom: boolean;
  readonly permissionPrompt: boolean;
  readonly basicAuthPrompt: boolean;
  readonly certificateErrorPrompt: boolean;
  readonly download: boolean;
  readonly popup: boolean;
  readonly devtools: boolean;
  readonly crashRecovery: boolean;
}

export interface BrowserSessionSpec {
  readonly tabId: string;
  readonly profileId: string;
  readonly initialUrl: string;
  readonly network: BrowserNetworkMode;
  readonly privateMode: boolean;
}

export interface BrowserSessionHandle {
  readonly tabId: string;
  readonly sessionGeneration: bigint;
}

export interface BrowserSurfaceSlot {
  readonly slotId: string;
  readonly slotRevision: bigint;
  readonly ownerWindowId: string;
  readonly visible?: boolean;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export type BrowserCommand =
  | {
      readonly type: "navigate";
      readonly url: string;
      readonly navigationId: string;
    }
  | { readonly type: "reload" }
  | { readonly type: "stop" }
  | { readonly type: "back" }
  | { readonly type: "forward" }
  | { readonly type: "set-zoom"; readonly level: number }
  | {
      readonly type: "find";
      readonly query: string;
      readonly direction: "next" | "previous";
    }
  | {
      readonly type: "answer-prompt";
      readonly promptId: string;
      readonly decision: "allow-once" | "deny" | "cancel";
    };

export type BrowserCommandResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "SESSION_GONE"
        | "NO_HISTORY"
        | "UNSUPPORTED"
        | "STALE_GENERATION"
        | "INVALID_INPUT";
    };

export type BrowserCloseReason = "tab-close" | "plugin-disable" | "app-exit";

export interface BrowserEventEnvelope {
  readonly tabId: string;
  readonly sessionGeneration: bigint;
  readonly eventSeq: bigint;
  readonly event:
    | { readonly type: "session-ready" }
    | { readonly type: "navigation-started"; readonly url: string }
    | { readonly type: "navigation-committed"; readonly url: string }
    | { readonly type: "navigation-failed"; readonly safeMessage: string }
    | { readonly type: "title-changed"; readonly title: string }
    | {
        readonly type: "history-changed";
        readonly canBack: boolean;
        readonly canForward: boolean;
      }
    | { readonly type: "loading-changed"; readonly loading: boolean }
    | {
        readonly type: "permission-requested";
        readonly promptId: string;
        readonly capability: string;
      }
    | { readonly type: "auth-requested"; readonly promptId: string }
    | {
        readonly type: "download-requested";
        readonly downloadId: string;
        readonly filename: string;
      }
    | {
        readonly type: "download-progress";
        readonly downloadId: string;
        readonly received: number;
      }
    | { readonly type: "renderer-crashed" }
    | { readonly type: "session-closed"; readonly reason: BrowserCloseReason };
}

/**
 * Runtime-owned native session port. A Desktop build supplies either its Wry
 * or CEF implementation; both implementations must not be active together.
 */
export interface BrowserSessionPort {
  readonly engine: BrowserEngine;
  readonly capabilities: BrowserEngineCapabilities;
  ensureSession(spec: BrowserSessionSpec): Promise<BrowserSessionHandle>;
  attachSurface(tabId: string, slot: BrowserSurfaceSlot): Promise<void>;
  command(
    tabId: string,
    command: BrowserCommand,
  ): Promise<BrowserCommandResult>;
  subscribe(
    tabId: string,
    sink: (event: BrowserEventEnvelope) => void,
  ): AsyncDisposable;
  closeSession(tabId: string, reason: BrowserCloseReason): Promise<void>;
}

export interface BrowserRuntimeService {
  readonly runtimeKind: BrowserTabViewRequest["runtimeKind"];
  /** Present after the Desktop native provider has adopted the session port. */
  readonly session?: BrowserSessionPort;
  readonly remoteState?: RemoteStateProvider<
    BrowserTabState,
    BrowserRemoteFrame
  >;
  /** Host-network requests are continuous work; the WebView itself is not. */
  readonly residentNetworkTask?: ContinuousResidentContribution<
    BrowserTabState,
    BrowserTabState
  >;
  render(args: TabRendererArgs<BrowserTabState>): unknown;
}

export const BROWSER_RUNTIME_SERVICE = serviceToken<BrowserRuntimeService>(
  "tabverse.browser.runtime.v1",
);

export function createBrowserRuntimePlugin(options: {
  readonly id: string;
  readonly service: BrowserRuntimeService;
}): InstalledPlugin {
  return {
    manifest: {
      id: options.id,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [],
      tabs: [],
      builtIn: true,
      enabledByDefault: true,
    },
    activate(context) {
      context.provide(BROWSER_RUNTIME_SERVICE, options.service);
    },
  };
}

function parseState(input: unknown): BrowserTabState {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("browser state must be an object");
  }
  return input as BrowserTabState;
}

export function createBrowserPlugin(options: {
  readonly runtimePluginId: string;
}): InstalledPlugin {
  return {
    manifest: {
      id: BROWSER_PLUGIN_ID,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [{ id: options.runtimePluginId, range: "^1.0.0" }],
      tabs: [BROWSER_KIND],
      builtIn: true,
      enabledByDefault: true,
    },
    activate(context) {
      const runtime = context.get(BROWSER_RUNTIME_SERVICE);
      context.contributeTab<BrowserTabState>({
        manifest: {
          kind: BROWSER_KIND,
          version: 1,
          stateVersion: BROWSER_STATE_VERSION,
          presentation: {
            label: "Browser",
            hint: "Embedded web page, loaded by the host",
            icon: "browser",
            order: 30,
            groupLabel: "Browser",
            creation: {
              field: "url",
              fieldLabel: "Address to open as a browser tab on the host",
              placeholder: "http://intranet.example…",
              submitLabel: "Open",
              defaultScheme: "https",
            },
          },
        },
        view: {
          requiredServices: [BROWSER_RUNTIME_SERVICE],
          render: (args) =>
            args.services.get(BROWSER_RUNTIME_SERVICE).render(args),
        },
        state: {
          parse: parseState,
          migrate: (input, from) => {
            if (from !== 0 && from !== BROWSER_STATE_VERSION) {
              throw new Error(`unsupported browser state version: ${from}`);
            }
            return parseState(input);
          },
        },
        remote:
          runtime.remoteState === undefined
            ? undefined
            : {
                protocol: {
                  name: "browser-semantic",
                  minVersion: 4,
                  maxVersion: 4,
                },
                state: runtime.remoteState,
                client: {
                  fold: (_state, frame) => (frame as BrowserRemoteFrame).state,
                  render: (args) => runtime.render(args),
                },
                intents: [
                  {
                    name: "browser.navigate",
                    schema: {
                      id: "browser.navigate/v1",
                      validate: (input): input is { readonly url: string } =>
                        typeof input === "object" &&
                        input !== null &&
                        typeof (input as { url?: unknown }).url === "string",
                    },
                    minAccess: "steer",
                    idempotent: false,
                  },
                ],
                privateStreams: {
                  streams: [{ name: "browser.http", minAccess: "view" }],
                },
                fallback: "semantic-document",
              },
        resident: {
          capability: "state-only",
          runtimeKind: "browser",
          ...(runtime.residentNetworkTask === undefined
            ? {}
            : { continuousTasks: [runtime.residentNetworkTask] }),
        },
        permissions: [
          {
            capability: "browser.runtime",
            reason: "Render and navigate the page owned by this Browser tab",
          },
        ],
        fallback: "read-only",
      });
    },
  };
}
