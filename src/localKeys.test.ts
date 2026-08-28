import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

/**
 * Pinned to macOS so that ⌘ is the command modifier and ⌃ is not — the
 * terminal's guard is a statement about that platform, and on any other one
 * the two are the same key and the guard would assert nothing.
 */
vi.mock("./platform", async (original) => ({
  ...(await original<typeof import("./platform")>()),
  IS_MAC: true,
  isCommandModifier: (e: { metaKey: boolean }) => e.metaKey,
}));

import filesSource from "./components/files/FilesView.tsx?raw";
import terminalSource from "./components/TerminalView.tsx?raw";
import {
  filesKeyAction,
  onLocalKeys,
  terminalKeyAction,
  type FilesKeyAction,
  type TerminalKeyAction,
} from "./localKeys";
import { SHORTCUTS, occupiedChords, parseChord, setKeyOverrides } from "./shortcuts";


afterEach(() => {
  setKeyOverrides({});
});

/** What a keyboard event calls a key the table spells with a glyph. */
const DOM_KEY_NAMES: Record<string, string> = {
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "←": "ArrowLeft",
  "→": "ArrowRight",
  "⏎": "Enter",
  esc: "Escape",
  space: " ",
};

/** A press of one chord, as the window delivers one. */
function press(keys: string): KeyboardEvent {
  const chord = parseChord(keys);
  if (chord === null) throw new Error(`not one chord: ${keys}`);
  const e = new KeyboardEvent("keydown", {
    key: DOM_KEY_NAMES[chord.key] ?? chord.key,
    // macOS, per the mock above: the command modifier is ⌘ and ⌃ is its own.
    metaKey: chord.cmd,
    ctrlKey: chord.ctrl,
    altKey: chord.alt,
    shiftKey: chord.shift,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(e);
  return e;
}

/**
 * The chords the SHIPPED table gives a command — read out of the data rather
 * than retyped here, so that a default this file believes in is the default
 * the app has. Not the composition: these tests move commands about, and the
 * question they keep asking is what happened to the key that was left behind.
 */
function shipped(command: string): string[] {
  const row = SHORTCUTS.find((s) => String(s.command) === command);
  if (row?.keys === undefined) throw new Error(`no shipped key for ${command}`);
  return occupiedChords(row.keys);
}

/** The explorer's listener, installed exactly as the view installs it. */
function watchFiles(): FilesKeyAction[] {
  const seen: FilesKeyAction[] = [];
  release = onLocalKeys(filesKeyAction, (a) => seen.push(a));
  return seen;
}

/** The terminal's, likewise. */
function watchTerminal(): TerminalKeyAction[] {
  const seen: TerminalKeyAction[] = [];
  release = onLocalKeys(terminalKeyAction, (a) => seen.push(a));
  return seen;
}

let release: (() => void) | null = null;
afterEach(() => {
  release?.();
  release = null;
});

describe("the four commands a view owns really move", () => {
  /**
   * Both halves, in this order, or the check cannot tell the two apart.
   *
   * Found by mutating: a version that pressed the new key and the old one
   * and then looked at the total went on passing when the decider ignored
   * the overlay outright — the old key had produced the very list the new
   * key was supposed to. Asserting BETWEEN the presses is what separates
   * "it moved" from "it never left".
   */
  function moves<A>(seen: A[], command: string, to: string, expected: A[]) {
    setKeyOverrides({ [command]: to });
    // Split by the table's own parser rather than by retyping its separator.
    for (const chord of occupiedChords(to)) press(chord);
    expect(seen, `${command} must answer on ${to}`).toEqual(expected);
    for (const old of shipped(command)) press(old);
    expect(seen, `${command} must have let go of the key it shipped with`)
      .toEqual(expected);
  }

  it("saves on the key the user chose, and no longer on the shipped one", () => {
    moves(watchFiles(), "save-file", "⌘⇧O", [{ command: "save-file" }]);
  });

  it("opens the quick picker on the key the user chose", () => {
    moves(watchFiles(), "quick-open", "⌘⇧Y", [{ command: "quick-open" }]);
  });

  it("toggles the terminal panel on the key the user chose", () => {
    moves(watchFiles(), "terminal-panel", "⌘⇧M", [{ command: "terminal-panel" }]);
  });

  it("steps command blocks on the pair the user chose, in the row's order", () => {
    // Previous then next, because the ROW says previous then next — not
    // because one of them is an up arrow. The chosen pair has no arrows in
    // it at all, which is what makes that difference visible.
    moves(watchTerminal(), "command-blocks", "⌘⇧K / ⌘⇧J", [
      { command: "command-blocks", dir: -1 },
      { command: "command-blocks", dir: 1 },
    ]);
  });

  it("searches on the key the user chose, in the explorer", () => {
    moves(watchFiles(), "find", "⌘⇧N", [{ command: "find", replace: false }]);
  });

  it("searches on the key the user chose, in the terminal", () => {
    moves(watchTerminal(), "find", "⌘⇧N", [{ command: "find" }]);
  });

  it("answers nothing at all once a command is unbound", () => {
    const seen = watchFiles();
    setKeyOverrides({ "save-file": "" });

    for (const old of shipped("save-file")) press(old);

    expect(seen).toEqual([]);
  });
});

describe("what ⌥ means on find", () => {
  it("selects replace rather than naming a different binding", () => {
    const seen = watchFiles();

    for (const only of shipped("find")) {
      press(only);
      press(`⌥${only}`);
    }

    expect(seen).toEqual([
      { command: "find", replace: false },
      { command: "find", replace: true },
    ]);
  });

  it("follows find to wherever the user put it", () => {
    const seen = watchFiles();
    setKeyOverrides({ find: "⌘⇧N" });

    press("⌥⌘⇧N");

    expect(seen).toEqual([{ command: "find", replace: true }]);
  });

  it("is not offered to the other three, which take the chord as pressed", () => {
    const seen = watchFiles();

    for (const only of shipped("save-file")) press(`⌥${only}`);

    // ⌥⌘S is not save-with-something, it is a chord nothing here holds.
    expect(seen).toEqual([]);
  });
});

describe("each view keeps the guard that is not about which key", () => {
  it("leaves Ctrl to the programs inside the terminal, on a Mac", () => {
    const seen = watchTerminal();

    // Ctrl+F is readline's forward-char and Ctrl+↑/↓ belong to whatever TUI
    // is running. The guard is on the shape of the press, so it holds even
    // when the user has pointed find straight at that shape.
    press("⌃F");
    setKeyOverrides({ find: "⌃F" });
    press("⌃F");

    expect(seen).toEqual([]);
  });

  it("leaves a bare key to the editor in the explorer", () => {
    const seen = watchFiles();
    setKeyOverrides({ "save-file": "S" });

    press("S");

    expect(seen).toEqual([]);
  });
});

describe("neither view has a reading of its own", () => {
  it("both dispatch through the composition's decider", () => {
    // The shape `shortcuts.test.ts` uses for the two screens that list every
    // key: rendering is out of this harness, so the check is that no second
    // reading exists to drift; a second literal makes this assertion fail.
    expect(filesSource).toContain("onLocalKeys(filesKeyAction");
    expect(terminalSource).toContain("onLocalKeys(terminalKeyAction");
  });
});

describe("the terminal's pane keys", () => {
  it("splits the pane the two ways the table names", () => {
    const seen = watchTerminal();

    for (const chord of shipped("split-pane-vertical")) press(chord);
    for (const chord of shipped("split-pane-horizontal")) press(chord);

    // ⌘D is iTerm2's "split vertically": a vertical DIVIDER, two panes side
    // by side — which the tree calls a horizontal arrangement, so the flag
    // it carries is false. The pair being opposites is the assertion.
    expect(seen).toEqual([
      { command: "split-pane", vertical: false },
      { command: "split-pane", vertical: true },
    ]);
  });

  it("reads the direction off the quarter that matched, not off the arrow", () => {
    const seen = watchTerminal();

    for (const chord of shipped("focus-pane-dir")) press(chord);

    expect(seen).toEqual([
      { command: "focus-pane", dir: "left" },
      { command: "focus-pane", dir: "right" },
      { command: "focus-pane", dir: "up" },
      { command: "focus-pane", dir: "down" },
    ]);
  });

  it("keeps the order when the row is rebound onto keys with no arrows", () => {
    // The half of "derived" that a passing forward test never shows: press
    // four chords that are not arrows at all and the same four directions
    // have to come back, in the row's own order.
    const seen = watchTerminal();
    setKeyOverrides({ "focus-pane-dir": "⌘⇧H / ⌘⇧L / ⌘⇧K / ⌘⇧J" });

    press("⌘⇧H");
    press("⌘⇧L");
    press("⌘⇧K");
    press("⌘⇧J");
    expect(seen).toEqual([
      { command: "focus-pane", dir: "left" },
      { command: "focus-pane", dir: "right" },
      { command: "focus-pane", dir: "up" },
      { command: "focus-pane", dir: "down" },
    ]);

    // And the shipped arrows answer nothing now, which is the half a "the
    // new keys work" check passes without ever noticing.
    for (const old of shipped("focus-pane-dir")) press(old);
    expect(seen).toHaveLength(4);
  });

  it("zooms on its own chord", () => {
    const seen = watchTerminal();
    for (const chord of shipped("zoom-pane")) press(chord);
    expect(seen).toEqual([{ command: "zoom-pane" }]);
  });

  /**
   * ⌃⌘ ARROWS, WHICH THE SHARED CHORD READER CANNOT SPELL.
   *
   * `eventChord` drops ⌃ whenever the command modifier is present — right
   * where Ctrl IS that modifier, wrong on a Mac, where ⌃ and ⌘ are two
   * keys. Read through it, ⌃⌘↑ comes out as ⌘↑ — which is not a miss but a
   * WRONG ANSWER: ⌘↑ is the previous-command-block half, so the resize key
   * would step through the scrollback instead. That is what these two
   * assertions are for, and why the second one is here at all.
   */
  it("keeps ⌃ and ⌘ apart, so the resize row answers", () => {
    const seen = watchTerminal();

    for (const chord of shipped("resize-pane-dir")) press(chord);

    expect(seen).toEqual([
      { command: "resize-pane", dir: "left" },
      { command: "resize-pane", dir: "right" },
      { command: "resize-pane", dir: "up" },
      { command: "resize-pane", dir: "down" },
    ]);
  });

  it("does not let a ⌃⌘ arrow fall through to the command blocks", () => {
    const seen = watchTerminal();

    press("⌃⌘↑");
    press("⌃⌘↓");

    expect(
      seen.every((a) => a.command === "resize-pane"),
      "⌃⌘ arrows must not be read as the plain ⌘ arrows of another row"
    ).toBe(true);
  });

  it("still leaves a bare ⌃ arrow to the program in the terminal", () => {
    const seen = watchTerminal();
    press("⌃↑");
    press("⌃↓");
    expect(seen).toEqual([]);
  });

  it("answers ⌘⇧ arrows as command blocks after the user moved ⌘ arrows to scrolling", () => {
    const seen = watchTerminal();
    for (const chord of shipped("command-blocks")) press(chord);
    expect(seen).toEqual([
      { command: "command-blocks", dir: -1 },
      { command: "command-blocks", dir: 1 },
    ]);
  });

describe("the terminal's jump keys (⌘↑/⌘↓ plus ⌘End/⌘Home)", () => {
  it("⌘↓/⌘↑ jump to bottom/top; End/Home remain aliases", () => {
    const event = (key: string, keyCode: number) =>
      ({
        key,
        code: key,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: true,
        keyCode,
      }) as unknown as KeyboardEvent;
    expect(terminalKeyAction(event("ArrowDown", 40))).toEqual({
      command: "scroll-end",
      dir: 1,
    });
    expect(terminalKeyAction(event("ArrowUp", 38))).toEqual({
      command: "scroll-end",
      dir: -1,
    });
    expect(terminalKeyAction(event("End", 35))).toEqual({
      command: "scroll-end",
      dir: 1,
    });
    expect(terminalKeyAction(event("Home", 36))).toEqual({
      command: "scroll-end",
      dir: -1,
    });
  });
});
});
