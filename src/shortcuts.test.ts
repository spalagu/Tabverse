// The Rust side is read as text through the bundler, so this test needs no
// filesystem types and works the same way the app is built.
import menuSource from "../src-tauri/src/lib.rs?raw";
// The command union, read the same way, because a JSON table cannot be type
// checked against it — see "what this file locks" below.
import commandSource from "./appCommands?raw";
import localSource from "./shortcuts.ts?raw";
import { describe, expect, it } from "vitest";
import { SHORTCUTS, keyBindings, parseChord } from "./shortcuts";
import { buildHandlerIndex } from "./keys";


/** Every command name the app dispatches, read off the union in appCommands.ts. */
const appCommands = (() => {
  const block = /export type AppCommand =([\s\S]*?);/.exec(commandSource);
  if (!block) throw new Error("no AppCommand union in appCommands.ts");
  const out = new Set<string>();
  for (const m of block[1].matchAll(/\|\s*"([a-z-]+)"/g)) out.add(m[1]);
  // The jump family is a template literal type, one command per digit.
  if (/jump-\$\{/.test(block[1])) {
    for (let n = 1; n <= 9; n += 1) out.add(`jump-${n}`);
  }
  return out;
})();

/** The names a single view owns, read off the union in shortcuts.ts. */
const localCommands = (() => {
  const block = /export type LocalCommand =([\s\S]*?);/.exec(localSource);
  if (!block) throw new Error("no LocalCommand union in shortcuts.ts");
  return new Set([...block[1].matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1]));
})();

/** The menu's own entries: structure and labels are still hand-written Rust. */
const menuItems = (() => {
  const out: { id: string; label: string }[] = [];
  const re = /cmd_item\(\s*handle,\s*bindings,\s*"([a-z-]+)",\s*"([^"]*)",?\s*\)/g;
  for (const m of menuSource.matchAll(re)) out.push({ id: m[1], label: m[2] });
  return out;
})();

describe("the table names commands the app has", () => {
  it("every row is an app command, or a command one view owns", () => {
    const strays = SHORTCUTS.map((s) => String(s.command)).filter(
      (c) => !appCommands.has(c) && !localCommands.has(c)
    );
    // The check the type system made until the table became data. A typo here
    // used to fail `tsc`; now it would ship a row whose key dispatches a
    // command nothing answers, which is silent in every direction.
    expect(strays, "shortcut rows naming no command this app has").toEqual([]);
  });

  it("every app command with a key is in the table", () => {
    // The direction the type never checked: a command the app dispatches but
    // the table never lists is a command with no key, no ⌘/ row and no place
    // in the command bar's inventory — reachable only by whoever remembers it.
    const listed = new Set(SHORTCUTS.map((s) => String(s.command)));
    const missing = [...appCommands].filter(
      (c) =>
        !listed.has(c) &&
        // The jump family is one table row (`jump-n`) answering nine keys,
        // and `go-pinned` is a broadcast the sidebar sends, never a key.
        !/^jump-\d$/.test(c) &&
        c !== "go-pinned"
    );
    expect(missing, "app commands the shortcut table never lists").toEqual([]);
  });

  it("every row's keys parse, or are a shape the handler knows", () => {
    const unreadable = SHORTCUTS.filter((s) => s.keys !== undefined)
      .filter((s) => parseChord(s.keys as string) === null)
      .map((s) => `${String(s.command)} (${s.keys})`);
    // Five rows are not one chord — one range and four compounds — and
    // something has a branch for each: the handler for the range, and
    // `localKeys.ts` for the compounds, which it reads by POSITION (first
    // half is previous/top, first quarter is left) rather than by glyph.
    // (⌃Tab parses fine; it is special for a different reason: shift picks
    // which of two commands it runs.) A sixth entry here would be a key
    // that silently answers nowhere.
    expect(unreadable.sort()).toEqual([
      "command-blocks (⌘⇧↑ / ⌘⇧↓)",
      "focus-pane-dir (⌘⌥← / ⌘⌥→ / ⌘⌥↑ / ⌘⌥↓)",
      "jump-n (⌘1…9)",
      "resize-pane-dir (⌃⌘← / ⌃⌘→ / ⌃⌘↑ / ⌃⌘↓)",
      "scroll-end (⌘↑ / ⌘↓)",
    ]);
  });
});

