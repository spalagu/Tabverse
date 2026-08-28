import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The OS half is not under test; these checks pin the payload that crosses
 * the invoke boundary. */

// backend modules choose their branch at MODULE LOAD by reading the Tauri
// marker off the window; the hoisted block runs before the import graph
// does (the same load-time trick as searchExcludes.test.ts).
vi.hoisted(() => {
  (globalThis as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
});

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(
    async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> =>
      null
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const { notifyCommandFinished } = await import("./notify");

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mocks.invoke.mockClear();
});

afterEach(() => {
  vi.resetModules();
});

describe("notifyCommandFinished", () => {
  it("formats a successful command notification", async () => {
    notifyCommandFinished("work", "cargo test", 0, 90_000);
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("notify", {
      title: "Finished in 1m30s",
      body: "work: cargo test",
    });
  });

  it("formats a failed command notification", async () => {
    notifyCommandFinished("work", "cargo test", 101, 90_000);
    await flush();
    expect(mocks.invoke.mock.calls[0][1]).toEqual({
      title: "Failed (exit 101)",
      body: "work: cargo test",
    });
  });
});
