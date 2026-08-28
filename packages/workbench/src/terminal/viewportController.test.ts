import { describe, expect, it, vi } from "vitest";
import { createTerminalViewportController } from "./viewportController";

function setup(proposed: { cols: number; rows: number } | undefined) {
  let current = { cols: 80, rows: 24 };
  const resize = vi.fn((cols: number, rows: number) => {
    current = { cols, rows };
  });
  const onSized = vi.fn();
  const controller = createTerminalViewportController({
    proposeDimensions: () => proposed,
    currentSize: () => current,
    resize,
    onSized,
  });
  return { controller, resize, onSized };
}

describe("terminal viewport controller", () => {
  it("fits a local terminal to the proposed grid", () => {
    const state = setup({ cols: 120, rows: 40 });
    expect(state.controller.fit()).toBe(true);
    expect(state.resize).toHaveBeenCalledWith(120, 40);
    expect(state.onSized).toHaveBeenCalledOnce();
  });

  it("caps both dimensions to the smallest shared viewer", () => {
    const state = setup({ cols: 120, rows: 40 });
    state.controller.setViewerCap({ cols: 72, rows: 20 });
    expect(state.resize).toHaveBeenCalledWith(72, 20);
  });

  it("keeps a valid minimum grid and avoids redundant resize calls", () => {
    const tiny = setup({ cols: 0, rows: 1 });
    tiny.controller.fit();
    expect(tiny.resize).toHaveBeenCalledWith(2, 2);

    const unchanged = setup({ cols: 80, rows: 24 });
    unchanged.controller.fit();
    expect(unchanged.resize).not.toHaveBeenCalled();
    expect(unchanged.onSized).toHaveBeenCalledOnce();
  });

  it("ignores an unavailable or invalid measurement", () => {
    const unavailable = setup(undefined);
    expect(unavailable.controller.fit()).toBe(false);
    expect(unavailable.onSized).not.toHaveBeenCalled();

    const invalid = setup({ cols: Number.NaN, rows: 24 });
    expect(invalid.controller.fit()).toBe(false);
    expect(invalid.resize).not.toHaveBeenCalled();
  });
});
