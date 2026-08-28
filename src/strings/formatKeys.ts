import { IS_MAC } from "../platform";

/** Modifier glyph → non-mac name, in the order they prefix a chord. */
const MODIFIERS: Record<string, string> = {
  "⌘": "Ctrl",
  "⇧": "Shift",
  "⌥": "Alt",
  "⌃": "Ctrl",
};

/** Named keys whose glyph (or lowercase name) gets a word off the Mac. */
const KEY_NAMES: Record<string, string> = {
  "↑": "Up",
  "↓": "Down",
  "←": "Left",
  "→": "Right",
  "⏎": "Enter",
  esc: "Esc",
  tab: "Tab",
};

/** True for a glyph that names a key on its own (arrows, return). */
const NAMED_GLYPH = /[↑↓←→⏎]/;

/**
 * Key phrases hint chips need that are not single commands in shortcuts.ts:
 * bare navigation keys, the paired arrows, and the zoom trio compressed to
 * one chip. Written in the mac glyph form like shortcuts.ts and shown
 * through formatKeys like every real chord. Also the home of the bare
 * arrow glyphs a few pictographic buttons use as their visible label.
 */
export const HINT_KEYS = {
  enter: "⏎",
  escape: "esc",
  up: "↑",
  down: "↓",
  upDown: "↑↓",
  shiftEnter: "⇧⏎",
  rightOrTab: "→ / tab",
  /** The switcher's composition-proof pair — two chords, one chip. */
  cmdUpDown: "⌘↑⌘↓",
  /** ⌘= / ⌘- / ⌘0 compressed to one zoom chip. */
  zoom: "⌘±0",
  /** The file tree's clipboard chords — edit conventions, not commands
   * in shortcuts.ts, shown as menu badges. */
  copy: "⌘C",
  cut: "⌘X",
  paste: "⌘V",
  copyPath: "⌥⌘C",
} as const;

/**
 * Format a chord (or " / " compound of chords) for display.
 *
 * mac: returned untouched — ⌘⇧P stays ⌘⇧P.
 * other: modifier glyphs map (⌘→Ctrl, ⇧→Shift, ⌥→Alt, ⌃→Ctrl) and join
 * with "+"; named keys map to words (↑→Up, ⏎→Enter, esc→Esc); letters,
 * digits and punctuation pass through, so ⌘1…9 keeps its range shape.
 * A compound like "⌘↑ / ⌘↓" formats each side and keeps the separator.
 */
export function formatKeys(
  keys: string,
  platform: "mac" | "other" = IS_MAC ? "mac" : "other"
): string {
  if (platform === "mac") return keys;
  return keys.split(" / ").map(formatSegment).join(" / ");
}

/**
 * One segment can hold several chords run together ("⌘↑⌘↓", "↑↓"): each
 * modifier glyph starts a fresh chord. Modified chords join with a space
 * ("Ctrl+Up Ctrl+Down"); bare named keys sitting next to each other read
 * as alternatives and join with "/" ("Up/Down").
 */
function formatSegment(segment: string): string {
  // A lowercase key word ("esc", "tab") is one key, not letters to walk.
  const whole = KEY_NAMES[segment];
  if (whole !== undefined) return whole;

  const chords: { mods: string[]; key: string; bareGlyph: boolean }[] = [];
  let i = 0;
  while (i < segment.length) {
    const mods: string[] = [];
    while (i < segment.length && MODIFIERS[segment[i]] !== undefined) {
      mods.push(MODIFIERS[segment[i]]);
      i += 1;
    }
    let key = "";
    let bareGlyph = false;
    if (i < segment.length && NAMED_GLYPH.test(segment[i])) {
      key = KEY_NAMES[segment[i]];
      bareGlyph = mods.length === 0;
      i += 1;
    } else {
      // A plain tail ("P", "1…9", "±0", "Tab", "\\") runs to the next
      // modifier glyph or the end.
      while (
        i < segment.length &&
        MODIFIERS[segment[i]] === undefined &&
        !NAMED_GLYPH.test(segment[i])
      ) {
        key += segment[i];
        i += 1;
      }
    }
    chords.push({ mods, key, bareGlyph });
  }

  let out = "";
  for (let c = 0; c < chords.length; c += 1) {
    const chord = chords[c];
    if (c > 0) {
      out +=
        chord.bareGlyph && chords[c - 1].bareGlyph ? "/" : " ";
    }
    out += [...chord.mods, ...(chord.key ? [chord.key] : [])].join("+");
  }
  return out;
}
