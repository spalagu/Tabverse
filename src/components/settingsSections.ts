import { STR } from "../strings";

export interface SettingsSection {
  /** Stable DOM anchor id, e.g. `appearance` for `#appearance`. */
  id: string;
  /** The section's `<h3>` text, read from the same STR leaf it renders. */
  heading: string;
  /**
   * The rail family this section belongs to. Sections of one family sit
   * contiguously — the list below is ordered by group for exactly that
   * reason — and the rail renders the group's caption above the first
   * entry of each run.
   */
  group: SettingsGroup;
  str: SectionStrings;
}

/**
 * The six families the rail's captions name (the caption strings live in
 * STR.settings.nav, beside `label`). "Danger zone" is a family of its own
 * on purpose: it reads as a warning only when nothing else sits under it.
 */
export type SettingsGroup =
  | "general"
  | "terminal"
  | "browser"
  | "network"
  | "automation"
  | "danger";

/**
 * What every section's STR subtree has in common. Only the heading is named:
 * the rest of the leaves differ per section and are read by walking, never
 * by name, so this stays a contract rather than a copy of the strings table.
 */
export interface SectionStrings {
  heading: string;
}

/** One section, with its heading taken from the subtree rather than retyped. */
function section(
  id: string,
  str: SectionStrings,
  group: SettingsGroup
): SettingsSection {
  return { id, heading: str.heading, group, str };
}

/**
 * Anchor id of the user scripts section. Named on its own only because it
 * is the one section rendered from another file, which therefore has to
 * import the id rather than read it off the list by position.
 */
export const USERSCRIPTS_SECTION_ID = "userscripts";

export const PROFILES_SECTION_ID = "profiles";

export const KEYBOARD_SECTION_ID = "keyboard";

export const TERMINAL_COMPLETIONS_SECTION_ID = "terminal-completions";

/**
 * Anchor id of the danger zone. Named for a third reason: the three
 * destructive actions it collects used to live in the sections they belonged
 * to by topic, and this id is what anything pointing at one of them —
 * `settings:danger` — now has to say.
 */
export const DANGER_SECTION_ID = "danger";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  // The order IS the page order and groups the rail's captions: sections of
  // one family sit together, and each caption renders above the first
  // section of its run.
  //
  // ── General: the app itself, before any of its domains. ──
  section("status", STR.settings.status, "general"),
  section("plugins", STR.settings.plugins, "general"),
  section("appearance", STR.settings.appearance, "general"),
  section("default-apps", STR.settings.defaultApps, "general"),
  section("keyboard", STR.settings.keyboard, "general"),
  // Session behavior: what survives a relaunch and what tidies itself up.
  section("session", STR.settings.session, "general"),
  section("auto-archive", STR.settings.autoArchive, "general"),
  // ── Terminal: a profile is largely appearance asked per terminal — which
  //    shell, which font, which badge — and completions are the other half
  //    of "extra text the terminal types for you". ──
  section(PROFILES_SECTION_ID, STR.settings.profiles, "terminal"),
  section(TERMINAL_COMPLETIONS_SECTION_ID, STR.settings.completions, "terminal"),
  // ── Browser: what browsing remembers and resolves through. ──
  section("search-engine", STR.settings.searchEngine, "browser"),
  section("history", STR.settings.history, "browser"),
  section("passwords", STR.settings.passwords, "browser"),
  section("sites", STR.settings.sites, "browser"),
  // ── Network & data: how this program reaches the outside, and what it
  //    keeps across machines. ──
  section("remote", STR.settings.remote, "network"),
  section("network", STR.settings.network, "network"),
  section("backup", STR.settings.migrate, "network"),
  // ── Automation: things the app does on the user's behalf while they are
  //    not looking at it. ──
  section("background-tasks", STR.settings.backgroundTasks, "automation"),
  section(USERSCRIPTS_SECTION_ID, STR.settings.userscripts, "automation"),
  section(DANGER_SECTION_ID, STR.settings.danger, "danger"),
];

