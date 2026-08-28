import { useSyncExternalStore } from "react";
import type { AppCommand } from "./appCommands";
import { IS_MAC, isCommandModifier } from "./platform";
import defaultTable from "./shortcuts.json";
import reservedTable from "./reservedKeys.json";

export interface Shortcut {
  /** The command this runs, or a bare name for one no global map owns. */
  command: AppCommand | LocalCommand;
  keys?: string;
  label: string;
  /**
   * Handled inside one view rather than by the app-wide map — the editor's
   * save, the terminal's find, the file tab's quick open. Not in the global
   * handler and not in the menu; still in this table, and still in the
   * composition, because a user rebinding a global key onto ⌘S needs to be
   * told what ⌘S already is.
   */
  local?: true;
  /**
   * Why this entry is the way it is, where that needed saying. It rides in
   * the data file because the data file is where the entry lives now; a
   * comment left behind in TypeScript would be a note about a line that
   * moved.
   */
  note?: string;
}

/** Shortcuts owned by a single view, so not part of `AppCommand`. */
export type LocalCommand =
  | "quick-open"
  | "save-file"
  | "terminal-panel"
  | "jump-n"
  | "cycle-tabs"
  | "command-blocks"
  | "scroll-end"
  | "toggle-broadcast"
  | "undo"
  | "redo";

/**
 * The defaults, exactly as `shortcuts.json` spells them — no overlay applied.
 *
 * Read this when you mean "what does this app ship with"; read
 * [`keyBindings`] when you mean "what does this app answer right now". The
 * settings page's changed-only view is the difference between the two.
 */
export const SHORTCUTS: readonly Shortcut[] = defaultTable as readonly Shortcut[];

// ------------------------------------------------------------------ chords

/** One key combination, as a keydown event presents it. */
export interface Chord {
  /** ⌘ on a Mac, Ctrl elsewhere — `isCommandModifier` decides which. */
  cmd: boolean;
  shift: boolean;
  /** ⌃ specifically, which on a Mac is NOT the command modifier. */
  ctrl: boolean;
  alt: boolean;
  /** Lower-cased: a single character, or a name like `tab`. */
  key: string;
}

const MODIFIER_GLYPHS: Record<string, keyof Omit<Chord, "key">> = {
  "⌘": "cmd",
  "⇧": "shift",
  "⌃": "ctrl",
  "⌥": "alt",
};

/** The glyph that marks a range of keys rather than one — `⌘1…9`. */
const RANGE = "…";

/** The separator between two chords written as one entry — `⌘↑ / ⌘↓`. */
const COMPOUND = " / ";

/**
 * One chord from its displayed form, or null when the entry is not one
 * chord: a range (`⌘1…9`) or a compound (`⌘↑ / ⌘↓`). Both of those are
 * shapes the handler treats specially, and both say so by returning null
 * here rather than by being recognised from their text somewhere else.
 */
export function parseChord(keys: string): Chord | null {
  if (keys.includes(COMPOUND) || keys.includes(RANGE)) return null;
  const { chord, rest } = takeModifiers(keys);
  chord.key = rest.toLowerCase();
  return chord.key === "" ? null : chord;
}

/** The leading modifier glyphs as flags, and whatever follows them. */
function takeModifiers(keys: string): { chord: Chord; rest: string } {
  const chord: Chord = { cmd: false, shift: false, ctrl: false, alt: false, key: "" };
  let i = 0;
  while (i < keys.length) {
    const flag = MODIFIER_GLYPHS[keys[i]];
    if (flag === undefined) break;
    chord[flag] = true;
    i += 1;
  }
  return { chord, rest: keys.slice(i) };
}

/**
 * A range entry's ends — `⌘1…9` yields the modifiers plus "1" and "9".
 *
 * The handler answers nine keys from one row, and the injected script does
 * the same over in Rust. Both ask what the ends are rather than knowing:
 * that is what makes `⌘1…9` a binding and not a phrase.
 */
export function parseRange(keys: string): { chord: Chord; from: string; to: string } | null {
  const at = keys.indexOf(RANGE);
  if (at < 1) return null;
  const { chord, rest } = takeModifiers(keys.slice(0, at));
  const from = rest;
  const to = keys.slice(at + RANGE.length);
  if (from.length !== 1 || to.length !== 1) return null;
  return { chord, from, to };
}

/**
 * A chord as a map key. Modifiers in a fixed order, so two spellings of one
 * combination cannot become two entries.
 */
export function chordId(chord: Chord): string {
  return (
    `${chord.cmd ? "⌘" : ""}${chord.ctrl ? "⌃" : ""}` +
    `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.key}`
  );
}

