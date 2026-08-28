import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: calls,
  Channel: class<T> {
    onmessage: ((message: T) => void) | null = null;
  },
}));

import { tauriBackend } from "./tauri";

describe("detaching a helper-owned terminal", () => {
  beforeEach(() => {
    calls.mockReset();
    calls.mockImplementation(async (command: string) =>
      command === "term_create" ? "helper-session" : undefined
    );
  });

  it("detaches once and makes the later unmount kill a no-op", async () => {
    const handle = await tauriBackend.createTerminal({ cols: 80, rows: 24 });
    await handle.detach();
    handle.kill();

    expect(calls.mock.calls.map(([command]) => command)).toEqual([
      "term_create",
      "term_detach",
    ]);
  });

  it("keeps normal kill behavior before a detach succeeds", async () => {
    const handle = await tauriBackend.createTerminal({ cols: 80, rows: 24 });
    handle.kill();
    expect(calls).toHaveBeenCalledWith("term_kill", { id: "helper-session" });
  });

  it("does not arm the tombstone when detach is refused", async () => {
    calls.mockImplementation(async (command: string) => {
      if (command === "term_create") return "helper-session";
      if (command === "term_detach") throw new Error("helper unavailable");
      return undefined;
    });
    const handle = await tauriBackend.createTerminal({ cols: 80, rows: 24 });
    await expect(handle.detach()).rejects.toThrow("helper unavailable");
    handle.kill();
    expect(calls).toHaveBeenCalledWith("term_kill", { id: "helper-session" });
  });

  it("attaches an existing helper session instead of spawning another shell", async () => {
    calls.mockImplementation(async (command: string) =>
      command === "term_attach" ? "existing-session" : undefined
    );
    const handle = await tauriBackend.createTerminal({
      cols: 80,
      rows: 24,
      attachId: "existing-session",
    });
    expect(handle.id).toBe("existing-session");
    expect(calls.mock.calls.map(([command]) => command)).toEqual(["term_attach"]);
    expect(calls).not.toHaveBeenCalledWith("term_create", expect.anything());
  });
});
