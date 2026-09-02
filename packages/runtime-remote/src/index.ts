import { createObservedRemoteState } from "@tabverse/remote-protocol";
import {
  createBrowserRuntimePlugin,
  type BrowserRemoteFrame,
  type BrowserTabState,
  type BrowserTabViewRequest,
} from "@tabverse/tab-browser";
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

export const REMOTE_TERMINAL_RUNTIME_PLUGIN_ID =
  "tabverse.runtime.terminal";

/** Join provider for the same Terminal contribution and remote renderer. */
export function createRemoteTerminalRuntimePlugin<Output>(
  render: (request: TerminalTabViewRequest) => Output,
  runCommand: (
    tabId: string,
    command: TerminalCommand,
    input?: unknown,
  ) => unknown | Promise<unknown> = (_tabId, command) => {
    throw new Error(`remote terminal command is not supported: ${command}`);
  },
) {
  const remote = createObservedRemoteState<TerminalTabState, TerminalRemoteFrame>();
  return createTerminalRuntimePlugin({
    id: REMOTE_TERMINAL_RUNTIME_PLUGIN_ID,
    service: {
      runtimeKind: "remote",
      remoteState: remote.state,
      render: (args) => {
        remote.observe(args.tabId, args.state, { type: "replace", state: args.state });
        return render({ runtimeKind: "remote", kind: "terminal", ...args });
      },
      runCommand,
    },
  });
}

export const FILES_RUNTIME_PLUGIN_ID = "tabverse.runtime.files";
export const BROWSER_RUNTIME_PLUGIN_ID = "tabverse.runtime.browser";

export function createRemoteFilesRuntimePlugin<Output>(
  render: (request: FilesTabViewRequest) => Output,
) {
  const remote = createObservedRemoteState<FilesTabState, FilesRemoteFrame>();
  return createFilesRuntimePlugin({
    id: FILES_RUNTIME_PLUGIN_ID,
    service: {
      runtimeKind: "remote",
      remoteState: remote.state,
      render: (args) => {
        remote.observe(args.tabId, args.state, { type: "replace", state: args.state });
        return render({ runtimeKind: "remote", kind: "files", ...args });
      },
    },
  });
}

export function createRemoteBrowserRuntimePlugin<Output>(
  render: (request: BrowserTabViewRequest) => Output,
) {
  const remote = createObservedRemoteState<BrowserTabState, BrowserRemoteFrame>();
  return createBrowserRuntimePlugin({
    id: BROWSER_RUNTIME_PLUGIN_ID,
    service: {
      runtimeKind: "remote",
      remoteState: remote.state,
      render: (args) => {
        remote.observe(args.tabId, args.state, { type: "replace", state: args.state });
        return render({ runtimeKind: "remote", kind: "browser", ...args });
      },
    },
  });
}
