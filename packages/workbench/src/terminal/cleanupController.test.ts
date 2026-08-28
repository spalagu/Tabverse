import { describe, expect, it, vi } from "vitest";
import {
  runTerminalCleanup,
  terminalMemoryDisposition,
  type TerminalCleanupControllerPorts,
  type TerminalCleanupSessionState,
} from "./cleanupController";

describe("terminal memory disposition", () => {
  it.each<[TerminalCleanupSessionState, "capture" | "remove"]>([
    [{ ownerExists: true, paneGone: false, archived: false }, "capture"],
    [{ ownerExists: false, paneGone: false, archived: true }, "capture"],
    [{ ownerExists: true, paneGone: true, archived: false }, "remove"],
    [{ ownerExists: false, paneGone: false, archived: false }, "remove"],
  ])("maps session state %#", (state, expected) => {
    expect(terminalMemoryDisposition(state)).toBe(expected);
  });
});

function setup(options: { remote?: boolean; archived?: boolean } = {}) {
  const order: string[] = [];
  const action = (name: string) => vi.fn(() => order.push(name));
  const ports: TerminalCleanupControllerPorts = {
    disposeMemory: action("dispose-memory"),
    detachLifecycle: action("detach-lifecycle"),
    sessionState: () => ({
      ownerExists: !options.archived,
      paneGone: false,
      archived: options.archived ?? false,
    }),
    captureMemory: action("capture-memory"),
    removeMemory: action("remove-memory"),
    markDisposed: action("mark-disposed"),
    disconnectLayout: action("disconnect-layout"),
    detachInput: action("detach-input"),
    clearInputPorts: action("clear-input-ports"),
    detachViewport: action("detach-viewport"),
    unregister: action("unregister"),
    clearPaneBusy: action("clear-pane-busy"),
    remoteActive: () => options.remote ?? false,
    clearTabRemote: action("clear-tab-remote"),
    clearRemoteHost: action("clear-remote-host"),
    disposeBlocks: action("dispose-blocks"),
    killHandle: action("kill-handle"),
    disposeTerminal: action("dispose-terminal"),
    clearInstance: action("clear-instance"),
  };
  return { ports, order };
}

describe("terminal cleanup controller", () => {
  it("captures memory before marking a retained instance disposed", () => {
    const state = setup();
    runTerminalCleanup(state.ports);
    expect(state.order.slice(0, 4)).toEqual([
      "dispose-memory",
      "detach-lifecycle",
      "capture-memory",
      "mark-disposed",
    ]);
    expect(state.ports.removeMemory).not.toHaveBeenCalled();
    expect(state.order.slice(-4)).toEqual([
      "dispose-blocks",
      "kill-handle",
      "dispose-terminal",
      "clear-instance",
    ]);
  });

  it("clears the shared remote marker only for a remote pane", () => {
    const local = setup();
    runTerminalCleanup(local.ports);
    expect(local.ports.clearTabRemote).not.toHaveBeenCalled();
    expect(local.ports.clearRemoteHost).toHaveBeenCalledOnce();

    const remote = setup({ remote: true });
    runTerminalCleanup(remote.ports);
    expect(remote.ports.clearTabRemote).toHaveBeenCalledOnce();
    expect(remote.order.indexOf("clear-tab-remote")).toBeLessThan(
      remote.order.indexOf("clear-remote-host")
    );
  });
});
