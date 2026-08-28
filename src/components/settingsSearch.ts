import { STR } from "../strings";
import type { Setting } from "../state/config";
import { formatKeys } from "../strings/formatKeys";
import { occupiedChords, type Shortcut } from "../shortcuts";
import { KEYBOARD_SECTION_ID, SETTINGS_SECTIONS } from "./settingsSections";


// ------------------------------------------------------------- STR lookup

/**
 * The string at a dotted path in the strings table — `settings.appearance
 * .theme` for `STR.settings.appearance.theme`.
 *
 * Null rather than a thrown error or an empty string when the path leads
 * nowhere or lands on something that is not a string: a registry row whose
 * `str_key` has gone stale is a defect to see, not a row to silently index
 * under no words at all. Callers keep the key itself in the haystack, so
 * such a row is still findable while it is being fixed.
 */
export function strAt(path: string): string | null {
  let node: unknown = STR;
  for (const step of path.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[step];
  }
  return typeof node === "string" ? node : null;
}

/**
 * Every string leaf under a strings-table node, flattened.
 *
 * Parameterized leaves are arrow functions and are skipped: calling one
 * needs arguments this has no business inventing, and the words around the
 * slot are not worth a fabricated `{count: 0}` sentence. So a section is
 * searchable by its plain prose, which is nearly all of it.
 */
export function stringLeaves(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (typeof node !== "object" || node === null) return [];
  const out: string[] = [];
  for (const value of Object.values(node as Record<string, unknown>)) {
    out.push(...stringLeaves(value));
  }
  return out;
}

// ----------------------------------------------------------------- index

/** One searchable setting: the registry row plus the words it is found by. */
export interface SettingEntry {
  /** The dotted config key, e.g. `browser.archive_after`. */
  key: string;
  /** Settings-page section id the row lives in. */
  section: string;
  /** The setting's short title, or null when its `str_key` leads nowhere. */
  title: string | null;
  /** Lowercased haystack: the title and the key itself. */
  text: string;
}

/**
 * The settings index, one entry per registry row.
 *
 * Takes the schema rather than reading it: the rows arrive over a command,
 * and a module that fetched them would make this untestable and would have
 * to decide what to do before they land. An empty schema — the browser
 * demo, where there is no core to ask — yields an empty settings index, and
 * search then runs on the section index alone rather than going dead.
 */
export function buildSettingsIndex(
  schema: readonly Setting[]
): SettingEntry[] {
  return schema.map((row) => {
    const title = strAt(row.str_key);
    return {
      key: row.key,
      section: row.section,
      title,
      // The key is in the haystack so that a key copied out of the
      // configuration file finds its row, which is the one search term a
      // user is certain to have in front of them.
      text: [title ?? "", row.key].join(" ").toLowerCase(),
    };
  });
}

// ------------------------------------------------------- shortcut index

/** One searchable shortcut: a composed table row plus the words it is found by. */
export interface ShortcutEntry {
  /** The command id — `duplicate-tab`. */
  command: string;
  /** The section its row is rendered in, so a match keeps that section. */
  section: string;
  /** The key as resolved, or null when the command answers none. */
  keys: string | null;
  /**
   * Every chord the row occupies, as ids: one for an ordinary row, nine for
   * `⌘1…9`, both halves of a pair. This is what makes pressing ⌘5 find the
   * tab-jump row — a lookup against the displayed string would not.
   */
  chords: string[];
  /** Lowercased haystack: label, command id, and the key in both spellings. */
  text: string;
}

/**
 * The shortcut index, one entry per row of the composition.
 *
 * Takes the composed rows rather than reading them, for the same reason
 * [`buildSettingsIndex`] takes the schema: the composition changes under the
 * user's overlay, and an index that fetched its own copy would answer for
 * the shipped table while the page displayed something else. One entry per
 * row, including the rows that answer no key — a command is searchable by
 * name whether or not it has a shortcut, and `print` with no key is exactly
 * the row somebody is looking for when they search for printing.
 *
 * The haystack carries the key in BOTH spellings — `⌘⇧D` and `Ctrl+Shift+D`
 * — because which one a user has in front of them depends on the platform
 * they are typing into, and neither is a second source: both are computed
 * from the row's own resolved key.
 */
