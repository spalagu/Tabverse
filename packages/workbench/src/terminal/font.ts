export const TERMINAL_FONT_STACK = [
  // First, but range-limited to the icon area by its @font-face: icons render
  // from the font we ship (complete, version-pinned), instead of depending on
  // whatever vintage of patched font — and whatever per-engine fallback
  // behavior — the machine happens to have. Text codepoints fall through.
  '"Tabverse Symbols"',
  '"JetBrainsMono Nerd Font Mono"',
  '"JetBrainsMono Nerd Font"',
  '"Hack Nerd Font Mono"',
  '"FiraCode Nerd Font Mono"',
  '"MesloLGS NF"',
  '"SF Mono"',
  "Menlo",
  "Monaco",
  // Cascadia Code, not Cascadia Mono: the two are one typeface shipped twice,
  // and Mono is the cut with the programming ligatures REMOVED. Naming Mono
  // asked, on every Windows machine, for the version with less in it.
  '"Cascadia Code"',
  '"DejaVu Sans Mono"',
  "monospace",
].join(", ");

/**
 * The family the bundled ligature font is declared under (`src/styles.css`,
 * built by `tools/build-ligature-subset.sh`).
 *
 * A BUNDLED FILE AND NOT A NAME THE MACHINE MIGHT HAVE, which is the entire
 * reason the ligature switch can work at all: user-installed fonts are not
 * consistently visible to the packaged webview, and the reliable system
 * faces — Menlo and Monaco — have no ligatures. A `@font-face` is loaded by the page and never
 * asks the system, so this face is present on every machine and no other one
 * can be relied on.
 */
export const LIGATURE_FONT_FAMILY = '"Tabverse Ligatures"';

/**
 * Wait for the bundled symbols font before measuring the cell grid.
 *
 * xterm sizes its grid from the first available font at open() time. If the
 * webfont lands afterwards, every icon is drawn at a width the layout did not
 * account for, and the prompt ends up overlapping itself.
 */
export async function waitForTerminalFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  // Bounded: nothing downstream may wait indefinitely on a font.
  const bail = new Promise<void>((res) => setTimeout(res, 3000));
  await Promise.race([loadIconFont(), bail]);
}

async function loadIconFont(): Promise<void> {
  try {
    await document.fonts.load('13px "Tabverse Symbols"', "");
    await document.fonts.ready;
  } catch {
    // A machine without the font still renders text; only icons suffer.
  }
}

// ------------------------------------------------- what the user asked for

export interface TerminalFont {
  /**
   * The family the user named, or the empty string for "whatever the app
   * ships with". Several may be written, separated by commas, in which case
   * they are tried in order ahead of the built-in stack.
   */
  family: string;
  /** Point size of the terminal's text. */
  size: number;
  /**
   * Line spacing as a percentage of the font's natural height — the unit the
   * file uses, because its numbers are whole ones. xterm wants the
   * multiplier, which is this divided by a hundred ([`xtermLineHeight`]).
   */
  lineHeightPercent: number;
}

/** What xterm is told, in xterm's own vocabulary. */
export interface XtermFontOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

/** Anything with xterm's `options` — a `Terminal`, or a test's stand-in. */
export interface XtermFontTarget {
  options: {
    fontFamily?: string;
    fontSize?: number;
    lineHeight?: number;
  };
}

/**
 * How much smaller the file panel's shell is drawn than a terminal tab.
 *
 * One point, which is the difference the panel shipped with (12 against 13).
 * A step and not a size: the panel is a short strip under a file listing and
 * has always been the quieter of the two, and expressing that as "one point
 * down from whatever you chose" is what lets a user set their size once and
 * have both surfaces obey it.
 */
export const PANEL_FONT_STEP = 1;

const PERCENT = 100;

/** The multiplier xterm's `lineHeight` takes, from the file's percentage. */
export function xtermLineHeight(percent: number): number {
  return percent / PERCENT;
}

/**
 * The families in a configured value, in order, unquoted and trimmed.
 *
 * A list rather than one name because a font stack is what people write when
 * they have a favourite and a second choice, and because refusing the comma
 * would mean quietly using a family called `Fira Code, Menlo`, which nobody
 * has.
 */
export function familyList(configured: string): string[] {
  return configured
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, "").trim())
    .filter((part) => part !== "");
}

/**
 * The user's families in front of the built-in stack — never instead of it.
 *
 * The stack is not a fallback for a font that failed to load; it is where
 * the prompt icons come from. `"Tabverse Symbols"` is limited by its
 * `@font-face` to the Private Use Area, so it supplies the separators and
 * glyphs that a plain text font has no codepoints for, and a family that
 * replaced the whole stack would turn every one of them into a tofu box.
 * The user's choice wins for every character it can draw, which is what
 * choosing a font means.
 */
export function fontStackFor(configured: string, ligatures?: boolean): string {
  const families = familyList(configured);
  const chosen =
    families.length === 0
      ? TERMINAL_FONT_STACK
      : [
          ...families.map((f) => `"${f.replace(/["\\]/g, "")}"`),
          TERMINAL_FONT_STACK,
        ].join(", ");
  return ligatures === true ? `${LIGATURE_FONT_FAMILY}, ${chosen}` : chosen;
}

/**
 * The three options xterm needs, or null while nothing has been read.
 *
 * `sizeStep` is subtracted from the point size, and exists for the one
 * surface that has always drawn smaller than a terminal tab: the file
 * panel's shell (see its own comment). It is a step away from the user's
 * size rather than a size of its own, so the panel follows every change they
 * make and keeps the relation it shipped with.
 */
