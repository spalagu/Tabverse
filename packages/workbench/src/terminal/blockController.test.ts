import { describe, expect, it, vi } from "vitest";
import type { Block, BlockEvents } from "./blocks";
import { createTerminalBlockController } from "./blockController";

function block(command: string, id = 1): Block {
  return {
    id,
    command,
    start: { line: 2 } as Block["start"],
    startedAt: 100,
  };
}

function setup(options: { active?: boolean; focused?: boolean } = {}) {
  let events!: BlockEvents;
  const tracker = {
    blocks: [] as Block[],
    runningBlock: null as Block | null,
    pruneDead: vi.fn(() => 0),
    dispose: vi.fn(),
  };
  const decorations = { sync: vi.fn(), dispose: vi.fn() };
  const ports = {
    createTracker: vi.fn((nextEvents: BlockEvents) => {
      events = nextEvents;
      return tracker;
    }),
    decorations,
    setRunning: vi.fn(),
    setSelected: vi.fn(),
    setRemoteHost: vi.fn(),
    setRemoteCwd: vi.fn(),
    setTabRemote: vi.fn(),
    setPaneBusy: vi.fn(),
    setPaneCwd: vi.fn(),
    active: vi.fn(() => options.active ?? true),
    documentFocused: vi.fn(() => options.focused ?? true),
    notifyFinished: vi.fn(),
    setAttention: vi.fn(),
  };
  const controller = createTerminalBlockController(ports);
  return { controller, tracker, decorations, ports, events };
}

describe("terminal block controller", () => {
  it("synchronizes blocks and enters remote state from the running command", () => {
    const state = setup();
    const running = block("ssh ops@example.com");
    state.tracker.blocks.push(running);
    state.tracker.runningBlock = running;

    state.events.onChange?.();

    expect(state.tracker.pruneDead).toHaveBeenCalledOnce();
    expect(state.decorations.sync).toHaveBeenCalledWith([running]);
    expect(state.ports.setRunning).toHaveBeenCalledWith(running);
    expect(state.ports.setTabRemote).toHaveBeenCalledWith({ host: "example.com" });
    expect(state.ports.setPaneBusy).toHaveBeenCalledWith(true);
    expect(state.ports.setSelected).toHaveBeenCalledWith(running);
  });

  it("clears remote facts after a remote command ends", () => {
    const state = setup();
    state.events.onChange?.();

    expect(state.ports.setRemoteHost).toHaveBeenCalledWith(null);
    expect(state.ports.setRemoteCwd).toHaveBeenCalledWith(null);
    expect(state.ports.setTabRemote).toHaveBeenCalledWith(null);
    expect(state.ports.setPaneBusy).toHaveBeenCalledWith(false);
    expect(state.ports.setSelected).toHaveBeenCalledWith(null);
  });

  it("uses cwd and host reports to refine only a running remote block", () => {
    const state = setup();
    state.events.onCwd?.("/local");
    state.events.onHost?.("local-machine");
    expect(state.ports.setPaneCwd).toHaveBeenCalledWith("/local");
    expect(state.ports.setRemoteCwd).not.toHaveBeenCalled();
    expect(state.ports.setTabRemote).not.toHaveBeenCalled();

    state.tracker.runningBlock = block("mosh edge.example.net");
    state.events.onCwd?.("/srv/app");
    state.events.onHost?.("reported.example.net");
    expect(state.ports.setRemoteCwd).toHaveBeenCalledWith("/srv/app");
    expect(state.ports.setRemoteHost).toHaveBeenCalledWith("reported.example.net");
    expect(state.ports.setTabRemote).toHaveBeenCalledWith({
      host: "reported.example.net",
    });
  });

  it("notifies for a long command when the window is not focused", () => {
    const state = setup({ focused: false });
    const finished = block("npm test");
    state.events.onFinished?.(finished, 8000);
    expect(state.ports.notifyFinished).toHaveBeenCalledWith(finished, 8000);
    expect(state.ports.setAttention).not.toHaveBeenCalled();
  });

  it("marks inactive tabs and suppresses short-command notifications", () => {
    const state = setup({ active: false, focused: false });
    state.events.onFinished?.(block("pwd"), 7999);
    expect(state.ports.notifyFinished).not.toHaveBeenCalled();
    expect(state.ports.setAttention).toHaveBeenCalledOnce();
  });

  it("disposes decorations and the tracker together", () => {
    const state = setup();
    state.controller.dispose();
    expect(state.decorations.dispose).toHaveBeenCalledOnce();
    expect(state.tracker.dispose).toHaveBeenCalledOnce();
  });
});