/**
 * A keydown as the chord helpers read one: the five fields and nothing else.
 *
 * Named so that a caller can build one — a view asking "is this find, with
 * ⌥ standing for replace?" has to compare the same event with the alt flag
 * off, and a `KeyboardEvent` keeps its fields on the prototype where a
 * spread cannot reach them.
 */
export interface KeyEventLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** The chord a keydown event carries, in the same shape [`parseChord`] answers. */
export function eventChord(e: KeyEventLike, cmd: boolean): Chord {
  return {
    cmd,
    shift: e.shiftKey,
    // On a Mac the command modifier is ⌘ and ⌃ is its own thing; elsewhere
    // Ctrl IS the command modifier, and reporting it twice would make every
    // ⌘-chord look like a ⌃-chord as well.
    ctrl: e.ctrlKey && !cmd,
    alt: e.altKey,
    key: normalizeKey(e.key),
  };
}

/**
 * The chord an event carries, as the id every index here is keyed by.
 *
 * The one form in which "what was pressed" and "what is bound" can be
 * compared: both sides go through [`chordId`], so a comparison cannot be
 * written that reads the event's own spelling — which is what
 * `e.key.toLowerCase() === "s"` was.
 */
export function eventChordId(
  e: KeyEventLike,
  cmd: boolean = isCommandModifier(e)
): string {
  return chordId(eventChord(e, cmd));
}

// ------------------------------------------------------------- recording

/**
 * What a keyboard event calls a key, translated into what the table calls
 * it — the arrow glyphs, the return glyph, the short word for escape.
 *
 * One key with two spellings is the disease this whole module treats, and a
 * recorder is where a second spelling would enter: the table says `⌘↑` and
 * the event says `ArrowUp`, so without this a recorded arrow would be
 * written into the configuration file as `⌘arrowup` — a string this file's
 * own parser can read back but no human would type and the shipped table
 * never uses. Applied inside [`eventChord`], so the handler compares the
 * same spelling it was given.
 */
const EVENT_KEY_NAMES: Record<string, string> = {
  " ": "space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "⏎",
  return: "⏎",
  escape: "esc",
};

/** A key name as the table spells it, lower-cased for comparison. */
export function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  return EVENT_KEY_NAMES[lower] ?? lower;
}

/** Keys that are only a modifier: a chord cannot be one of these alone. */
const BARE_MODIFIERS = new Set([
  "meta",
  "shift",
  "control",
  "alt",
  "altgraph",
  "capslock",
  "os",
  "dead",
  "unidentified",
]);

/** How a multi-letter key name is written for a human — `esc` → `Esc`. */
function displayKey(key: string): string {
  if (key.length <= 1) return key.toUpperCase();
  return key[0].toUpperCase() + key.slice(1);
}

/**
 * A chord written the way the table writes one — `⌘⇧D`, `⌃Tab`, `⌘↑`.
 *
 * The inverse of [`parseChord`], and the form that goes into the `[keys]`
 * section of the configuration file: a recorded key has to come back out of
 * that file looking like the lines around it, or the file the user opens to
 * check their own shortcuts holds two dialects.
 */
export function chordKeys(chord: Chord): string {
  return (
    `${chord.cmd ? "⌘" : ""}${chord.ctrl ? "⌃" : ""}` +
    `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${displayKey(chord.key)}`
  );
}

/**
 * The chord a person just pressed, or null when they pressed nothing yet —
 * a bare ⌘ or ⇧ is the first half of a chord, not a chord.
 *
 * Which modifier counts as the command one defaults to the platform's
 * answer, so that no caller has to know: deciding it twice is how a recorded
 * key comes to mean one thing on a Mac and another on Windows. It is an
 * argument all the same, because a test that cannot say which platform it is
 * pretending to be can only assert what the machine it runs on happens to
 * do.
 */
export function recordChord(
  e: KeyEventLike,
  cmd: boolean = isCommandModifier(e)
): { chord: Chord; keys: string } | null {
  if (BARE_MODIFIERS.has(e.key.toLowerCase())) return null;
  const chord = eventChord(e, cmd);
  if (chord.key === "") return null;
  return { chord, keys: chordKeys(chord) };
}

// ------------------------------------------------------------- composition

/** Two commands that resolved to the same chord. */
export interface KeyConflict {
  keys: string;
  commands: string[];
}

