import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppChannel, dispatchAppFrame, isAppFrame, RPC_TIMEOUT_MS } from "./remoteRpc";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});
/** Record the sends; answer nothing — each test drives the answers itself. */
function harness() {
  const sent: Array<{ id: number; cmd: string; args: unknown }> = [];
  const channel = createAppChannel((id, cmd, args) =>
    sent.push({ id, cmd, args })
  );
  return { sent, channel };
}

describe("the app channel's rpc multiplexing", () => {
  it("correlates the answer to the ask by id, across concurrent calls", async () => {
    const { sent, channel } = harness();
    const first = channel.rpc("fs_list", { path: "/a" });
    const second = channel.rpc("config_get", null);
    expect(sent).toHaveLength(2);
    expect(sent[0].cmd).toBe("fs_list");
    expect(sent[1].cmd).toBe("config_get");

    // Answers out of order: the second id answers first.
    channel.consume({ type: "rpcResult", id: sent[1].id, ok: { version: 3 } });
    channel.consume({ type: "rpcResult", id: sent[0].id, ok: ["a"] });
    await expect(second).resolves.toEqual({ version: 3 });
    await expect(first).resolves.toEqual(["a"]);
  });

  it("a host error rejects the promise with the host's own words", async () => {
    const { sent, channel } = harness();
    const call = channel.rpc("no_such", null);
    channel.consume({ type: "rpcResult", id: sent[0].id, err: "no such command" });
    await expect(call).rejects.toThrow("no such command");
  });

  it("an answer nobody waits for is consumed, not an error", () => {
    const { channel } = harness();
    // A duplicate or late frame after its promise settled.
    expect(channel.consume({ type: "rpcResult", id: 999, ok: null })).toBe(true);
  });

  it("a non-rpc frame is not consumed", () => {
    const { channel } = harness();
    expect(channel.consume({ type: "output", b64: "aGk=" })).toBe(false);
  });

  it("times out when the host never answers", async () => {
    const { channel } = harness();
    const call = channel.rpc("stuck", null);
    const rejected = expect(call).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS + 1);
    await rejected;
  });

  it("failAll answers every waiting rpc with the stream's end", async () => {
    const { sent, channel } = harness();
    const a = channel.rpc("a", null);
    const b = channel.rpc("b", null);
    channel.failAll("stream ended");
    await expect(a).rejects.toThrow("stream ended");
    await expect(b).rejects.toThrow("stream ended");
    // And a late answer for one of them settles nothing and throws nothing.
    channel.consume({ type: "rpcResult", id: sent[0].id, ok: 1 });
  });
});

describe("the app frame dispatch", () => {
  const sinksOf = () => ({
    onAction: vi.fn(),
    onSnapshot: vi.fn(),
    onClip: vi.fn(),
    onProxy: vi.fn(),
  });

  it("routes each family to its sink", () => {
    const sinks = sinksOf();
    expect(dispatchAppFrame({ type: "actionApplied", name: "addTab", args: { t: 1 } }, sinks)).toBe(true);
    expect(sinks.onAction).toHaveBeenCalledWith("addTab", { t: 1 });

    expect(dispatchAppFrame({ type: "appSnapshot", state: { tabs: [] } }, sinks)).toBe(true);
    expect(sinks.onSnapshot).toHaveBeenCalledWith({ tabs: [] });

    expect(dispatchAppFrame({ type: "clipSync", seq: 3, text: "hi" }, sinks)).toBe(true);
    expect(sinks.onClip).toHaveBeenCalledWith(3, "hi");

    expect(
      dispatchAppFrame({ type: "proxyRes", id: 4, head: "HTTP/1.1 200", body: "x" }, sinks)
    ).toBe(true);
    expect(sinks.onProxy).toHaveBeenCalledWith(4, "HTTP/1.1 200", "x");
  });

  it("unknown and non-object frames are not consumed", () => {
    const sinks = sinksOf();
    expect(dispatchAppFrame({ type: "output", b64: "" }, sinks)).toBe(false);
    expect(dispatchAppFrame(null, sinks)).toBe(false);
    expect(dispatchAppFrame("welcome", sinks)).toBe(false);
  });

  it("isAppFrame names exactly the five the dispatcher claims", () => {
    for (const type of ["rpcResult", "actionApplied", "appSnapshot", "clipSync", "proxyRes"]) {
      expect(isAppFrame({ type })).toBe(true);
    }
    expect(isAppFrame({ type: "mode" })).toBe(false);
  });
});
