import { describe, expect, it, vi } from "vitest";
import { installTerminalSessionRegistration } from "./sessionRegistration";

function setup(options: { primary?: boolean; command?: string } = {}) {
  let done = false;
  const handle = { write: vi.fn(), detach: vi.fn(async () => {}) };
  const register = vi.fn();
  const ports = {
    handle,
    register,
    size: () => ({ cols: 120, rows: 40 }),
    serialize: () => "screen",
    focus: vi.fn(),
    openSearch: vi.fn(),
    setViewerCap: vi.fn(),
    cwd: () => "/repo",
    debugLastBlockOutput: () => ({ command: "test", output: "ok" }),
    primary: options.primary ?? true,
    handoverCommand: options.command,
    handoverDone: () => done,
    markHandoverDone: () => {
      done = true;
    },
  };
  return { ports, handle, register };
}

describe("terminal session registration", () => {
  it("publishes a live API backed by the current handle", async () => {
    const state = setup();
    const api = installTerminalSessionRegistration(state.ports);
    expect(state.register).toHaveBeenCalledWith(api);
    api.runCommand("npm test");
    api.write("input");
    await api.detach();
    expect(state.handle.write).toHaveBeenNthCalledWith(1, "npm test\n");
    expect(state.handle.write).toHaveBeenNthCalledWith(2, "input");
    expect(state.handle.detach).toHaveBeenCalledOnce();
    expect(api.debugLastBlockOutput?.()).toEqual({
      command: "test",
      output: "ok",
    });
  });

  it("delivers a handover command once to the primary pane", () => {
    const state = setup({ command: "ssh host" });
    installTerminalSessionRegistration(state.ports);
    installTerminalSessionRegistration(state.ports);
    expect(state.handle.write).toHaveBeenCalledOnce();
    expect(state.handle.write).toHaveBeenCalledWith("ssh host\n");
  });

  it("does not deliver a tab handover command to a secondary pane", () => {
    const state = setup({ primary: false, command: "ssh host" });
    installTerminalSessionRegistration(state.ports);
    expect(state.handle.write).not.toHaveBeenCalled();
  });

  it("does not treat an empty command as a handover", () => {
    const state = setup({ command: "" });
    installTerminalSessionRegistration(state.ports);
    expect(state.handle.write).not.toHaveBeenCalled();
  });
});