export function xtermFontOptions(
  font: TerminalFont | null,
  sizeStep = 0,
  ligatures?: boolean
): XtermFontOptions | null {
  if (font === null) return null;
  return {
    fontFamily: fontStackFor(font.family, ligatures),
    // Never zero or negative, whatever the step: xterm divides by the cell
    // size it computes from this.
    fontSize: Math.max(1, font.size - sizeStep),
    lineHeight: xtermLineHeight(font.lineHeightPercent),
  };
}

export function applyTerminalFont(
  term: XtermFontTarget,
  font: TerminalFont | null,
  sizeStep = 0,
  ligatures?: boolean
): boolean {
  const next = xtermFontOptions(font, sizeStep, ligatures);
  if (next === null) return false;
  let moved = false;
  if (term.options.fontFamily !== next.fontFamily) {
    term.options.fontFamily = next.fontFamily;
    moved = true;
  }
  if (term.options.fontSize !== next.fontSize) {
    term.options.fontSize = next.fontSize;
    moved = true;
  }
  if (term.options.lineHeight !== next.lineHeight) {
    term.options.lineHeight = next.lineHeight;
    moved = true;
  }
  return moved;
}

// ------------------------------------------------------- the live channel

/**
 * What every terminal on screen is drawing with right now, and who to tell
 * when it changes.
 *
 * The same arrangement `shortcuts.ts` has for the key overlay, and for the
 * same reason: `state/config.ts` knows about this module and this module
 * knows nothing about configuration, so a hand-edited file, a settings-page
 * edit and the values injected before the first paint all reach every
 * terminal through one door — without the terminal views importing the
 * configuration layer, and without a store field, which would have meant
 * editing a file another strand of this milestone is holding.
 */
let current: TerminalFont | null = null;

let profileFamilies: Readonly<Record<string, string>> = {};

/**
 * Whether terminals are to draw ligatures (`terminal.ligatures`), or null
 * while the file has not been read.
 *
 * NULL IS NOT "OFF" AND NOTHING HERE MAY TURN IT INTO ONE — the same rule the
 * font above obeys. A reader that meets null has been told nothing and does
 * the plainer thing (see [`terminalLigatures`]); it does not get to record a
 * default, which lives in `impl Default for Config` and reaches this module
 * over the wire like every other configured value.
 */
let ligatures: boolean | null = null;

let profileLigatures: Readonly<Record<string, boolean>> = {};

const listeners = new Set<() => void>();

function announce(): void {
  for (const fn of listeners) fn();
}

/**
 * The font a terminal opened under `profile` is to use — the profile's
 * family if it named one, the configured family otherwise.
 *
 * Size and spacing are not per-profile: `[[terminal.profiles]]` carries a
 * `font`, which is a family, and inventing two more fields here would be
 * this module deciding what the file format is.
 */
export function terminalFont(profile?: string): TerminalFont | null {
  if (current === null) return null;
  const override = profile === undefined ? undefined : profileFamilies[profile];
  if (override === undefined || override.trim() === "") return current;
  return { ...current, family: override };
}

/** Every profile that overrides the family, by name. */
export function profileFontFamilies(): Readonly<Record<string, string>> {
  return profileFamilies;
}

/**
 * Whether a terminal opened under `profile` draws ligatures — the profile's
 * own answer if it gave one, the configured answer otherwise, and null while
 * nothing has been read.
 *
 * WHAT THE CALLER DOES WITH NULL is skip the ligature addon and keep GPU
 * acceleration, which is not a default recorded here but the plainer of the
 * two arrangements: an unasked-for terminal is the one this app has always
 * opened. In the desktop the configuration is injected before the first
 * script runs, so this is null only in a browser client that has yet to
 * answer, and the answer arrives before any terminal that follows.
 */
export function terminalLigatures(profile?: string): boolean | null {
  const override = profile === undefined ? undefined : profileLigatures[profile];
  return override === undefined ? ligatures : override;
}

/** Every profile that overrides the ligature switch, by name. */
export function profileLigatureOverrides(): Readonly<Record<string, boolean>> {
  return profileLigatures;
}

/** Publish what the file says. Announced even when the values are equal to
 * what was there: the callers are idempotent and [`applyTerminalFont`] is
 * the thing that decides whether anything moved. */
export function setTerminalFont(font: TerminalFont): void {
  current = font;
  announce();
}

/** Publish the per-profile families. */
export function setProfileFontFamilies(map: Record<string, string>): void {
  profileFamilies = { ...map };
  announce();
}

/** Publish what the file says about ligatures. */
export function setTerminalLigatures(on: boolean): void {
  ligatures = on;
  announce();
}

/** Publish the per-profile ligature switches. */
export function setProfileLigatures(map: Record<string, boolean>): void {
  profileLigatures = { ...map };
  announce();
}

/**
 * Hear about every change, and hear the current state once immediately.
 *
 * The immediate call is not a convenience: a terminal that mounted before
 * the file had been read would otherwise wait for the *next* change to pick
 * up the values it was born too early for.
 */
export function subscribeTerminalFont(fn: () => void): () => void {
  listeners.add(fn);
  fn();
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: forget everything that was published. */
export function resetTerminalFontForTest(): void {
  current = null;
  profileFamilies = {};
  ligatures = null;
  profileLigatures = {};
  listeners.clear();
}