/**
 * How far below the top of the visible page a section may sit and still
 * count as the one being read. A few pixels of slack, so a section that has
 * just been scrolled to lands on itself rather than on the one above it.
 */
export const CURRENT_SECTION_SLACK_PX = 24;

/** A section's top edge, in pixels below the top of the visible page. */
export interface SectionOffset {
  id: string;
  top: number;
}

/** What the scroll container looks like at the moment of measuring. */
export interface ScrollExtent {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

/**
 * Which section the reader is on — the whole of the decision, kept out of
 * the DOM so it can be exercised without one: the component is left with
 * nothing but measurement, and the rules below (the slack, the bottom of
 * the scroll, the page with no height) are tested as arithmetic.
 *
 * Returns null when there is nothing to judge: a page of zero height has
 * not been laid out, or is a settings tab that is mounted but is not the
 * tab on screen. Measuring one reads thirteen zero-height rectangles and
 * concludes the reader is at the bottom — which is what the first cut of
 * this did, landing on the last section every time the page opened.
 */
export function currentSectionAt(
  offsets: readonly SectionOffset[],
  view: ScrollExtent
): string | null {
  if (view.clientHeight === 0 || offsets.length === 0) return null;
  const scrollable = view.scrollHeight - view.clientHeight;
  // At the bottom of the scroll the last section wins outright. Without
  // this a short final section can never become current — it never reaches
  // the top of the page, however far one scrolls.
  if (scrollable > 0 && view.scrollTop >= scrollable - 1) {
    return offsets[offsets.length - 1].id;
  }
  let current = offsets[0].id;
  for (const o of offsets) {
    if (o.top <= CURRENT_SECTION_SLACK_PX) current = o.id;
  }
  return current;
}

/**
 * The scheme the rest of the app addresses a settings section by. Kept as a
 * string form rather than a bare id so a jump target can be stored, logged
 * and passed through code that knows nothing about settings.
 */
export const SETTINGS_JUMP_PREFIX = "settings:";

/** `settings:appearance` for `appearance`. */
export function settingsJumpTarget(id: string): string {
  return `${SETTINGS_JUMP_PREFIX}${id}`;
}

/**
 * Resolve `settings:<id>` (a bare `<id>` is accepted too) to a known
 * section, or null when nothing by that name exists. Unknown targets are
 * refused rather than scrolled somewhere arbitrary.
 */
export function parseSettingsJump(target: string): string | null {
  const id = target.startsWith(SETTINGS_JUMP_PREFIX)
    ? target.slice(SETTINGS_JUMP_PREFIX.length)
    : target;
  return SETTINGS_SECTIONS.some((s) => s.id === id) ? id : null;
}

/**
 * Scroll the settings page to a section.
 *
 * Returns false — never silently succeeds — when the target is unknown or
 * the settings page is not on screen, because "take me to that setting"
 * guidance needs to know it failed so it can open the page first.
 */
export function jumpToSettingsSection(target: string): boolean {
  const id = parseSettingsJump(target);
  if (id === null || typeof document === "undefined") return false;
  const root = document.querySelector(".settings-view");
  // Scoped to the settings page: the ids are short, semantic words, and
  // nothing outside this page is entitled to answer to them.
  const el = root?.querySelector(`[id="${id}"]`) ?? null;
  if (!(el instanceof HTMLElement)) return false;
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "start", behavior: scrollBehavior() });
  }
  return true;
}

/**
 * Smooth travel, unless the OS was asked for less motion — in which case
 * the jump is instant. Not a nicety: a smooth scroll requested under
 * reduced motion was measured in the browser demo to move the page not at
 * all, so the preference has to be read here rather than left to the engine.
 */
function scrollBehavior(): ScrollBehavior {
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduced ? "auto" : "smooth";
}