export function buildShortcutIndex(
  rows: readonly Shortcut[],
  section: string = KEYBOARD_SECTION_ID
): ShortcutEntry[] {
  return rows.map((row) => {
    const keys = row.keys ?? null;
    return {
      command: String(row.command),
      section,
      keys,
      chords: keys === null ? [] : occupiedChords(keys),
      text: [
        row.label,
        String(row.command),
        keys ?? "",
        keys === null ? "" : formatKeys(keys, "mac"),
        keys === null ? "" : formatKeys(keys, "other"),
      ]
        .join(" ")
        .toLowerCase(),
    };
  });
}

/**
 * The shortcuts a chord runs into — the "what is on this key" lookup.
 *
 * A list and not one answer: a key can be claimed by a view's own row and by
 * an app-wide one at the same time, and a lookup that reported the first
 * would teach the user a half-truth about the very key they asked about.
 */
export function shortcutsAt(
  chord: string,
  index: readonly ShortcutEntry[]
): ShortcutEntry[] {
  return index.filter((e) => e.chords.includes(chord));
}

/** One searchable section: the page's own section list plus its copy. */
export interface SectionEntry {
  id: string;
  /** Lowercased haystack: every string leaf of the section's STR subtree. */
  text: string;
}

/**
 * The section index, one entry per section the page renders.
 *
 * Derived from the same list the anchors and the rail are built from, so a
 * section cannot exist on the page and be missing from search. Its words
 * include the settings' short titles for free — those leaves live in the
 * section's own subtree — which is why a section with no registry settings
 * of its own (ten of the thirteen, this milestone) is still findable.
 */
export const SECTION_INDEX: readonly SectionEntry[] = SETTINGS_SECTIONS.map(
  (s) => ({ id: s.id, text: stringLeaves(s.str).join(" ").toLowerCase() })
);

// ---------------------------------------------------------------- search

/** What the page should show for the query in the box. */
export interface SettingsMatch {
  /** The query as typed, for the empty-state sentence. */
  query: string;
  /** Section ids to keep on screen, in the page's own order. */
  sections: string[];
  /** Keys of the settings that matched — the rows to highlight. */
  keys: string[];
  /**
   * Commands of the shortcuts that matched — the rows the Keyboard section
   * thins down to. Separate from `keys` because they are addressed
   * differently: a setting is a dotted configuration key, a shortcut is a
   * command id, and one list holding both would have to be told apart again
   * at every reader.
   */
  commands: string[];
  /** Searched, and nothing on the page answers. */
  empty: boolean;
}

/**
 * Split a query into the terms every match must contain.
 *
 * Terms are ANDed and order does not matter, so "width sidebar" finds the
 * same row as "sidebar width" — people type the noun they remember first.
 */
function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

function matchesAll(text: string, want: readonly string[]): boolean {
  return want.every((t) => text.includes(t));
}

/**
 * Which sections stay and which rows light up.
 *
 * Null — not an all-matching result — when the box is empty: "no filter" and
 * "everything happens to match" are different states, and only the first
 * one means the page should render exactly as it does when nobody has
 * searched.
 *
 * A section is kept when its own words match or when one of its settings
 * does; a setting is highlighted only when the setting itself matches, so a
 * row never lights up because the paragraph above it mentioned the word.
 */
export function searchSettings(
  query: string,
  index: readonly SettingEntry[],
  sections: readonly SectionEntry[] = SECTION_INDEX,
  shortcuts: readonly ShortcutEntry[] = []
): SettingsMatch | null {
  const want = terms(query);
  if (want.length === 0) return null;

  const keys: string[] = [];
  const fromSettings = new Set<string>();
  for (const entry of index) {
    if (!matchesAll(entry.text, want)) continue;
    keys.push(entry.key);
    fromSettings.add(entry.section);
  }

  const commands: string[] = [];
  for (const entry of shortcuts) {
    if (!matchesAll(entry.text, want)) continue;
    commands.push(entry.command);
    fromSettings.add(entry.section);
  }

  // Page order, taken from the section list rather than from match order:
  // the page is not reordered by a search, it is thinned.
  const visible = sections
    .filter((s) => fromSettings.has(s.id) || matchesAll(s.text, want))
    .map((s) => s.id);

  return {
    query,
    sections: visible,
    keys,
    commands,
    empty: visible.length === 0,
  };
}
