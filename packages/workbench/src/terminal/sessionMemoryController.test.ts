import { describe, expect, it, vi } from "vitest";
import {
  createTerminalSessionMemoryController,
  type TerminalSessionMemoryPorts,
} from "./sessionMemoryController";
import type { TermMemory } from "./sessionMemory";

const SCREEN = "~ $ npm test\r\n2038 passed\r\n";
const MEMORY: TermMemory = { version: 1, screen: SCREEN, cwd: "/repo" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(load: Promise<TermMemory | null>) {
  let disposed = false;
  let screen = SCREEN;
  const write = vi.fn((_: string, callback?: () => void) => callback?.());
  const save = vi.fn();
  const remove = vi.fn();
  const flush = vi.fn();
  let timer: (() => void) | null = null;
  const ports: TerminalSessionMemoryPorts = {
    load,
    serialize: vi.fn(() => screen),
    cwd: () => "/repo",
    cols: () => 100,
    write,
    save,
    remove,
    flush,
    disposed: () => disposed,
    now: () => 10_000,
    setTimer: (callback) => {
      timer = callback;
      return callback;
    },
    clearTimer: (candidate) => {
      if (timer === candidate) timer = null;
    },
  };
  const controller = createTerminalSessionMemoryController(ports);
  return {
    controller,
    write,
    save,
    remove,
    flush,
    setDisposed: () => {
      disposed = true;
    },
    setScreen: (next: string) => {
      screen = next;
    },
    runTimer: () => {
      const callback = timer;
      timer = null;
      callback?.();
    },
  };
}

describe("terminal session memory controller", () => {
  it("restores only after sizing and exposes the loaded directory", async () => {
    const load = deferred<TermMemory | null>();
    const state = setup(load.promise);
    state.controller.markSized();
    expect(state.write).not.toHaveBeenCalled();

    load.resolve(MEMORY);
    await load.promise;

    expect(state.controller.loadedMemory()).toEqual(MEMORY);
    expect(state.write).toHaveBeenCalledOnce();
    expect(state.write.mock.calls[0][0]).toContain(SCREEN);
    expect(state.write.mock.calls[0][0]).toContain("previous session ended here");
  });

  it("does not interleave a late restore with live shell output", async () => {
    const load = deferred<TermMemory | null>();
    const state = setup(load.promise);
    state.controller.markSized();
    state.controller.markOutput();
    load.resolve(MEMORY);
    await load.promise;

    expect(state.write).not.toHaveBeenCalled();
  });

  it("debounces output and captures behind xterm's write queue", async () => {
    const state = setup(Promise.resolve(null));
    await Promise.resolve();
    state.controller.scheduleSave();
    expect(state.save).not.toHaveBeenCalled();
    state.runTimer();

    expect(state.write).toHaveBeenCalledWith("", expect.any(Function));
    expect(state.save).toHaveBeenCalledWith(MEMORY);
  });

  it("removes a stored screen after the terminal becomes empty", async () => {
    const state = setup(Promise.resolve(null));
    await Promise.resolve();
    state.controller.capture();
    state.setScreen("\x1b[2J");
    state.controller.capture();

    expect(state.save).toHaveBeenCalledOnce();
    expect(state.remove).toHaveBeenCalledOnce();
  });

  it("captures and flushes on exit, then ignores disposed panes", async () => {
    const state = setup(Promise.resolve(null));
    await Promise.resolve();
    state.controller.flushOnExit();
    expect(state.save).toHaveBeenCalledOnce();
    expect(state.flush).toHaveBeenCalledOnce();

    state.setDisposed();
    state.controller.capture();
    state.controller.scheduleSave();
    state.runTimer();
    expect(state.save).toHaveBeenCalledOnce();
  });
});
