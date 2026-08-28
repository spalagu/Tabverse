import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "../shortcuts";
import { formatKeys, HINT_KEYS } from "./formatKeys";

const GLYPH_RE = /[⌘⇧⌥⌃⏎↑↓←→]/;

describe("formatKeys over the whole SHORTCUTS table", () => {
  const keyed = SHORTCUTS.filter(
    (s): s is typeof s & { keys: string } => s.keys !== undefined
  );

  it("covers a non-trivial table", () => {
    expect(keyed.length).toBeGreaterThan(20);
  });

  for (const s of keyed) {
    it(`mac keeps ${s.keys} verbatim`, () => {
      expect(formatKeys(s.keys, "mac")).toBe(s.keys);
    });
    it(`other strips every glyph from ${s.keys}`, () => {
      const out = formatKeys(s.keys, "other");
      expect(out).not.toMatch(GLYPH_RE);
      expect(out.length).toBeGreaterThan(0);
    });
  }
});

describe("structural cases", () => {
  it("chord with two modifiers", () => {
    expect(formatKeys("⌘⇧P", "other")).toBe("Ctrl+Shift+P");
  });
  it("compound keeps the separator", () => {
    expect(formatKeys("⌘↑ / ⌘↓", "other")).toBe("Ctrl+Up / Ctrl+Down");
  });
  it("control-modifier chord", () => {
    expect(formatKeys("⌃Tab", "other")).toBe("Ctrl+Tab");
  });
  it("numeric range keeps its shape", () => {
    expect(formatKeys("⌘1…9", "other")).toBe("Ctrl+1…9");
  });
  it("punctuation chords pass the tail through", () => {
    expect(formatKeys("⌘⇧\\", "other")).toBe("Ctrl+Shift+\\");
    expect(formatKeys("⌘=", "other")).toBe("Ctrl+=");
  });
});

describe("hint-chip phrases", () => {
  it("bare keys become words", () => {
    expect(formatKeys(HINT_KEYS.enter, "other")).toBe("Enter");
    expect(formatKeys(HINT_KEYS.escape, "other")).toBe("Esc");
    expect(formatKeys(HINT_KEYS.up, "other")).toBe("Up");
    expect(formatKeys(HINT_KEYS.down, "other")).toBe("Down");
  });
  it("paired arrows read as alternatives", () => {
    expect(formatKeys(HINT_KEYS.upDown, "other")).toBe("Up/Down");
  });
  it("shifted key keeps the plus join", () => {
    expect(formatKeys(HINT_KEYS.shiftEnter, "other")).toBe("Shift+Enter");
  });
  it("compound of a glyph and a named key", () => {
    expect(formatKeys(HINT_KEYS.rightOrTab, "other")).toBe("Right / Tab");
  });
  it("run-together chords split back apart", () => {
    expect(formatKeys(HINT_KEYS.cmdUpDown, "other")).toBe(
      "Ctrl+Up Ctrl+Down"
    );
  });
  it("zoom shorthand maps its modifier only", () => {
    expect(formatKeys(HINT_KEYS.zoom, "other")).toBe("Ctrl+±0");
  });
  it("mac passes every hint phrase through", () => {
    for (const v of Object.values(HINT_KEYS)) {
      expect(formatKeys(v, "mac")).toBe(v);
    }
  });
});
