import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSidebarHover, SIDEBAR_MOTION as M } from "./sidebarHover";
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
function fixture(reduced = false) {
  let shown = false, pinned = false, held = false;
  const present = vi.fn((phase: string) => { if (phase !== "closing") shown = phase === "open"; });
  const h = createSidebarHover({ shown: () => shown, pinned: () => pinned, held: () => held, reducedMotion: () => reduced, present });
  return { h, present, pin: () => { pinned = true; h.reconcile(); }, hold: (value: boolean) => { held = value; h.reconcile(); } };
}
describe("design B01–B03: sidebar intent and occupancy", () => {
  it("ignores a fast edge crossing but opens after deliberate dwell", () => {
    const { h, present } = fixture(); h.edgeEnter(); vi.advanceTimersByTime(M.openIntent - 1); h.edgeExit(false);
    vi.advanceTimersByTime(500); expect(present).not.toHaveBeenCalled();
    h.edgeEnter(); vi.advanceTimersByTime(M.openIntent); expect(present).toHaveBeenLastCalledWith("open");
  });
  it("keeps native obstruction until exit completes and reverses an interrupted exit", () => {
    const { h, present } = fixture(); h.edgeEnter(); vi.advanceTimersByTime(M.openIntent); h.leave();
    vi.advanceTimersByTime(M.closeIntent - 1); expect(present).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); expect(present).toHaveBeenLastCalledWith("closing");
    vi.advanceTimersByTime(100); h.enter(); expect(present).toHaveBeenLastCalledWith("open");
    vi.advanceTimersByTime(1000); expect(present.mock.calls.flat()).not.toContain("hidden");
    h.leave(); vi.advanceTimersByTime(M.closeIntent + M.exit); expect(present).toHaveBeenLastCalledWith("hidden");
  });
  it("leaving the native edge into the panel is not leaving the panel", () => {
    const { h, present } = fixture(); h.edgeEnter(); vi.advanceTimersByTime(M.openIntent);
    h.edgeExit(false); vi.advanceTimersByTime(1000); expect(present).toHaveBeenLastCalledWith("open");
    h.edgeExit(true); vi.advanceTimersByTime(M.closeIntent + M.exit); expect(present).toHaveBeenLastCalledWith("hidden");
  });
  it("holds across menus and rechecks after they close without another mousemove", () => {
    const { h, present, hold } = fixture(); h.edgeEnter(); vi.advanceTimersByTime(M.openIntent); hold(true); h.leave();
    vi.advanceTimersByTime(2000); expect(present).toHaveBeenCalledTimes(1); hold(false);
    vi.advanceTimersByTime(M.closeIntent - 1); expect(present).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(M.exit + 1); expect(present).toHaveBeenLastCalledWith("hidden");
  });
  it("honours independent keyboard and resize locks until both are released", () => {
    const { h, present } = fixture(); h.edgeEnter(); vi.advanceTimersByTime(M.openIntent);
    h.hold("keyboard", true); h.hold("resize", true); h.leave(); h.hold("keyboard", false);
    vi.advanceTimersByTime(2000); expect(present).toHaveBeenCalledTimes(1); h.hold("resize", false);
    vi.advanceTimersByTime(M.closeIntent + M.exit); expect(present).toHaveBeenLastCalledWith("hidden");
  });
  it("pin/reset/blur cancel pending requests; a stale timeout cannot reopen", () => {
    const { h, present, pin } = fixture(); h.edgeEnter(); h.blur(); vi.advanceTimersByTime(500); expect(present).not.toHaveBeenCalled();
    h.edgeEnter(); h.reset(); vi.advanceTimersByTime(500); expect(present).not.toHaveBeenCalled();
    h.edgeEnter(); pin(); vi.advanceTimersByTime(500); expect(present).not.toHaveBeenCalled();
  });
  it("reduced motion preserves intent tolerance but removes movement wait", () => {
    const { h, present } = fixture(true); h.edgeEnter(); vi.advanceTimersByTime(M.openIntent); h.leave();
    vi.advanceTimersByTime(M.closeIntent + 1); expect(present).toHaveBeenLastCalledWith("hidden");
  });
});
