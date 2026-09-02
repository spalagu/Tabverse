import { invoke } from "@tauri-apps/api/core";
import type {
  ContinuousResidentContribution,
  RuntimeDescriptor,
} from "@tabverse/tab-contracts";
import { createObservedRemoteState } from "@tabverse/remote-protocol";
import {
  createBrowserRuntimePlugin,
  type BrowserSessionPort,
  type BrowserRemoteFrame,
  type BrowserTabState,
  type BrowserTabViewRequest,
} from "@tabverse/tab-browser";
import { createTauriBrowserSessionPort } from "./browser";

export { createTauriBrowserSessionPort } from "./browser";
import {
  createTerminalRuntimePlugin,
  type TerminalCommand,
  type TerminalRemoteFrame,
  type TerminalTabState,
  type TerminalTabViewRequest,
} from "@tabverse/tab-terminal";
import {
  createFilesRuntimePlugin,
  type FilesRemoteFrame,
  type FilesTabState,
  type FilesTabViewRequest,
} from "@tabverse/tab-files";
import {
  createSettingsRuntimePlugin,
  type SettingsTabViewRequest,
} from "@tabverse/tab-settings";
import {
  createRemoteRuntimePlugin,
  type RemoteTabState,
  type RemoteTabViewRequest,
} from "@tabverse/tab-remote";

export { ResidentCoordinator, createTauriResidentPort } from "./resident";
export type {
  ResidentMountRequest,
  ResidentMountResult,
  ResidentTakeoverFailure,
} from "./resident";

export const DESKTOP_TERMINAL_RUNTIME_PLUGIN_ID = "tabverse.runtime.terminal";

function objectState(
  input: unknown,
): input is Readonly<Record<string, unknown>> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function nativeResident<State extends Readonly<Record<string, unknown>>>(
  runtimeKind: string,
): ContinuousResidentContribution<State, State> {
  return {
    capability: "continuous",
    runtimeKind,
    descriptor: () =>
      invoke<RuntimeDescriptor>("resident_descriptor", { runtimeKind }),
    initialStateSchema: {
      id: `${runtimeKind}.resident-initial/v1`,
      validate: (input): input is State => objectState(input),
    },
    checkpointSchema: {
      id: `${runtimeKind}.resident-checkpoint/v1`,
      validate: (input): input is State => objectState(input),
    },
  };
}

const sameRemoteState = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

function terminalRemoteState(state: TerminalTabState): TerminalTabState {
  return {
    ...(state.title === undefined ? {} : { title: state.title }),
    ...(state.cwd === undefined ? {} : { cwd: state.cwd }),
    ...(state.profile === undefined ? {} : { profile: state.profile }),
  };
}

function filesRemoteState(state: FilesTabState): FilesTabState {
  return {
    ...(state.title === undefined ? {} : { title: state.title }),
    ...(state.cwd === undefined ? {} : { cwd: state.cwd }),
    ...(state.openPath === undefined ? {} : { openPath: state.openPath }),
    ...(state.peek === undefined ? {} : { peek: state.peek }),
  };
}

function browserRemoteState(state: BrowserTabState): BrowserTabState {
  return {
    ...(state.title === undefined ? {} : { title: state.title }),
    ...(state.url === undefined ? {} : { url: state.url }),
    ...(state.pinnedUrl === undefined ? {} : { pinnedUrl: state.pinnedUrl }),
  };
}

/** Desktop provider for the Terminal plugin's narrow runtime port. */
export function createDesktopTerminalRuntimePlugin<Output>(
  render: (request: TerminalTabViewRequest) => Output,
  runCommand: (
    tabId: string,
    command: TerminalCommand,
    input?: unknown,
  ) => unknown | Promise<unknown> = (_tabId, command) => {
    throw new Error(`desktop terminal command is not bound: ${command}`);
  },
) {
  const remote = createObservedRemoteState<
    TerminalTabState,
    TerminalRemoteFrame
  >({
    equals: sameRemoteState,
  });
  return createTerminalRuntimePlugin({
    id: DESKTOP_TERMINAL_RUNTIME_PLUGIN_ID,
    service: {
      runtimeKind: "desktop",
      remoteState: remote.state,
      resident: nativeResident<TerminalTabState>("terminal"),
      render: (args) => {
        const state = terminalRemoteState(args.state);
        remote.observe(args.tabId, state, { type: "replace", state });
        return render({ runtimeKind: "desktop", kind: "terminal", ...args });
      },
      runCommand,
    },
  });
}

export const FILES_RUNTIME_PLUGIN_ID = "tabverse.runtime.files";
export const SETTINGS_RUNTIME_PLUGIN_ID = "tabverse.runtime.settings";
export const BROWSER_RUNTIME_PLUGIN_ID = "tabverse.runtime.browser";
export const REMOTE_RUNTIME_PLUGIN_ID = "tabverse.runtime.remote";

export function createDesktopFilesRuntimePlugin<Output>(
  render: (request: FilesTabViewRequest) => Output,
) {
  const remote = createObservedRemoteState<FilesTabState, FilesRemoteFrame>({
    equals: sameRemoteState,
  });
  return createFilesRuntimePlugin({
    id: FILES_RUNTIME_PLUGIN_ID,
    service: {
      runtimeKind: "desktop",
      remoteState: remote.state,
      render: (args) => {
        const state = filesRemoteState(args.state);
        remote.observe(args.tabId, state, { type: "replace", state });
        return render({ runtimeKind: "desktop", kind: "files", ...args });
      },
    },
  });
}

export function createDesktopSettingsRuntimePlugin<Output>(
  render: (request: SettingsTabViewRequest) => Output,
) {
  return createSettingsRuntimePlugin({
    id: SETTINGS_RUNTIME_PLUGIN_ID,
    service: {
      runtimeKind: "desktop",
      render: (args) =>
        render({ runtimeKind: "desktop", kind: "settings", ...args }),
    },
  });
}

export function createDesktopBrowserRuntimePlugin<Output>(
  render: (request: BrowserTabViewRequest) => Output,
  session: BrowserSessionPort = createTauriBrowserSessionPort(),
) {
  const remote = createObservedRemoteState<BrowserTabState, BrowserRemoteFrame>(
    {
      equals: sameRemoteState,
    },
  );
  return createBrowserRuntimePlugin({
    id: BROWSER_RUNTIME_PLUGIN_ID,
    service: {
      runtimeKind: "desktop",
      session,
      remoteState: remote.state,
      residentNetworkTask: nativeResident<BrowserTabState>("browser-network"),
      render: (args) => {
        const state = browserRemoteState(args.state);
        remote.observe(args.tabId, state, { type: "replace", state });
        return render({
          runtimeKind: "desktop",
          kind: "browser",
          session,
          ...args,
        });
      },
    },
  });
}

export function createDesktopRemoteRuntimePlugin<Output>(
  render: (request: RemoteTabViewRequest) => Output,
) {
  return createRemoteRuntimePlugin({
    id: REMOTE_RUNTIME_PLUGIN_ID,
    service: {
      runtimeKind: "desktop",
      resident: nativeResident<RemoteTabState>("remote"),
      render: (args) =>
        render({ runtimeKind: "desktop", kind: "remote", ...args }),
    },
  });
}
