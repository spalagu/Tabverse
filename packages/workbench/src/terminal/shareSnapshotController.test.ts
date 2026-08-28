import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_SHARE_SNAPSHOT_SCROLLBACK,
  createTerminalShareSnapshotController,
} from "./shareSnapshotController";

function setup(shareId: string | null = "share-1") {
  let queued: (() => void) | null = null;
  const serialize = vi.fn(() => "screen");
  const encode = vi.fn((value: string) => `b64:${value}`);
  const send = vi.fn(async () => {});
  const reportError = vi.fn();
  const controller = createTerminalShareSnapshotController({
    currentShareId: () => shareId,
    write: (_data, callback) => {
      queued = callback;
    },
    serialize,
    encode,
    size: () => ({ cols: 120, rows: 40 }),
    send,
    reportError,
  });
  return {
    controller,
    serialize,
    encode,
    send,
    reportError,
    flush: () => queued?.(),
  };
}

describe("terminal share snapshot controller", () => {
  it("does nothing after sharing has ended", () => {
    const state = setup(null);
    state.controller.handleRequest(7);
    state.flush();
    expect(state.serialize).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
  });

  it("captures only after preceding xterm writes have parsed", async () => {
    const state = setup();
    state.controller.handleRequest(7);
    expect(state.serialize).not.toHaveBeenCalled();
    state.flush();
    await Promise.resolve();

    expect(state.serialize).toHaveBeenCalledWith({
      scrollback: TERMINAL_SHARE_SNAPSHOT_SCROLLBACK,
    });
    expect(state.encode).toHaveBeenCalledWith("screen");
    expect(state.send).toHaveBeenCalledWith({
      shareId: "share-1",
      viewer: 7,
      b64Data: "b64:screen",
      cols: 120,
      rows: 40,
    });
  });

  it("reports transport rejection through the host logger", async () => {
    const state = setup();
    const failure = new Error("relay offline");
    state.send.mockRejectedValueOnce(failure);
    state.controller.handleRequest(2);
    state.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.reportError).toHaveBeenCalledWith(failure);
  });
});