describe("what the handler answers follows from the table", () => {
  const index = buildHandlerIndex(keyBindings());

  it("answers nothing for a command shown with no key", () => {
    for (const s of SHORTCUTS) {
      if (s.keys !== undefined) continue;
      const bound = [...index.entries()].filter(([, c]) => c === s.command);
      expect(bound, `"${String(s.command)}" is shown with no key, yet the handler binds it`)
        .toEqual([]);
    }
  });

  it("answers nothing a single view owns", () => {
    const owned = [...index.values()].filter((c) => localCommands.has(c));
    // The editor's save and the terminal's find are answered where the user
    // is looking; a global binding for one of them would take the key away
    // from the view that owns it.
    expect(owned, "view-owned commands the app-wide handler answers").toEqual([]);
  });
});

describe("the native menu, whose structure is still written by hand", () => {
  it("has no entry for a command the app no longer has", () => {
    const known = new Set(SHORTCUTS.map((s) => String(s.command)));
    const ghosts = menuItems.filter((m) => !known.has(m.id));
    // Twice over, this is how a key went missing: the command was deleted,
    // the menu entry stayed, and the entry quietly held the key that the
    // command replacing it was given.
    expect(
      ghosts.map((g) => `${g.id} (${g.label})`),
      "menu entries whose command is not in the shortcut table"
    ).toEqual([]);
  });

  it("carries no accelerator of its own", () => {
    const withAccel = [
      ...menuSource.matchAll(/cmd_item\(\s*handle,\s*"[a-z-]+",\s*"[^"]*",\s*"[^"]*",?\s*\)/g),
    ].map((m) => m[0]);
    expect(withAccel, "menu items still passing a key of their own").toEqual([]);
    expect(menuItems.length).toBeGreaterThan(20);
  });

  it("gives no two entries the same keys", () => {
    const ids = new Set(menuItems.map((m) => m.id));
    const clashes = keyBindings()
      .conflicts.filter((c) => c.commands.some((cmd) => ids.has(cmd)))
      .map((c) => `${c.keys}: ${c.commands.join(" and ")}`);
    // Asked of the composition now, because that is where a default and an
    // override can collide; the menu has no keys of its own to collide with.
    expect(clashes).toEqual([]);
  });

});

describe("the script injected into pages is serialized, not written", () => {
  it("holds no binding table of its own", () => {
    // `shortcut_script_for`, not `shortcut_script`: the script moved into the
    // function that takes a composition as an argument, and the one-line
    // wrapper that reads the live composition kept the old name. Anchored on
    // the function that HOLDS the source, so this cannot go on reading an
    // empty match and reporting green — which the length assertion below is
    // the second guard against.
    const script =
      /fn shortcut_script_for\([\s\S]*?\n\}/.exec(menuSource)?.[0] ?? "";
    expect(script.length).toBeGreaterThan(1000);
    // Substitutions, not literals. The copy that used to stand here bound
    // shift+D to a command deleted long enough ago that the menu's version of
    // the same mistake had already been found and fixed.
    expect(script).toContain("var PLAIN = {plain};");
    expect(script).toContain("var SHIFTED = {shifted};");
    // The seventh copy's replacement: the tab cycle arrives as a
    // substitution too, rather than as `e.ctrlKey && e.key === "Tab"`.
    expect(script).toContain("var CYCLE = {cycle};");
    const entries = [...script.matchAll(/[{,]\s*"?[A-Za-z0-9\\/[\]=+-]"?\s*:\s*"[a-z-]+"/g)];
    expect(
      entries.map((m) => m[0].trim()),
      "hand-written bindings left in the injected script"
    ).toEqual([]);
  });
});

describe("the ⌘/ quick reference", () => {
  it("is in the one table, keyed ⌘/, and the Help menu carries it", () => {
    const entry = SHORTCUTS.find((s) => s.command === "shortcuts-help");
    expect(entry?.keys).toBe("⌘/");
    // The macOS-standard Help menu holds the same command; that its
    // accelerator is CmdOrCtrl+/ is `keys.rs`'s to assert, since that is
    // where the key is turned into one.
    expect(menuItems.some((m) => m.id === "shortcuts-help")).toBe(true);
  });
});
