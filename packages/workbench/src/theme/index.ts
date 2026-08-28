import type { ITheme } from "@xterm/xterm";
import type * as monaco from "monaco-editor";
import tokens from "./tokens.json";

/** The Git states a badge can represent. Kept with the presentation mapping
 * so a UI consumer does not need the desktop filesystem adapter. */
export type GitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored"
  | "conflicted";

/** A host may forward the one-time fallback diagnostic to its own logger.
 * The browser-only Join entry intentionally leaves this unset. */
let reportUnknownTheme: (theme: string, fallback: string) => void = () => {};

export function setUnknownThemeReporter(
  reporter: (theme: string, fallback: string) => void,
): void {
  reportUnknownTheme = reporter;
}

export type ThemeName = string;
export type ThemePreference = ThemeName | "system";

/** Whether a theme paints light ink on a dark ground, or the reverse. The
 *  property consumers branch on now that the theme NAME tells them nothing:
 *  Monaco's base, the ANSI slots the contrast gate exempts, and which theme
 *  the "system" preference resolves to. */
export type ThemeAppearance = "light" | "dark";

export interface ThemeDefinition {
  label: string;
  appearance: ThemeAppearance;
  color: ThemeColors;
  ansi: Record<string, string>;
  shadow: ThemeShadows;
  palette: { group: readonly string[] };
}

/* tokens.json is data; TypeScript infers a literal type for it whose theme
 * keys are exactly the ones that happen to be in the file today. Reading it
 * through a string-keyed record is what makes "add a theme, change no code"
 * true — and it is the reason the shape below is asserted rather than
 * inferred. packages/workbench/src/theme/tokens.test.ts checks the assertion against the file:
 * every theme's key set, every appearance value, every colour's format. */
const THEMES = tokens.themes as unknown as Readonly<Record<string, ThemeDefinition>>;

/** The two themes that must exist. They are what every degrade path lands
 *  on, so tokens.schema.json requires them and nothing may remove them. */
export const BUILTIN_THEMES = ["dark", "light"] as const;

export const FALLBACK_THEME: ThemeName = "dark";

/** Every theme id, in the order tokens.json declares them — which is the
 *  order the appearance setting offers them in. */
export function themeIds(): readonly ThemeName[] {
  return Object.keys(THEMES);
}

export function isThemeName(v: unknown): v is ThemeName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(THEMES, v);
}

/* Logged once per unknown id: a theme that vanished from tokens.json is a
 * standing condition, and a paint path that hits it every frame would
 * otherwise fill the log with one line per frame. */
const reportedUnknown = new Set<string>();

/**
 * The theme that will actually be painted for an id — itself when it exists,
 * the fallback plus one log line when it does not. This is the runtime half
 * of what the two-value union used to do statically: a hand-edited config
 * file, a theme dropped between releases, a downgrade to an older build all
 * arrive here, and all of them leave with a theme rather than undefined.
 */
export function resolveThemeName(t: ThemeName): ThemeName {
  if (isThemeName(t)) return t;
  if (!reportedUnknown.has(t)) {
    reportedUnknown.add(t);
    reportUnknownTheme(t, FALLBACK_THEME);
  }
  return FALLBACK_THEME;
}

/** The definition for a theme id — the single lookup every other function
 *  here goes through, so the fallback rule is stated once. */
export function themeDef(t: ThemeName): ThemeDefinition {
  return THEMES[resolveThemeName(t)];
}

/** What a theme calls itself and how it reads, for anything that offers a
 *  choice between them. */
export function themeMeta(t: ThemeName): { id: ThemeName; label: string; appearance: ThemeAppearance } {
  const def = themeDef(t);
  return { id: t, label: def.label, appearance: def.appearance };
}

/** Every theme, in declaration order, as choices. */
export function themeChoices(): ReadonlyArray<ReturnType<typeof themeMeta>> {
  return themeIds().map(themeMeta);
}

/** Test-only: forget which unknown ids have already been reported. */
export function resetUnknownThemeLogForTest(): void {
  reportedUnknown.clear();
}

export interface ThemeColors {
  bg: string;
  bgSide: string;
  bgActive: string;
  bgHover: string;
  termBg: string;
  fg: string;
  muted: string;
  fgDim: string;
  line: string;
  border: string;
  accent: string;
  accentSelection: string;
  danger: string;
  ok: string;
  warn: string;
  remoteEdge: string;
  info: string;
  panel: string;
  hoverVeil: string;
  surfacePaper: string;
  surfacePaperFg: string;
  termFindMatchBg: string;
  termFindRulerFg: string;
  scrim: string;
  scrimHeavy: string;
  checkerA: string;
  checkerB: string;
  paperLine: string;
  paperMuted: string;
  scrollThumb: string;
  scrollThumbHover: string;
  previewFindBg: string;
  previewFindCurrentBg: string;
  previewFindCurrentFg: string;
  progressTail: string;
  progressCore: string;
  progressHead: string;
}

export interface ThemeShadows {
  raise: string;
  panel: string;
  dialog: string;
}

export function themeColors(t: ThemeName): ThemeColors {
  return themeDef(t).color;
}

export function themeShadows(t: ThemeName): ThemeShadows {
  return themeDef(t).shadow;
}

export function groupColors(t: ThemeName): readonly string[] {
  return themeDef(t).palette.group;
}