/** The defaults with the user's overlay laid on, and the two indexes over it. */
export interface Bindings {
  /** The whole table with resolved keys, in the file's order. */
  list: readonly Shortcut[];
  /** Command → the key it answers, absent when nothing answers for it. */
  byCommand: ReadonlyMap<string, string>;
  /**
   * Chord → the shortcut it runs. Local entries are in here: "what is ⌘S
   * already?" is a question the answer to which must include the editor's
   * save, or a rebinding screen would call an occupied key free.
   *
   * WHEN TWO ROWS CLAIM ONE CHORD the EARLIER ROW WINS — see
   * [`FIRST_CLAIM_WINS`], which is the rule and not merely this map's habit.
   */
  byChord: ReadonlyMap<string, Shortcut>;
  /** Chords two commands both claim, after the overlay. */
  conflicts: readonly KeyConflict[];
  /** Overlay keys naming no command in the table — reported, never applied. */
  unknown: readonly string[];
}

/**
 * WHO HOLDS A CHORD TWO ROWS BOTH CLAIM: the row that comes FIRST.
 *
 * A function rather than a sentence in a comment, because the rule has to be
 * OBEYED in two files and a sentence is obeyed by nobody. [`byChord`] here
 * and `keys.ts`'s handler index used to disagree — this map kept the first
 * claim, the handler's bare `set` kept the last — and nothing reported it
 * because only tests read this map. The moment a screen uses it to answer
 * "what holds ⌘S?", the disagreement becomes an interface naming one command
 * while a different one runs.
 *
 * Nothing in the shipped table collides and `inspectBinding` refuses to save
 * a collision, so this decides only what a HAND-EDITED `config.toml` can
 * produce. First-come is the choice because:
 *
 *   * [`Bindings.conflicts`] already lists claimants in table order, so
 *     `commands[0]` is the winner with no second rule to state;
 *   * `keys.ts`'s keyboard-alias fallback was already first-come, so the
 *     handler disagreed with itself as well as with this map;
 *   * appending a row to `shortcuts.json` must not quietly take a key off a
 *     row that has shipped for years, which is what last-come does.
 */
export function claimChord<T>(index: Map<string, T>, id: string, holder: T): void {
  if (!index.has(id)) index.set(id, holder);
}

export function resolveBindings(
  defaults: readonly Shortcut[],
  overrides: Readonly<Record<string, string>>
): Bindings {
  const known = new Set(defaults.map((s) => String(s.command)));
  const unknown = Object.keys(overrides).filter((k) => !known.has(k));

  const list: Shortcut[] = defaults.map((s) => {
    const override = overrides[String(s.command)];
    if (override === undefined) return { ...s };
    const next: Shortcut = { ...s };
    if (override === "") delete next.keys;
    else next.keys = override;
    return next;
  });

  const byCommand = new Map<string, string>();
  const byChord = new Map<string, Shortcut>();
  const claims = new Map<string, { keys: string; commands: string[] }>();
  for (const s of list) {
    if (s.keys === undefined) continue;
    byCommand.set(String(s.command), s.keys);
    for (const id of occupiedChords(s.keys)) {
      const claim = claims.get(id);
      if (claim === undefined) {
        claims.set(id, { keys: s.keys, commands: [String(s.command)] });
      } else {
        claim.commands.push(String(s.command));
      }
      // Both indexes go through the same rule, so `commands[0]` above and
      // the holder here can never name different rows.
      claimChord(byChord, id, s);
    }
  }
  const conflicts = [...claims.values()]
    .filter((c) => c.commands.length > 1)
    .map((c) => ({ keys: c.keys, commands: c.commands }));

  return { list, byCommand, byChord, conflicts, unknown };
}

/**
 * Every chord one entry occupies. One for the ordinary rows; nine for a
 * range; both halves of a compound. Occupancy is what conflict detection
 * asks about, so `⌘1…9` has to answer with nine keys and not with one.
 */
export function occupiedChords(keys: string): string[] {
  const out: string[] = [];
  for (const part of keys.split(COMPOUND)) {
    const single = parseChord(part);
    if (single !== null) {
      out.push(chordId(single));
      continue;
    }
    const range = parseRange(part);
    if (range === null) continue;
    const from = range.from.charCodeAt(0);
    const to = range.to.charCodeAt(0);
    for (let c = from; c <= to; c += 1) {
      out.push(chordId({ ...range.chord, key: String.fromCharCode(c) }));
    }
  }
  return out;
}

// ---------------------------------------------------- conflict detection


/** Which spelling of the reserved list applies here. */
export type KeyPlatform = "mac" | "other";

/** What holds a key this app's shortcut table does not. */
export type ReservedOwner = "app" | "system";

