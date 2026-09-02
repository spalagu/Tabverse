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
}

export interface BrowserRemoteFrame {
  readonly type: "replace";
  readonly state: BrowserTabState;
}

export interface BrowserRuntimeService {
  readonly runtimeKind: BrowserTabViewRequest["runtimeKind"];
  readonly remoteState?: RemoteStateProvider<BrowserTabState, BrowserRemoteFrame>;
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
          render: (args) => args.services.get(BROWSER_RUNTIME_SERVICE).render(args),
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
        remote: runtime.remoteState === undefined ? undefined : {
          protocol: { name: "browser-semantic", minVersion: 4, maxVersion: 4 },
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
