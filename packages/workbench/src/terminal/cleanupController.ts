export interface TerminalCleanupSessionState {
  ownerExists: boolean;
  paneGone: boolean;
  archived: boolean;
}

export interface TerminalCleanupControllerPorts {
  disposeMemory: () => void;
  detachLifecycle: () => void;
  sessionState: () => TerminalCleanupSessionState;
  captureMemory: () => void;
  removeMemory: () => void;
  markDisposed: () => void;
  disconnectLayout: () => void;
  detachInput: () => void;
  clearInputPorts: () => void;
  detachViewport: () => void;
  unregister: () => void;
  clearPaneBusy: () => void;
  remoteActive: () => boolean;
  clearTabRemote: () => void;
  clearRemoteHost: () => void;
  disposeBlocks: () => void;
  killHandle: () => void;
  disposeTerminal: () => void;
  clearInstance: () => void;
}

/**
 * Returns whether terminal screen memory survives an unmount. A retained or
 * archived session keeps its transcript; a removed pane or closed tab does not.
 */
export function terminalMemoryDisposition(
  state: TerminalCleanupSessionState
): "capture" | "remove" {
  if (state.paneGone) return "remove";
  if (state.ownerExists || state.archived) return "capture";
  return "remove";
}

/**
 * Runs terminal teardown in one order so delayed platform events cannot write
 * into an instance after its input, registry entry, PTY, or renderer is gone.
 */
export function runTerminalCleanup(
  ports: TerminalCleanupControllerPorts
): void {
  ports.disposeMemory();
  ports.detachLifecycle();
  if (terminalMemoryDisposition(ports.sessionState()) === "capture") {
    ports.captureMemory();
  } else {
    ports.removeMemory();
  }
  ports.markDisposed();
  ports.disconnectLayout();
  ports.detachInput();
  ports.clearInputPorts();
  ports.detachViewport();
  ports.unregister();
  ports.clearPaneBusy();
  if (ports.remoteActive()) ports.clearTabRemote();
  ports.clearRemoteHost();
  ports.disposeBlocks();
  ports.killHandle();
  ports.disposeTerminal();
  ports.clearInstance();
}