/**
 * One key some other machinery already answers.
 *
 * Data, in `reservedKeys.json`, for the same two reasons the shortcut table
 * is: the other language may come to need it, and — the sharper reason —
 * the shortcut tests reject a key combination written into this file,
 * because a key written here is indistinguishable from the hand-kept copies
 * that gate exists to end. A list of keys belongs in a list of keys.
 */
export interface ReservedKey {
  /** As a human reads it, in the same glyph form the shortcut table uses. */
  keys: string;
  /** Dotted path into the strings table naming what holds this key. */
  str: string;
  owner: ReservedOwner;
  /** `all` for the keys every platform takes — copy, paste, undo. */
  where: KeyPlatform | "all";
}

export const RESERVED_KEYS: readonly ReservedKey[] =
  reservedTable as readonly ReservedKey[];

/** The reserved keys that apply on one platform. */
export function reservedKeysFor(platform: KeyPlatform): readonly ReservedKey[] {
  return RESERVED_KEYS.filter((r) => r.where === "all" || r.where === platform);
}

/** A table row that already answers a key somebody is recording. */
export interface ChordClaim {
  command: string;
  /** The row's own label, so the interface can name it without a lookup. */
  label: string;
  /**
   * A view answers this one itself. Both would then run: the view's listener
   * and the app-wide handler are siblings on the window, and neither can
   * cancel the other (see this section's opening comment).
   */
  local: boolean;
  /** The chords the two entries share, as ids — `⌘5` for a hit on `⌘1…9`. */
  chords: string[];
}

/** A reserved key a recording would sit under. */
export interface ReservedClaim extends ReservedKey {
  /** The chords shared with the recorded key, as ids. */
  chords: string[];
}

/** What a recorded key would collide with, said one kind at a time. */
export interface BindingVerdict {
  /** The candidate, as the table would spell it. */
  keys: string;
  /** Every chord it occupies: one, or nine for a range, or two for a pair. */
  chords: string[];
  /** Table rows already answering one of them, never the row being rebound. */
  taken: ChordClaim[];
  /** Keys other machinery holds. A warning; `blocked` ignores these. */
  reserved: readonly ReservedClaim[];
  /** The candidate is not a key at all — nothing to judge. */
  unreadable: boolean;
  /** Nothing in the way, warnings included. */
  free: boolean;
  /** Something in this table already answers it, so it must not be saved. */
  blocked: boolean;
}

/**
 * The reserved keys a candidate runs into — the warning half of a verdict,
 * and on its own the answer to "what is this key, then?" when the shortcut
 * table has nothing on it.
 */
export function reservedAt(
  keys: string,
  platform: KeyPlatform = IS_MAC ? "mac" : "other"
): ReservedClaim[] {
  const wanted = new Set(occupiedChords(keys));
  const out: ReservedClaim[] = [];
  for (const r of reservedKeysFor(platform)) {
    const shared = occupiedChords(r.keys).filter((id) => wanted.has(id));
    if (shared.length > 0) out.push({ ...r, chords: shared });
  }
  return out;
}

/**
 * What stands in the way of putting `command` on `keys`.
 *
 * A pure function of the composition it is handed, like `resolveBindings`
 * itself, so the interface's verdict can be exercised without an interface —
 * and so the same judgement can be asked of a composition that is not the
 * one in force, which is what a recording is until it is saved.
 *
 * The command being rebound never conflicts with itself: re-recording the
 * key a command already has is a no-op, not a collision with its own row.
 */
export function inspectBinding(
  command: string,
  keys: string,
  bindings: Bindings = keyBindings(),
  platform: KeyPlatform = IS_MAC ? "mac" : "other"
): BindingVerdict {
  const chords = occupiedChords(keys);
  const wanted = new Set(chords);

  const taken: ChordClaim[] = [];
  for (const s of bindings.list) {
    if (String(s.command) === String(command)) continue;
    if (s.keys === undefined) continue;
    const shared = occupiedChords(s.keys).filter((id) => wanted.has(id));
    if (shared.length === 0) continue;
    taken.push({
      command: String(s.command),
      label: s.label,
      local: s.local === true,
      chords: shared,
    });
  }

  const reserved = reservedAt(keys, platform);
  const unreadable = chords.length === 0;
  return {
    keys,
    chords,
    taken,
    reserved,
    unreadable,
    free: !unreadable && taken.length === 0 && reserved.length === 0,
    // A key nothing can read is refused for a different reason than a key
    // something else answers, and both refusals are this flag: nothing that
    // cannot be saved is offered as saveable.
    blocked: unreadable || taken.length > 0,
  };
}

