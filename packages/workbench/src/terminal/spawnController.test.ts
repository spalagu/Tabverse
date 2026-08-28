import { describe, expect, it, vi } from "vitest";
import { createTerminalSpawnController } from "./spawnController";

function setup(options: { attachId?: string | null; tabId?: string | null } = {}) {
  const create = vi.fn(async () => ({ id: "term-1" }));
  const reportCwdFailure = vi.fn();
  const writeCwdFallback = vi.fn();
  const controller = createTerminalSpawnController({
    size: () => ({ cols: 120, rows: 40 }),
    attachId: options.attachId ?? null,
    tabId: options.tabId ?? "tab-1",
    create,
    reportCwdFailure,
    writeCwdFallback,
  });
  return { controller, create, reportCwdFailure, writeCwdFallback };
}

describe("terminal spawn controller", () => {
  it("attaches without leaking new-shell launch fields", async () => {
    const state = setup({ attachId: "session-7" });
    await state.controller.spawn("/ignored", {
      profile: "ops",
      runOnStart: "uptime",
    });
    expect(state.create).toHaveBeenCalledWith({
      cols: 120,
      rows: 40,
      attachId: "session-7",
      tabId: "tab-1",
    });
  });

  it("starts a new shell with cwd and launch fields", async () => {
    const state = setup();
    await state.controller.spawn("/repo", {
      profile: "dev",
      runOnStart: "npm test",
    });
    expect(state.create).toHaveBeenCalledWith({
      cols: 120,
      rows: 40,
      tabId: "tab-1",
      cwd: "/repo",
      profile: "dev",
      runOnStart: "npm test",
    });
  });

  it("retries without a stale cwd while preserving launch fields", async () => {
    const state = setup();
    const failure = new Error("directory missing");
    state.create.mockRejectedValueOnce(failure);
    await state.controller.spawn("/gone", { profile: "dev" });

    expect(state.reportCwdFailure).toHaveBeenCalledWith("/gone", failure);
    expect(state.writeCwdFallback).toHaveBeenCalledWith("/gone");
    expect(state.create).toHaveBeenNthCalledWith(2, {
      cols: 120,
      rows: 40,
      tabId: "tab-1",
      profile: "dev",
    });
  });

  it("does not retry a failure that had no remembered cwd", async () => {
    const state = setup();
    state.create.mockRejectedValueOnce(new Error("spawn denied"));
    await expect(
      state.controller.spawn(undefined, { profile: "dev" })
    ).rejects.toThrow("spawn denied");
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.writeCwdFallback).not.toHaveBeenCalled();
  });
});
