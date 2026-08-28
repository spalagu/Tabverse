import { describe, expect, it } from "vitest";
import { TOOLBAR_BYTES, applyStickyCtrl } from "./toolbarKeys";

describe("toolbar key encodings", () => {
  it("sends the encodings a hardware keyboard would", () => {
    expect(TOOLBAR_BYTES.esc).toBe("\x1b");
    expect(TOOLBAR_BYTES.tab).toBe("\t");
    expect(TOOLBAR_BYTES.up).toBe("\x1b[A");
    expect(TOOLBAR_BYTES.down).toBe("\x1b[B");
    expect(TOOLBAR_BYTES.right).toBe("\x1b[C");
    expect(TOOLBAR_BYTES.left).toBe("\x1b[D");
  });
});

describe("applyStickyCtrl", () => {
  it("passes input through untouched while disarmed", () => {
    expect(applyStickyCtrl("c", false)).toEqual({ bytes: "c", consumed: false });
    expect(applyStickyCtrl("\x1b[A", false)).toEqual({
      bytes: "\x1b[A",
      consumed: false,
    });
  });

  it("turns the next letter into its control code — Ctrl+C is two taps", () => {
    expect(applyStickyCtrl("c", true)).toEqual({ bytes: "\x03", consumed: true });
    expect(applyStickyCtrl("C", true)).toEqual({ bytes: "\x03", consumed: true });
    expect(applyStickyCtrl("d", true)).toEqual({ bytes: "\x04", consumed: true });
    expect(applyStickyCtrl("a", true)).toEqual({ bytes: "\x01", consumed: true });
    expect(applyStickyCtrl("[", true)).toEqual({ bytes: "\x1b", consumed: true });
  });

  it("maps Ctrl+? to DEL by terminal convention", () => {
    expect(applyStickyCtrl("?", true)).toEqual({ bytes: "\x7f", consumed: true });
  });

  it("disarms without mangling anything that is not a single printable", () => {
    // An escape sequence (toolbar arrow), a paste, an IME commit: sent as
    // typed, but the armed modifier is spent so its state stays predictable.
    expect(applyStickyCtrl("\x1b[A", true)).toEqual({
      bytes: "\x1b[A",
      consumed: true,
    });
    expect(applyStickyCtrl("pasted text", true)).toEqual({
      bytes: "pasted text",
      consumed: true,
    });
    expect(applyStickyCtrl("\r", true)).toEqual({ bytes: "\r", consumed: true });
  });
});
