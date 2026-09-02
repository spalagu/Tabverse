import {
  serviceToken,
  type Awaitable,
  type ContinuousResidentContribution,
  type InstalledPlugin,
  type RemoteStateProvider,
  type TabRendererArgs,
} from "@tabverse/tab-contracts";

export const TERMINAL_PLUGIN_ID = "tabverse.tab.terminal";
export const TERMINAL_KIND = "terminal";
export const TERMINAL_STATE_VERSION = 1;

/**
 * The persisted fields the Terminal contribution owns. Unknown fields are
 * retained so a newer producer can round-trip through an older compatible
 * reader without losing pane/session metadata.
 */
export interface TerminalTabState extends Readonly<Record<string, unknown>> {
  readonly title?: string;
  readonly cwd?: string;
  readonly profile?: string;
  readonly runOnStart?: string;
  readonly attachId?: string;
}

export type TerminalCommand =
  | "terminal.split-horizontal"
  | "terminal.split-vertical";

export interface TerminalRemoteFrame {
  readonly type: "replace";
  readonly state: TerminalTabState;
}

/** Runtime-owned effects used by the product plugin on Desktop or Join. */
export interface TerminalRuntimeService {
  readonly runtimeKind: "desktop" | "remote" | "test";
  readonly remoteState?: RemoteStateProvider<TerminalTabState, TerminalRemoteFrame>;
  readonly resident?: ContinuousResidentContribution<TerminalTabState, TerminalTabState>;
  render(args: TabRendererArgs<TerminalTabState>): unknown;
  runCommand(
    tabId: string,
    command: TerminalCommand,
    input?: unknown,
  ): Awaitable<unknown>;
}

export interface TerminalTabViewRequest
  extends TabRendererArgs<TerminalTabState> {
  readonly runtimeKind: TerminalRuntimeService["runtimeKind"];
  readonly kind: typeof TERMINAL_KIND;
}

export const TERMINAL_RUNTIME_SERVICE = serviceToken<TerminalRuntimeService>(
  "tabverse.terminal.runtime.v1",
);

export interface TerminalRuntimePluginOptions {
  readonly id: string;
  readonly service: TerminalRuntimeService;
}

/** A composition-root provider; the product plugin never imports a runtime. */
export function createTerminalRuntimePlugin(
  options: TerminalRuntimePluginOptions,
): InstalledPlugin {
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
      context.provide(TERMINAL_RUNTIME_SERVICE, options.service);
    },
  };
}

function parseState(input: unknown): TerminalTabState {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("terminal state must be an object");
  }
  return input as TerminalTabState;
}

export interface TerminalPluginOptions {
  readonly runtimePluginId: string;
}

/** The built-in Terminal product plugin, independent of Desktop and Join. */
export function createTerminalPlugin(
  options: TerminalPluginOptions,
): InstalledPlugin {
  const command = (id: TerminalCommand, title: string) => ({
    id,
    title,
    run: (tabId: string, input?: unknown) =>
      // Commands resolve the live service at invocation time; disabling the
      // provider cannot leave a captured runtime handle behind.
      (() => {
        if (runtimeForCommand === undefined) {
          throw new Error("terminal runtime service is not active");
        }
        return runtimeForCommand.runCommand(tabId, id, input);
      })(),
  });
  let runtimeForCommand: TerminalRuntimeService | undefined;

  return {
    manifest: {
      id: TERMINAL_PLUGIN_ID,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [{ id: options.runtimePluginId, range: "^1.0.0" }],
      tabs: [TERMINAL_KIND],
      builtIn: true,
      enabledByDefault: true,
    },
    activate(context) {
      runtimeForCommand = context.get(TERMINAL_RUNTIME_SERVICE);
      const runtime = runtimeForCommand;
      context.contributeTab<TerminalTabState>({
        manifest: {
          kind: TERMINAL_KIND,
          version: 1,
          stateVersion: TERMINAL_STATE_VERSION,
          presentation: {
            label: "Terminal",
            hint: "A shell session",
            icon: "terminal",
            order: 10,
            groupLabel: "Terminals",
          },
        },
        view: {
          requiredServices: [TERMINAL_RUNTIME_SERVICE],
          render: (args) => args.services.get(TERMINAL_RUNTIME_SERVICE).render(args),
        },
        state: {
          parse: parseState,
          migrate: (input, from) => {
            if (from !== 0 && from !== TERMINAL_STATE_VERSION) {
              throw new Error(`unsupported terminal state version: ${from}`);
            }
            return parseState(input);
          },
        },
        commands: [
          command("terminal.split-horizontal", "Split terminal horizontally"),
          command("terminal.split-vertical", "Split terminal vertically"),
        ],
        remote: runtime.remoteState === undefined ? undefined : {
          protocol: { name: "terminal-semantic", minVersion: 4, maxVersion: 4 },
          state: runtime.remoteState,
          client: {
            fold: (_state, frame) => (frame as TerminalRemoteFrame).state,
            render: (args) => runtime.render(args),
          },
          intents: [
            {
              name: "terminal.input",
              schema: {
                id: "terminal.input/v1",
                validate: (input): input is string => typeof input === "string",
              },
              minAccess: "steer",
              idempotent: false,
            },
          ],
          fallback: "read-only",
        },
        resident: runtime.resident,
        permissions: [
          {
            capability: "terminal.runtime",
            reason: "Render and control the shell represented by this Terminal tab",
          },
        ],
        fallback: "unsupported",
      });
      return {
        dispose() {
          runtimeForCommand = undefined;
        },
      };
    },
  };
}
