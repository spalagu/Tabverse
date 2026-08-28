import { describe, expect, it, vi } from "vitest";
import { prepareTerminalQuit, type QuitChoice } from "./quitPolicy";

function fixture(options?: {
  on?: boolean;
  busy?: number;
  choice?: QuitChoice;
  detached?: boolean;
}) {
  const choose = vi.fn(async () => options?.choice ?? null);
  const detachAll = vi.fn(async () => options?.detached ?? true);
  const killAll = vi.fn(async () => {});
  return {
    choose,
    detachAll,
    killAll,
    input: {
      backgroundTasksOn: options?.on ?? false,
      busyCount: options?.busy ?? 0,
      choose,
      detachAll,
      killAll,
    },
  };
}

describe("normal quit with helper-owned terminals", () => {
  it("explicitly kills all when the opt-in is off", async () => {
    const f = fixture({ on: false, busy: 2 });
    await expect(prepareTerminalQuit(f.input)).resolves.toBe("proceed");
    expect(f.killAll).toHaveBeenCalledOnce();
    expect(f.choose).not.toHaveBeenCalled();
  });

  it("kills all without asking when no command is busy", async () => {
    const f = fixture({ on: true, busy: 0 });
    await expect(prepareTerminalQuit(f.input)).resolves.toBe("proceed");
    expect(f.killAll).toHaveBeenCalledOnce();
    expect(f.choose).not.toHaveBeenCalled();
  });

  it("keeps sessions only after every terminal view detaches", async () => {
    const f = fixture({ on: true, busy: 1, choice: "background", detached: true });
    await expect(prepareTerminalQuit(f.input)).resolves.toBe("proceed");
    expect(f.detachAll).toHaveBeenCalledOnce();
    expect(f.killAll).not.toHaveBeenCalled();
  });

  it("cancels quit when detach fails or the dialog is cancelled", async () => {
    const failed = fixture({ on: true, busy: 1, choice: "background", detached: false });
    await expect(prepareTerminalQuit(failed.input)).resolves.toBe("cancel");
    const cancelled = fixture({ on: true, busy: 1, choice: null });
    await expect(prepareTerminalQuit(cancelled.input)).resolves.toBe("cancel");
    expect(failed.killAll).not.toHaveBeenCalled();
    expect(cancelled.killAll).not.toHaveBeenCalled();
  });

  it("stops all after the destructive choice", async () => {
    const f = fixture({ on: true, busy: 3, choice: "stop" });
    await expect(prepareTerminalQuit(f.input)).resolves.toBe("proceed");
    expect(f.killAll).toHaveBeenCalledOnce();
    expect(f.detachAll).not.toHaveBeenCalled();
  });
});
