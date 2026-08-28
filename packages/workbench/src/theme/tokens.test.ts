/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import tokens from "@tabverse/workbench/theme/tokens.json";
import {
  BUILTIN_THEMES,
  CSS_VAR_NAMES,
  applyThemeVars,
  groupColor,
  themeColors,
  themeDef,
  themeIds,
  type ThemeName,
} from "./index";

/** Read off tokens.json, not written down here: a theme added to the file
 *  joins every test below without this line being edited. */
const THEMES: readonly ThemeName[] = themeIds();

// shadow grew by one when the focus halo became a token (--shadow-halo).
const VALUES_PER_THEME = 37 + 16 + 4 + 6;

function deepKeyPaths(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return [prefix];
  return Object.keys(obj).flatMap((k) =>
    deepKeyPaths((obj as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k),
  );
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function expectedVars(t: ThemeName): Map<string, string> {
  const s = tokens.shared;
  const theme = themeDef(t);
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(s.font)) out.set(`--font-${kebab(k)}`, v);
  for (const [k, v] of Object.entries(s.fontSize)) out.set(`--fs-${k}`, `${v}px`);
  for (const [k, v] of Object.entries(s.lineHeight)) out.set(`--lh-${kebab(k)}`, `${v}`);
  for (const [k, v] of Object.entries(s.space)) out.set(`--sp-${k}`, `${v}px`);
  for (const [k, v] of Object.entries(s.radius)) out.set(`--r-${k}`, `${v}px`);
  for (const [k, v] of Object.entries(s.motion))
    out.set(`--${kebab(k)}`, typeof v === "number" ? `${v}ms` : v);
  for (const [k, v] of Object.entries(s.z)) out.set(`--z-${k}`, `${v}`);
  for (const [k, v] of Object.entries(s.findHighlight))
    out.set(`--find-highlight-${kebab(k)}`, v);
  for (const [k, v] of Object.entries(theme.color)) out.set(`--${kebab(k)}`, v);
  for (const [k, v] of Object.entries(theme.shadow)) out.set(`--shadow-${k}`, v);
  return out;
}

function writtenVars(root: HTMLElement): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < root.style.length; i++) {
    const name = root.style.item(i);
    out.set(name, root.style.getPropertyValue(name));
  }
  return out;
}

describe("tokens.json shape", () => {
  it("the two built-in themes are present", () => {
    // They are where every degrade path lands — an unknown id, a "system"
    // preference, a store built before the preference was read.
    for (const t of BUILTIN_THEMES) expect(THEMES).toContain(t);
  });

  it.each(THEMES)("%s exposes the same key set as every other theme", (t) => {
    // Compared against the first declared theme rather than against "dark":
    // the reference is whichever theme the file happens to start with, so
    // the rule keeps holding if the built-ins are ever reordered.
    const reference = deepKeyPaths(themeDef(THEMES[0])).sort();
    expect(deepKeyPaths(themeDef(t)).sort()).toEqual(reference);
  });

  it.each(THEMES)("%s carries exactly the values a theme owes", (t) => {
    const theme = themeDef(t);
    const values =
      Object.keys(theme.color).length +
      Object.keys(theme.ansi).length +
      Object.keys(theme.shadow).length +
      theme.palette.group.length;
    expect(values).toBe(VALUES_PER_THEME);
  });

  it.each(THEMES)("%s names itself and says how it reads", (t) => {
    const theme = themeDef(t);
    expect(theme.label.length, `themes.${t}.label`).toBeGreaterThan(0);
    expect(["light", "dark"], `themes.${t}.appearance`).toContain(theme.appearance);
  });

  it.each(THEMES)("%s has a group palette of the shared length", (t) => {
    expect(themeDef(t).palette.group.length).toBe(
      themeDef(THEMES[0]).palette.group.length,
    );
  });

  it.each(THEMES)("%s resolves damaged group palette indexes cyclically", (t) => {
    const palette = themeDef(t).palette.group;
    expect(groupColor(t, palette.length)).toBe(palette[0]);
    expect(groupColor(t, -1)).toBe(palette[palette.length - 1]);
  });

  it("every color value is well-formed", () => {
    const colorRe = /^#[0-9a-f]{6}$|^rgba?\(/;
    for (const t of THEMES) {
      const theme = themeDef(t);
      for (const [k, v] of Object.entries(theme.color)) {
        expect(v, `themes.${t}.color.${k}`).toMatch(colorRe);
      }
      for (const [k, v] of Object.entries(theme.ansi)) {
        expect(v, `themes.${t}.ansi.${k}`).toMatch(colorRe);
      }
      for (const v of theme.palette.group) expect(v).toMatch(colorRe);
    }
    for (const [k, v] of Object.entries(tokens.shared.findHighlight)) {
      expect(v, `shared.findHighlight.${k}`).toMatch(colorRe);
    }
  });

  it("numeric scales are positive", () => {
    const scales: Record<string, number>[] = [
      tokens.shared.fontSize,
      tokens.shared.lineHeight,
      tokens.shared.space,
      tokens.shared.radius,
    ];
    for (const scale of scales) {
      for (const v of Object.values(scale)) expect(v).toBeGreaterThan(0);
    }
  });
});