/** One persisted folder palette slot in a concrete theme. The modulo keeps
 * a damaged or older out-of-range index visible and stable. */
export function groupColor(t: ThemeName, colorIndex: number): string {
  const palette = groupColors(t);
  const index = ((colorIndex % palette.length) + palette.length) % palette.length;
  return palette[index];
}

const GIT_BADGE_TOKEN: Record<GitStatus, keyof ThemeColors> = {
  modified: "warn",
  added: "ok",
  untracked: "muted",
  deleted: "danger",
  conflicted: "danger",
  renamed: "info",
  ignored: "fgDim",
};

export function gitBadgeColor(s: GitStatus, t: ThemeName): string {
  return themeColors(t)[GIT_BADGE_TOKEN[s]];
}

const PROFILE_BADGE_TOKEN: Record<string, keyof ThemeColors> = {
  amber: "warn",
  green: "ok",
  red: "danger",
  blue: "info",
  violet: "remoteEdge",
  grey: "fgDim",
  accent: "accent",
};

/** The CSS variable a profile's badge color is worn through — a var() name,
 * so a theme switch recolors the chip without a re-render from this file's
 * consumers. */
export function profileBadgeVar(name: string): string {
  const key = PROFILE_BADGE_TOKEN[name.trim().toLowerCase()];
  return key === undefined ? "var(--muted)" : `var(--${kebab(key)})`;
}

export function terminalTheme(t: ThemeName): ITheme {
  const def = themeDef(t);
  const c = def.color;
  return {
    background: c.termBg,
    foreground: c.fg,
    cursor: c.accent,
    cursorAccent: c.termBg,
    selectionBackground: c.accentSelection,
    ...def.ansi,
  };
}

/** A token color with an alpha channel appended (#rrggbb → #rrggbbaa).
 *  The color itself always comes from tokens.json; only the format is
 *  produced here, so this file still holds no color value of its own. An
 *  8-bit alpha renders identically to the fractional rgba() it replaces —
 *  both quantize to the same byte. */
function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

/** The alpha every selection veil in the dark theme carries (the value the
 *  accentSelection token uses); remoteMirrorTheme applies it to magenta. */
const SELECTION_ALPHA = 0.28;

export const MIRROR_THEME: ThemeName = "dark";

export function remoteMirrorTheme(): ITheme {
  const def = themeDef(MIRROR_THEME);
  const c = def.color;
  const magenta = def.ansi.magenta;
  return {
    background: c.termBg,
    foreground: c.fg,
    cursor: magenta,
    cursorAccent: c.termBg,
    selectionBackground: withAlpha(magenta, SELECTION_ALPHA),
  };
}

/** Monaco's name for a theme — one id in, one name out, so a theme Monaco
 *  has never heard of still gets a name of its own rather than being folded
 *  into one of two. */
export function editorThemeName(t: ThemeName): string {
  return `tabverse-${t}`;
}

export function defineEditorThemes(m: typeof monaco): void {
  for (const t of themeIds()) {
    const def = themeDef(t);
    const c = def.color;
    m.editor.defineTheme(editorThemeName(t), {
      base: def.appearance === "dark" ? "vs-dark" : "vs",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": c.termBg,
        "editorGutter.background": c.termBg,
        "editor.lineHighlightBackground": c.bgHover,
        "editorLineNumber.foreground": c.fgDim,
        "editorLineNumber.activeForeground": c.muted,
      },
    });
  }
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function cssVarEntries(t: ThemeName): [name: string, value: string][] {
  const s = tokens.shared;
  const theme = themeDef(t);
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(s.font)) out.push([`--font-${kebab(k)}`, v]);
  for (const [k, v] of Object.entries(s.fontSize)) out.push([`--fs-${k}`, `${v}px`]);
  for (const [k, v] of Object.entries(s.lineHeight)) out.push([`--lh-${kebab(k)}`, `${v}`]);
  for (const [k, v] of Object.entries(s.space)) out.push([`--sp-${k}`, `${v}px`]);
  for (const [k, v] of Object.entries(s.radius)) out.push([`--r-${k}`, `${v}px`]);
  for (const [k, v] of Object.entries(s.motion))
    out.push([`--${kebab(k)}`, typeof v === "number" ? `${v}ms` : v]);
  for (const [k, v] of Object.entries(s.z)) out.push([`--z-${k}`, `${v}`]);
  for (const [k, v] of Object.entries(s.findHighlight))
    out.push([`--find-highlight-${kebab(k)}`, v]);
  for (const [k, v] of Object.entries(theme.color)) out.push([`--${kebab(k)}`, v]);
  for (const [k, v] of Object.entries(theme.shadow)) out.push([`--shadow-${k}`, v]);
  return out;
}

/** Every CSS variable the theme system defines. Layout variables
 *  (--sidebar-w / --indent / --window-controls / --depth) are geometry, not
 *  theme — they stay in styles.css and are absent here on purpose.
 *  Derived from one theme because every theme derives the same NAMES (only
 *  the values differ) — packages/workbench/src/theme/tokens.test.ts holds that across all of
 *  them, so which one is read here cannot matter. */
export const CSS_VAR_NAMES: readonly string[] = cssVarEntries(FALLBACK_THEME).map(
  ([name]) => name,
);

export function applyThemeVars(root: HTMLElement, t: ThemeName): void {
  const painted = resolveThemeName(t);
  for (const [name, value] of cssVarEntries(painted)) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = painted;
}
