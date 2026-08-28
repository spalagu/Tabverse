import { afterEach, describe, expect, it, vi } from "vitest";
// Imported for its side effect as much as for its exports: the listener is
// installed when this module is first imported, and everything below depends
// on that having happened before the stand-in handler is added.
import { captureKeys, capturing } from "./keyCapture";


const handler = vi.fn();
window.addEventListener("keydown", handler, { capture: true });

/** A key press, as the window delivers one. */
function press(key: string, mods: { meta?: boolean; shift?: boolean } = {}) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      metaKey: mods.meta ?? true,
      shiftKey: mods.shift ?? false,
      bubbles: true,
      cancelable: true,
    })
  );
}

afterEach(() => {
  handler.mockReset();
});

describe("the key capture", () => {
  it("stays out of the way when nothing is recording", () => {
    press("t");
    expect(handler, "the app-wide handler still gets its keys").toHaveBeenCalled();
    expect(capturing()).toBe(false);
  });

  it("takes the key before the handler that would have run the command", () => {
    const chords: string[] = [];
    const release = captureKeys({
      onChord: (r) => chords.push(r.keys),
      onCancel: () => chords.push("cancelled"),
    });

    press("w");

    expect(chords, "delivered as data").toEqual(["⌘W"]);
    expect(
      handler,
      "the app-wide handler must not see a key being recorded"
    ).not.toHaveBeenCalled();
    release();
  });

  it("gives the keyboard back when the recording ends", () => {
    const release = captureKeys({ onChord: () => {}, onCancel: () => {} });
    release();
    press("w");
    expect(handler).toHaveBeenCalled();
    expect(capturing()).toBe(false);
  });

  it("reads Escape as leaving rather than as a key to bind", () => {
    const seen: string[] = [];
    const release = captureKeys({
      onChord: (r) => seen.push(r.keys),
      onCancel: () => seen.push("cancelled"),
    });

    press("Escape", { meta: false });

    expect(seen).toEqual(["cancelled"]);
    // Still swallowed: Escape closes overlays elsewhere in the app, and a
    // recording that cancels AND closes the page it was on is one press
    // doing two jobs.
    expect(handler).not.toHaveBeenCalled();
    release();
  });

  it("swallows a modifier held on its own without recording it", () => {
    const seen: string[] = [];
    const release = captureKeys({
      onChord: (r) => seen.push(r.keys),
      onCancel: () => seen.push("cancelled"),
    });

    press("Meta");

    expect(seen, "half a chord is not a chord").toEqual([]);
    expect(handler).not.toHaveBeenCalled();
    release();
  });

  it("hands the keyboard to whoever claimed it last", () => {
    const first: string[] = [];
    const second: string[] = [];
    const releaseFirst = captureKeys({
      onChord: (r) => first.push(r.keys),
      onCancel: () => {},
    });
    const releaseSecond = captureKeys({
      onChord: (r) => second.push(r.keys),
      onCancel: () => {},
    });

    press("k");
    expect(first).toEqual([]);
    expect(second).toEqual(["⌘K"]);

    // The row that lost its turn releasing must not switch off the row that
    // took it — the same rule fileCloseKey.ts keeps for ⌘W.
    releaseFirst();
    expect(capturing()).toBe(true);
    press("j");
    expect(second).toEqual(["⌘K", "⌘J"]);
    releaseSecond();
    expect(capturing()).toBe(false);
  });
});
