import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_OUTPUT_REPORT_INTERVAL_MS,
  installTerminalOutputController,
} from "./outputController";

function setup() {
  let dataListener!: (data: Uint8Array) => void;
  let exitListener!: (code: number | null) => void;
  let disposed = false;
  let timestamp = 10_000;
  const write = vi.fn();
  const endSpawnWait = vi.fn();
  const markMemoryOutput = vi.fn();
  const scheduleMemorySave = vi.fn();
  const reportOutputAt = vi.fn();
  const handleExit = vi.fn<(code: number | null) => string | null>(
    () => "session ended"
  );
  installTerminalOutputController({
    disposed: () => disposed,
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
    write,
    endSpawnWait,
    markMemoryOutput,
    scheduleMemorySave,
    reportOutputAt,
    handleExit,
    now: () => timestamp,
  });
  return {
    write,
    endSpawnWait,
    markMemoryOutput,
    scheduleMemorySave,
    reportOutputAt,
    handleExit,
    data: (value: number[]) => dataListener(new Uint8Array(value)),
    exit: (code: number | null) => exitListener(code),
    advance: (milliseconds: number) => {
      timestamp += milliseconds;
    },
    dispose: () => {
      disposed = true;
    },
  };
}

describe("terminal output controller", () => {
  it("ends the spawn wait once and persists every output burst", () => {
    const state = setup();
    state.data([65]);
    state.data([66]);

    expect(state.endSpawnWait).toHaveBeenCalledOnce();
    expect(state.markMemoryOutput).toHaveBeenCalledTimes(2);
    expect(state.write.mock.calls.map(([data]) => Array.from(data))).toEqual([
      [65],
      [66],
    ]);
    expect(state.scheduleMemorySave).toHaveBeenCalledTimes(2);
  });

  it("throttles recent-output reports while continuous bytes still save", () => {
    const state = setup();
    state.data([1]);
    state.advance(TERMINAL_OUTPUT_REPORT_INTERVAL_MS);
    state.data([2]);
    state.advance(1);
    state.data([3]);

    expect(state.reportOutputAt).toHaveBeenCalledTimes(2);
    expect(state.scheduleMemorySave).toHaveBeenCalledTimes(3);
  });

  it("lets the host remove a pane without writing an exit line", () => {
    const state = setup();
    state.handleExit.mockReturnValueOnce(null);
    state.exit(0);

    expect(state.endSpawnWait).toHaveBeenCalledOnce();
    expect(state.handleExit).toHaveBeenCalledWith(0);
    expect(state.write).not.toHaveBeenCalled();
    expect(state.scheduleMemorySave).not.toHaveBeenCalled();
  });

  it("writes and saves the final line for the last pane", () => {
    const state = setup();
    state.exit(7);
    expect(state.write).toHaveBeenCalledWith("session ended");
    expect(state.scheduleMemorySave).toHaveBeenCalledOnce();
  });

  it("drops delayed events after disposal", () => {
    const state = setup();
    state.dispose();
    state.data([1]);
    state.exit(null);
    expect(state.endSpawnWait).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  });
});