describe("applyThemeVars projection", () => {
  it.each(THEMES)("%s: writes exactly the derived set, key by key", (t) => {
    const root = document.createElement("div");
    applyThemeVars(root, t);
    const expected = expectedVars(t);
    const written = writtenVars(root);
    expect([...written.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [name, value] of expected) {
      expect(written.get(name), name).toBe(value);
    }
    expect(root.dataset.theme).toBe(t);
    expect([...expected.keys()].sort()).toEqual([...CSS_VAR_NAMES].sort());
  });

  it.each(THEMES)("%s derives the same variable name set as every other", (t) => {
    // What lets CSS_VAR_NAMES be derived from one theme, and lets a
    // stylesheet written against the built-ins keep working under a theme
    // that did not exist when it was written.
    expect([...expectedVars(t).keys()].sort()).toEqual(
      [...expectedVars(THEMES[0]).keys()].sort(),
    );
  });

  it("layout variables are not part of the theme projection", () => {
    for (const layout of [
        "--sidebar-w",
        "--indent",
        "--window-controls",
        "--depth",
        "--tree-depth",
      ]) {
      expect(CSS_VAR_NAMES).not.toContain(layout);
    }
  });

  it.each(THEMES)("a round trip through %s and back restores the projection", (t) => {
    // Every theme is passed through, not just the two: a theme that defined
    // a variable the others do not would leave it standing on the way back,
    // and this is where that shows up.
    const once = document.createElement("div");
    applyThemeVars(once, THEMES[0]);
    const roundTrip = document.createElement("div");
    applyThemeVars(roundTrip, THEMES[0]);
    applyThemeVars(roundTrip, t);
    applyThemeVars(roundTrip, THEMES[0]);
    expect(writtenVars(roundTrip)).toEqual(writtenVars(once));
    expect(roundTrip.dataset.theme).toBe(THEMES[0]);
  });
});

describe("styles.css :root defines geometry only (absorption complete)", () => {
  const stylesCss = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
  const rootBlock = stylesCss.match(/:root\s*\{([^}]*)\}/);
  const decls = new Map<string, string>();
  for (const decl of (rootBlock?.[1] ?? "").split(";")) {
    const m = decl.match(/(--[\w-]+)\s*:\s*([\s\S]+)/);
    if (m) decls.set(m[1], m[2].trim());
  }

  // The color variables the old :root used to define; each is now projected
  // from tokens.json and must never be redefined statically.
  const absorbed = [
    "--bg",
    "--bg-side",
    "--bg-active",
    "--bg-hover",
    "--term-bg",
    "--fg",
    "--muted",
    "--line",
    "--accent",
    "--danger",
  ];
  const layoutVars = new Set([
    "--sidebar-w",
    "--sidebar-row-inset",
    "--indent",
    "--window-controls",
    "--depth",
    "--tree-depth",
  ]);
  const normalize = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, " ").trim();

  it("found the :root block", () => {
    expect(decls.size).toBeGreaterThan(0);
  });

  it.each(absorbed)("%s is not statically redefined", (cssVar) => {
    expect(decls.has(cssVar)).toBe(false);
  });

  it("--radius stays retired (superseded by --r-md)", () => {
    expect(decls.has("--radius")).toBe(false);
    expect(stylesCss.includes("var(--radius)")).toBe(false);
  });

  it("font stacks match shared.font up to quote style", () => {
    // Kept static as the pre-projection fallback; identical to the tokens by
    // this assertion, so they cannot drift.
    expect(normalize(decls.get("--font-ui") ?? "")).toBe(normalize(tokens.shared.font.ui));
    expect(normalize(decls.get("--font-mono") ?? "")).toBe(
      normalize(tokens.shared.font.mono),
    );
  });

  it("every :root variable is accounted for", () => {
    // A color added to :root without a token would silently fork the truth
    // source; force the fork to show up here.
    for (const name of decls.keys()) {
      const known = layoutVars.has(name) || ["--font-ui", "--font-mono"].includes(name);
      expect(known, `unaccounted :root variable ${name}`).toBe(true);
    }
  });
});

describe("contrast claims", () => {
  function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function ratio(fg: string, bg: string): number {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  }

  type ColorKey = keyof ReturnType<typeof themeColors>;
  const uiPairs: [ColorKey, ColorKey][] = [
    ["fg", "bg"],
    ["fg", "bgActive"],
    ["fg", "bgSide"],
    ["fg", "termBg"],
    ["muted", "bg"],
    ["muted", "bgSide"],
    ["muted", "bgActive"],
    ["muted", "termBg"],
    ["fgDim", "bg"],
    ["fgDim", "bgSide"],
    ["fgDim", "termBg"],
    ["accent", "bg"],
    ["info", "bg"],
    ["danger", "bg"],
    ["ok", "bg"],
    ["warn", "bg"],
  ];

  const cases = THEMES.flatMap((t) =>
    uiPairs.map(([fg, bg]) => [t, fg, bg] as const),
  );

  it.each(cases)("%s: %s on %s ≥ 4.5", (t, fg, bg) => {
    const c = themeColors(t);
    expect(ratio(c[fg], c[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it("the ANSI slot at the background pole is the only exempt one", () => {
    // The exemption follows appearance, never a theme name: a dark theme's
    // "black" and a light theme's "white" are meant to vanish into the
    // terminal background, and the opposite pole is prose.
    for (const t of THEMES) {
      const theme = themeDef(t);
      const ground = theme.appearance === "dark" ? "black" : "white";
      const ink = theme.appearance === "dark" ? "white" : "black";
      const termBg = theme.color.termBg;
      expect(ratio(theme.ansi[ground], termBg), `${t} ansi ${ground}`).toBeLessThan(4.5);
      expect(ratio(theme.ansi[ink], termBg), `${t} ansi ${ink}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});
