import { useEffect } from "react";
import { runAppCommand, type AppCommand } from "./appCommands";
import { isCmdArrow, isIMEComposing } from "./localKeys";
import { isCommandModifier } from "./platform";
import {
  chordId,
  claimChord,
  eventChord,
  keyBindings,
  parseChord,
  parseRange,
  type Bindings,
  type Chord,
  type Shortcut,
} from "./shortcuts";
import { useStore } from "./state/store";


/**
 * Which of the composition's entries this handler is willing to answer.
 *
 * Exported for the same reason [`buildHandlerIndex`] is: a test asking
 * whether this index and `byChord` agree has to know which rows this one
 * even has an opinion about, and a test that restated the filter would go on
 * passing when the filter moved.
 */
export function handlerRows(b: Bindings): Shortcut[] {
  return b.list.filter(
    // Local rows belong to a view's own handler; find is dispatched below
    // rather than from the index, because where the user is looking decides.
    (s) => !s.local && s.keys !== undefined && s.command !== "find"
  );
}

/**
 * Chord → command, for everything the index answers plainly.
 *
 * Exported because it is what "the handler answers this" means now: tests
 * and the settings screen ask this rather than reading a map that would have
 * to be kept in step with one.
 */
export function buildHandlerIndex(b: Bindings): Map<string, AppCommand> {
  const out = new Map<string, AppCommand>();
  const written: { chord: Chord; command: AppCommand }[] = [];

  // Pass one: the chords the table actually writes down. Two rows on one
  // chord are settled by `claimChord` — the same call `resolveBindings`
  // makes for `byChord`, so "what runs" and "what holds this key" are one
  // answer and not two that happen to agree.
  for (const s of handlerRows(b)) {
    const chord = parseChord(s.keys as string);
    if (chord === null) continue;
    const command = s.command as AppCommand;
    written.push({ chord, command });
    claimChord(out, chordId(chord), command);
  }

  // Pass two, and it is a second pass rather than part of the first because
  // an alias is a FALLBACK: a US keyboard types "+" as shift+"=", so a
  // binding on either is one physical key arriving under two names and two
  // shift states — but a row that names ⌘⇧+ outright must keep it against
  // the ⌘= row's shadow of the same chord, whichever comes first. Done
  // inline, the winner depended on table order and `byChord` disagreed.
  for (const { chord, command } of written) {
    for (const alias of physicalAliases(chord)) {
      claimChord(out, alias, command);
    }
  }
  return out;
}

const PLUS_KEYS = ["=", "+"];

function physicalAliases(chord: Chord): string[] {
  if (!PLUS_KEYS.includes(chord.key)) return [];
  const out: string[] = [];
  for (const key of PLUS_KEYS) {
    for (const shift of [false, true]) {
      out.push(chordId({ ...chord, key, shift }));
    }
  }
  return out;
}

/**
 * The index and the three special shapes, derived once per composition.
 *
 * Memoised on the composition's identity rather than recomputed per keydown:
 * this handler sees every keystroke in the window, including every character
 * typed into a terminal, and parsing three chords on each of them would be a
 * cost paid forever for a table that changes about once a year. A rebinding
 * replaces the composition object, which is what invalidates this.
 */
interface Derived {
  index: Map<string, AppCommand>;
  /** One key, two commands: shift picks which. */
  cycle: Chord | null;
  /** Dispatched by where the user is looking, so not in the index. */
  find: Chord | null;
  /** One row, nine keys. */
  jump: { chord: Chord; from: string; to: string } | null;
}

let derivedFrom: Bindings | null = null;
let derived: Derived = { index: new Map(), cycle: null, find: null, jump: null };

function handlerState(): Derived {
  const b = keyBindings();
  if (derivedFrom !== b) {
    const jumpKeys = b.byCommand.get("jump-n");
    derived = {
      index: buildHandlerIndex(b),
      cycle: chordFor(b, "cycle-tabs"),
      find: chordFor(b, "find"),
      jump: jumpKeys === undefined ? null : parseRange(jumpKeys),
    };
    derivedFrom = b;
  }
  return derived;
}

export function useGlobalKeys() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isIMEComposing(e) && !isCmdArrow(e)) return;
      const st = useStore.getState();
      const { index, cycle, find, jump } = handlerState();

      if (e.key === "Escape" && st.peekTabId !== null) {
        e.preventDefault();
        st.discardPeek();
        return;
      }
      if (e.key === "Escape" && st.selectedTabIds.length > 0) {
        st.clearSelection();
        return;
      }
      // One key, two commands: shift decides direction, so shift is the one
      // modifier this match ignores. The key is the cycle-tabs row's,
      // whatever the user has moved it to.
      if (
        cycle !== null &&
        (!cycle.ctrl || e.ctrlKey) &&
        (!cycle.alt || e.altKey) &&
        e.key.toLowerCase() === cycle.key
      ) {
        e.preventDefault();
        runAppCommand(e.shiftKey ? "prev-tab" : "next-tab");
        return;
      }
      if (!isCommandModifier(e) || e.altKey) return;
      const pressed = eventChord(e, true);

      const cmd = index.get(chordId(pressed));
      if (cmd) {
        e.preventDefault();
        e.stopPropagation();
        runAppCommand(cmd);
        return;
      }
      // Find belongs to whoever owns search where the user is looking: the
      // terminal and the code editor each run their own, so only a browser
      // tab routes it to the shared find command. The key is the table's.
      if (find !== null && chordId(find) === chordId(pressed)) {
        const active = st.tabs.find((t) => t.id === st.activeTabId);
        if (active?.type === "browser") {
          e.preventDefault();
          e.stopPropagation();
          runAppCommand("find");
        }
        return;
      }
      // Nine keys from one row. The ends come from the row (`⌘1…9` today),
      // so a narrower or wider range is a change to the table, not to this.
      if (jump !== null && modifiersMatch(e, jump.chord) && inRange(e.key, jump)) {
        e.preventDefault();
        runAppCommand(`jump-${e.key}` as AppCommand);
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}

/** The chord one command answers on, or null when nothing answers for it. */
function chordFor(b: Bindings, command: string): Chord | null {
  const keys = b.byCommand.get(command);
  return keys === undefined ? null : parseChord(keys);
}

function inRange(key: string, range: { from: string; to: string }): boolean {
  return key.length === 1 && key >= range.from && key <= range.to;
}

/**
 * Whether an event carries this chord's modifiers. Asked of a range, whose
 * key is nine keys and is judged separately.
 */
function modifiersMatch(e: KeyboardEvent, chord: Chord): boolean {
  if (e.shiftKey !== chord.shift || e.altKey !== chord.alt) return false;
  return !chord.ctrl || e.ctrlKey;
}
