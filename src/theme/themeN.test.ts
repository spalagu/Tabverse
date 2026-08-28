/**
 * The theme system holds N themes, not two.
 *
 * Adding a theme should require token data rather than consumer-specific
 * code. Its discriminating form is the contrapositive: anywhere a theme
 * name is still hard-coded, a theme
 * that is not one of the two built-ins fails at that spot. So every test
 * here drives a theme picked as "not dark and not light" — read off
 * tokens.json rather than named — through one consumer each. Naming the
 * theme in this file would make the tests pass for the wrong reason: they
 * would then be about that theme rather than about any theme.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logs: [] as string[] }));
vi.mock("../errlog", () => ({
  coreLog: (level: string, msg: string) => {
    mocks.logs.push(`${level}: ${msg}`);
  },
  installErrorReporting: () => {},
}));

import { asThemePreference, resolve } from "./resolve";
import {
  BUILTIN_THEMES,
  FALLBACK_THEME,
  applyThemeVars,
  defineEditorThemes,
  editorThemeName,
  groupColors,
  isThemeName,
  resetUnknownThemeLogForTest,
  resolveThemeName,
  terminalTheme,
  themeChoices,
  themeColors,
  themeDef,
  themeIds,
  themeShadows,
  type ThemeName,
} from "./tokens";

/** Themes that are neither of the built-in two — the ones every hard-coded
 *  name would drop. Empty would make this whole file vacuous, so the first
 *  test refuses that outcome rather than passing quietly. */
const EXTRA_THEMES: readonly ThemeName[] = themeIds().filter(
  (t) => !(BUILTIN_THEMES as readonly string[]).includes(t),
);

afterEach(() => {
  mocks.logs.length = 0;
  resetUnknownThemeLogForTest();
});
describe("the theme set is open-ended", () => {
  it("tokens.json carries themes beyond the built-in two", () => {
    // If this ever goes red, every other test in the file has stopped
    // discriminating — they would all be running against a built-in.
    expect(EXTRA_THEMES.length).toBeGreaterThan(0);
    expect(themeIds().length).toBeGreaterThan(BUILTIN_THEMES.length);
  });

  it("the built-in two are still there, because every degrade path lands on them", () => {
    for (const t of BUILTIN_THEMES) expect(isThemeName(t)).toBe(true);
    expect(isThemeName(FALLBACK_THEME)).toBe(true);
  });

  it("every theme offers itself with a label and an appearance", () => {
    const choices = themeChoices();
    expect(choices.map((c) => c.id)).toEqual([...themeIds()]);
    for (const c of choices) {
      expect(c.label.length, `${c.id} label`).toBeGreaterThan(0);
      expect(["light", "dark"]).toContain(c.appearance);
    }
  });
});

describe("a theme beyond the built-in two reaches every consumer", () => {
  it.each(EXTRA_THEMES)("%s is accepted as a stored preference", (t) => {
    expect(asThemePreference(t)).toBe(t);
    // An explicit preference ignores the OS in both directions.
    expect(resolve(t, true)).toBe(t);
    expect(resolve(t, false)).toBe(t);
  });

  it.each(EXTRA_THEMES)("%s projects its own CSS variables", (t) => {
    const root = document.createElement("div");
    applyThemeVars(root, t);
    expect(root.dataset.theme).toBe(t);
    expect(root.style.getPropertyValue("--bg")).toBe(themeColors(t).bg);
    expect(root.style.getPropertyValue("--shadow-panel")).toBe(themeShadows(t).panel);
    // Not the fallback's values wearing the new theme's name.
    expect(root.style.getPropertyValue("--bg")).not.toBe(
      themeColors(FALLBACK_THEME).bg,
    );
  });

  it.each(EXTRA_THEMES)("%s gets a terminal theme of its own", (t) => {
    const term = terminalTheme(t);
    expect(term.background).toBe(themeColors(t).termBg);
    expect(term.foreground).toBe(themeColors(t).fg);
    expect(term.red).toBe(themeDef(t).ansi.red);
  });

  it.each(EXTRA_THEMES)("%s gets an editor theme name of its own", (t) => {
    // The spot the mutation check below reverts: a ternary here folds every
    // theme into one of two names, and Monaco then paints the wrong one.
    expect(editorThemeName(t)).toBe(`tabverse-${t}`);
    for (const other of themeIds()) {
      if (other !== t) expect(editorThemeName(other)).not.toBe(editorThemeName(t));
    }
  });

  it.each(EXTRA_THEMES)("%s gets a folder palette of the shared length", (t) => {
    expect(groupColors(t).length).toBe(groupColors(FALLBACK_THEME).length);
  });

  it("Monaco is handed every theme, with the base its appearance asks for", () => {
    const defined: Array<{ name: string; base: string }> = [];
    const fakeMonaco = {
      editor: {
        defineTheme: (name: string, data: { base: string }) =>
          defined.push({ name, base: data.base }),
      },
    };
    defineEditorThemes(fakeMonaco as unknown as Parameters<typeof defineEditorThemes>[0]);
    expect(defined.map((d) => d.name)).toEqual(themeIds().map(editorThemeName));
    for (const t of themeIds()) {
      const entry = defined.find((d) => d.name === editorThemeName(t));
      expect(entry?.base, `${t} base`).toBe(
        themeDef(t).appearance === "dark" ? "vs-dark" : "vs",
      );
    }
  });
});

describe("an id nobody declared degrades instead of breaking", () => {
  const UNKNOWN = "no-such-theme-here";

  it("is not a theme name and is not a preference", () => {
    expect(isThemeName(UNKNOWN)).toBe(false);
    expect(asThemePreference(UNKNOWN)).toBe("system");
  });

  it("resolves to the fallback and says so once", () => {
    expect(resolveThemeName(UNKNOWN)).toBe(FALLBACK_THEME);
    expect(mocks.logs.filter((l) => l.includes(UNKNOWN))).toHaveLength(1);
    // The compensation for the lost union is a log line, not a log flood:
    // a paint path hitting this every frame must not fill the log.
    resolveThemeName(UNKNOWN);
    resolveThemeName(UNKNOWN);
    expect(mocks.logs.filter((l) => l.includes(UNKNOWN))).toHaveLength(1);
  });

  it("paints the fallback and stamps the fallback's name", () => {
    const root = document.createElement("div");
    applyThemeVars(root, UNKNOWN);
    expect(root.dataset.theme).toBe(FALLBACK_THEME);
    expect(root.style.getPropertyValue("--bg")).toBe(
      themeColors(FALLBACK_THEME).bg,
    );
  });
});
