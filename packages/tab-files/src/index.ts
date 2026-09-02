import {
  serviceToken,
  type InstalledPlugin,
  type RemoteStateProvider,
  type TabRendererArgs,
} from "@tabverse/tab-contracts";

export const FILES_PLUGIN_ID = "tabverse.tab.files";
export const FILES_KIND = "files";
export const FILES_STATE_VERSION = 1;

export interface FilesTabState extends Readonly<Record<string, unknown>> {
  readonly title?: string;
  readonly cwd?: string;
  readonly openPath?: string;
  readonly peek?: boolean;
}

export interface FilesTabViewRequest extends TabRendererArgs<FilesTabState> {
  readonly runtimeKind: "desktop" | "remote" | "test";
  readonly kind: typeof FILES_KIND;
}

export interface FilesRemoteFrame {
  readonly type: "replace";
  readonly state: FilesTabState;
}

export interface FilesRuntimeService {
  readonly runtimeKind: FilesTabViewRequest["runtimeKind"];
  readonly remoteState?: RemoteStateProvider<FilesTabState, FilesRemoteFrame>;
  render(args: TabRendererArgs<FilesTabState>): unknown;
}

export const FILES_RUNTIME_SERVICE = serviceToken<FilesRuntimeService>(
  "tabverse.files.runtime.v1",
);

export function createFilesRuntimePlugin(options: {
  readonly id: string;
  readonly service: FilesRuntimeService;
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
      context.provide(FILES_RUNTIME_SERVICE, options.service);
    },
  };
}

function parseState(input: unknown): FilesTabState {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("files state must be an object");
  }
  return input as FilesTabState;
}

export function createFilesPlugin(options: {
  readonly runtimePluginId: string;
}): InstalledPlugin {
  return {
    manifest: {
      id: FILES_PLUGIN_ID,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [{ id: options.runtimePluginId, range: "^1.0.0" }],
      tabs: [FILES_KIND],
      builtIn: true,
      enabledByDefault: true,
    },
    activate(context) {
      const runtime = context.get(FILES_RUNTIME_SERVICE);
      context.contributeTab<FilesTabState>({
        manifest: {
          kind: FILES_KIND,
          version: 1,
          stateVersion: FILES_STATE_VERSION,
          presentation: {
            label: "Files",
            hint: "Explorer with git status and previews",
            icon: "files",
            order: 20,
            groupLabel: "Files",
          },
        },
        view: {
          requiredServices: [FILES_RUNTIME_SERVICE],
          render: (args) => args.services.get(FILES_RUNTIME_SERVICE).render(args),
        },
        state: {
          parse: parseState,
          migrate: (input, from) => {
            if (from !== 0 && from !== FILES_STATE_VERSION) {
              throw new Error(`unsupported files state version: ${from}`);
            }
            return parseState(input);
          },
        },
        remote: runtime.remoteState === undefined ? undefined : {
          protocol: { name: "files-semantic", minVersion: 4, maxVersion: 4 },
          state: runtime.remoteState,
          client: {
            fold: (_state, frame) => (frame as FilesRemoteFrame).state,
            render: (args) => runtime.render(args),
          },
          intents: [
            {
              name: "files.open",
              schema: {
                id: "files.open/v1",
                validate: (input): input is { readonly path: string } =>
                  typeof input === "object" &&
                  input !== null &&
                  typeof (input as { path?: unknown }).path === "string",
              },
              minAccess: "view",
              idempotent: true,
            },
            {
              name: "files.write",
              schema: {
                id: "files.write/v1",
                validate: (input): input is { readonly path: string; readonly content: string } =>
                  typeof input === "object" &&
                  input !== null &&
                  typeof (input as { path?: unknown }).path === "string" &&
                  typeof (input as { content?: unknown }).content === "string",
              },
              minAccess: "steer",
              idempotent: false,
            },
          ],
          privateStreams: {
            streams: [{ name: "files.rpc", minAccess: "view" }],
          },
          fallback: "semantic-document",
        },
        resident: {
          capability: "state-only",
          runtimeKind: "files",
        },
        permissions: [
          {
            capability: "files.runtime",
            reason: "Browse and edit files selected by this Files tab",
          },
        ],
        fallback: "read-only",
      });
    },
  };
}
