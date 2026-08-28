import { describe, expect, it } from "vitest";
import tokens from "@tabverse/workbench/theme/tokens.json";
import { remoteMirrorTheme, terminalTheme } from "./tokens";

const ORIGINAL_DARK_THEME: Record<string, string> = {
  background: "#0b0d11",
  foreground: "#dde3ee",
  cursor: "#93a6ff",
  cursorAccent: "#0b0d11",
  selectionBackground: "rgba(147,166,255,0.32)",
  black: "#20242c",
  red: "#ff6b6b",
  green: "#7ad97a",
  yellow: "#e6c07b",
  blue: "#6ea8fe",
  magenta: "#c792ea",
  cyan: "#6cd9d3",
  white: "#c7ccd6",
  brightBlack: "#5a6270",
  brightRed: "#ff8f8f",
  brightGreen: "#9df09d",
  brightYellow: "#ffd894",
  brightBlue: "#8fbcff",
  brightMagenta: "#dcb0f2",
  brightCyan: "#8ce8e2",
  brightWhite: "#e8ecf2",
};

const ORIGINAL_REMOTE_THEME: Record<string, string> = {
  background: "#0d0b11",
  foreground: "#dde3ee",
  cursor: "#c792ea",
  cursorAccent: "#0d0b11",
  selectionBackground: "rgba(199,146,234,0.28)",
};

/** A color as the RGBA bytes the renderer quantizes it to. */
function normalize(color: string): [number, number, number, number] {
  const c = color.trim();
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (hex) {
    return [
      parseInt(hex[1].slice(0, 2), 16),
      parseInt(hex[1].slice(2, 4), 16),
      parseInt(hex[1].slice(4, 6), 16),
      hex[2] ? parseInt(hex[2], 16) : 255,
    ];
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(c);
  if (fn) {
    return [
      Number(fn[1]),
      Number(fn[2]),
      Number(fn[3]),
      fn[4] === undefined ? 255 : Math.round(Number(fn[4]) * 255),
    ];
  }
  throw new Error(`unparseable color: ${color}`);
}

function luminance([r, g, b]: [number, number, number, number]): number {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(fg: string, bg: string): number {
  const [hi, lo] = [luminance(normalize(fg)), luminance(normalize(bg))].sort(
    (a, b) => b - a,
  );
  return (hi + 0.05) / (lo + 0.05);
}

const asRecord = (t: object) => t as Record<string, string>;

describe("terminalTheme dark equals the pre-migration DARK_THEME", () => {
  const derived = asRecord(terminalTheme("dark"));

  it("exposes exactly the original key set", () => {
    expect(Object.keys(derived).sort()).toEqual(
      Object.keys(ORIGINAL_DARK_THEME).sort(),
    );
  });

  it.each(Object.entries(ORIGINAL_DARK_THEME))("%s is unchanged", (key, value) => {
    expect(normalize(derived[key]), key).toEqual(normalize(value));
  });
});

describe("terminalTheme light", () => {
  const dark = asRecord(terminalTheme("dark"));
  const light = asRecord(terminalTheme("light"));

  it("differs from dark on every key except the shared brightWhite", () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    for (const key of Object.keys(dark)) {
      if (key === "brightWhite") {
        // "White" means light in both themes; the slot is shared and exempt.
        expect(normalize(light[key])).toEqual(normalize(dark[key]));
      } else {
        expect(normalize(light[key]), key).not.toEqual(normalize(dark[key]));
      }
    }
  });

  const BASE = ["red", "green", "yellow", "blue", "magenta", "cyan", "black"];
  const BRIGHT = [
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightBlack",
  ];

  it.each(BASE)("light %s on term-bg ≥ 4.5 (white exempt)", (key) => {
    expect(ratio(light[key], light.background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(BRIGHT)("light %s on term-bg ≥ 3.0 (brightWhite exempt)", (key) => {
    expect(ratio(light[key], light.background)).toBeGreaterThanOrEqual(3.0);
  });

  it("light foreground on term-bg ≥ 4.5", () => {
    expect(ratio(light.foreground, light.background)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("remoteMirrorTheme is a fixed dark base", () => {
  const mirror = asRecord(remoteMirrorTheme());

  it("sets exactly the five chrome slots the hand copy set — no ANSI", () => {
    expect(Object.keys(mirror).sort()).toEqual(
      Object.keys(ORIGINAL_REMOTE_THEME).sort(),
    );
  });

  it("ground is --term-bg: the ruled fix of the #0d0b11 transposition typo", () => {
    expect(mirror.background).toBe(tokens.themes.dark.color.termBg);
    expect(mirror.cursorAccent).toBe(tokens.themes.dark.color.termBg);
    expect(normalize(mirror.background)).not.toEqual(
      normalize(ORIGINAL_REMOTE_THEME.background),
    );
  });

  it("cursor is the ANSI magenta slot, as before", () => {
    expect(mirror.cursor).toBe(tokens.themes.dark.ansi.magenta);
    expect(normalize(mirror.cursor)).toEqual(
      normalize(ORIGINAL_REMOTE_THEME.cursor),
    );
  });

  it("foreground and selection are unchanged", () => {
    expect(normalize(mirror.foreground)).toEqual(
      normalize(ORIGINAL_REMOTE_THEME.foreground),
    );
    expect(normalize(mirror.selectionBackground)).toEqual(
      normalize(ORIGINAL_REMOTE_THEME.selectionBackground),
    );
  });
});
