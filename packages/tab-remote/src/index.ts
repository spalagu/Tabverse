import {
  serviceToken,
  type ContinuousResidentContribution,
  type InstalledPlugin,
  type TabRendererArgs,
} from "@tabverse/tab-contracts";

export const REMOTE_PLUGIN_ID = "tabverse.tab.remote";
export const REMOTE_KIND = "remote";
export const REMOTE_STATE_VERSION = 1;

export interface RemoteTabState extends Readonly<Record<string, unknown>> {
  readonly title?: string;
  readonly joinTicket?: string;
  readonly remoteViewers?: number;
}

export interface RemoteTabViewRequest extends TabRendererArgs<RemoteTabState> {
  readonly runtimeKind: "desktop" | "test";
  readonly kind: typeof REMOTE_KIND;
}

export interface RemoteRuntimeService {
  readonly runtimeKind: RemoteTabViewRequest["runtimeKind"];
  readonly resident?: ContinuousResidentContribution<RemoteTabState, RemoteTabState>;
  render(args: TabRendererArgs<RemoteTabState>): unknown;
}

export const REMOTE_RUNTIME_SERVICE = serviceToken<RemoteRuntimeService>(
  "tabverse.remote.runtime.v1",
);

export function createRemoteRuntimePlugin(options: {
  readonly id: string;
  readonly service: RemoteRuntimeService;
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
      context.provide(REMOTE_RUNTIME_SERVICE, options.service);
    },
  };
}

function parseState(input: unknown): RemoteTabState {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("remote state must be an object");
  }
  return input as RemoteTabState;
}

/** A Remote tab joins another host locally; nested remote rendering is unsupported. */
export function createRemotePlugin(options: {
  readonly runtimePluginId: string;
}): InstalledPlugin {
  return {
    manifest: {
      id: REMOTE_PLUGIN_ID,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [{ id: options.runtimePluginId, range: "^1.0.0" }],
      tabs: [REMOTE_KIND],
      builtIn: true,
      enabledByDefault: true,
    },
    activate(context) {
      const runtime = context.get(REMOTE_RUNTIME_SERVICE);
      context.contributeTab<RemoteTabState>({
        manifest: {
          kind: REMOTE_KIND,
          version: 1,
          stateVersion: REMOTE_STATE_VERSION,
          presentation: {
            label: "Join remote…",
            hint: "Join a shared Tabverse session",
            icon: "remote",
            order: 40,
            launch: "dialog",
          },
        },
        view: {
          requiredServices: [REMOTE_RUNTIME_SERVICE],
          render: (args) => args.services.get(REMOTE_RUNTIME_SERVICE).render(args),
        },
        state: {
          parse: parseState,
          migrate: (input, from) => {
            if (from !== 0 && from !== REMOTE_STATE_VERSION) {
              throw new Error(`unsupported remote state version: ${from}`);
            }
            return parseState(input);
          },
        },
        resident: runtime.resident,
        permissions: [
          {
            capability: "remote.runtime",
            reason: "Join and control the session selected by this Remote tab",
          },
        ],
        fallback: "unsupported",
      });
    },
  };
}