// ------------------------------------------------------- the live overlay

/**
 * The overlay as last read from the configuration file, and the composition
 * over it.
 *
 * Held here rather than in the store because `keysFor` is called from
 * twenty-odd places that are not components and cannot subscribe to
 * anything; components that must repaint when a key moves use
 * [`useKeyBindings`], which is this same holder seen through
 * `useSyncExternalStore`. `src/state/config.ts` is what feeds it — at boot
 * from the injected configuration, and again on every `config_get`.
 *
 * It starts as the defaults and not as "not read yet". A missing `[keys]`
 * section is not an unknown: it is an empty overlay, which is a fact the
 * interface can hold without guessing at anything the registry owns.
 */
let overlay: Readonly<Record<string, string>> = {};
let composed: Bindings = resolveBindings(SHORTCUTS, overlay);
const listeners = new Set<() => void>();

/** What the app answers right now: defaults with the user's overlay on top. */
export function keyBindings(): Bindings {
  return composed;
}

/** The overlay itself, for a screen that has to show what the user changed. */
export function keyOverlay(): Readonly<Record<string, string>> {
  return overlay;
}

/**
 * Take a new overlay. Same overlay, same composition object — a repaint per
 * `config_get` would otherwise land on every consumer for nothing.
 */
export function setKeyOverrides(next: Readonly<Record<string, string>>): void {
  if (sameOverlay(overlay, next)) return;
  overlay = { ...next };
  composed = resolveBindings(SHORTCUTS, overlay);
  for (const l of listeners) l();
}

function sameOverlay(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The composition, for a component that has to redraw when a key moves. */
export function useKeyBindings(): Bindings {
  return useSyncExternalStore(subscribe, keyBindings, keyBindings);
}

// ---------------------------------------------------------------- readers

/** The shortcut table with the currently resolved keys. */
export function visibleShortcuts(): readonly Shortcut[] {
  return composed.list;
}

/**
 * [`visibleShortcuts`] for a component, which then repaints when a key
 * moves. Rebinding is therefore visible without a reload.
 */
export function useVisibleShortcuts(): readonly Shortcut[] {
  useKeyBindings();
  return visibleShortcuts();
}

/**
 * How a command is typed, for a sentence that has to name it. Returns the
 * command's own name if it has no shortcut, which reads oddly and is meant
 * to — better than a hint confidently naming a key that does nothing.
 */
export function keysFor(command: AppCommand | LocalCommand): string {
  return composed.byCommand.get(String(command)) ?? String(command);
}

/**
 * The keys for a kbd badge: empty when the command has none, so the badge
 * simply does not render — a sentence needs a name, a badge does not.
 */
export function keysShownFor(command: AppCommand | LocalCommand): string {
  return composed.byCommand.get(String(command)) ?? "";
}

/**
 * Every chord a command answers on right now, as ids, in the entry's own
 * order — one for an ordinary row, two for a compound (`⌘↑ / ⌘↓`), nine for
 * a range, none at all for a command the overlay unbound.
 *
 * Memoised on the composition's identity for the reason `keys.ts` memoises
 * its index: the views that ask this sit on window keydown in the capture
 * phase, so they are asked on the way past every keystroke, and re-parsing a
 * table that changes about once a year is a cost paid forever. Rebinding
 * replaces the composition object, which is what empties this.
 */
let chordsFrom: Bindings | null = null;
let chordsByCommand = new Map<string, readonly string[]>();

export function chordsFor(command: AppCommand | LocalCommand): readonly string[] {
  if (chordsFrom !== composed) {
    chordsFrom = composed;
    chordsByCommand = new Map();
  }
  const name = String(command);
  let ids = chordsByCommand.get(name);
  if (ids === undefined) {
    const keys = composed.byCommand.get(name);
    ids = keys === undefined ? [] : occupiedChords(keys);
    chordsByCommand.set(name, ids);
  }
  return ids;
}

/**
 * WHERE a chord falls among the ones a command answers on: 0 for the only
 * chord of an ordinary row, 0 or 1 for the two halves of a compound, and -1
 * for a chord this command does not answer.
 *
 * The position rather than a yes/no, because a compound row is one binding
 * with two meanings — `⌘↑ / ⌘↓` is previous and next, in that order — and a
 * view that had to tell them apart from the arrow glyphs would be reading
 * the key again, which is the whole disease. Rebind the row to `⌘⇧K / ⌘⇧J`
 * and the first half is still previous.
 */
export function matchBinding(
  command: AppCommand | LocalCommand,
  chord: string
): number {
  return chordsFor(command).indexOf(chord);
}
