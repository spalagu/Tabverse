import { afterEach, describe, expect, it } from "vitest";
import {
  RESERVED_KEYS,
  SHORTCUTS,
  chordId,
  chordKeys,
  inspectBinding,
  keyBindings,
  occupiedChords,
  parseChord,
  recordChord,
  reservedKeysFor,
  resolveBindings,
  setKeyOverrides,
  type KeyPlatform,
  type Shortcut,
} from "./shortcuts";
import { strAt } from "./components/settingsSearch";


afterEach(() => {
  setKeyOverrides({});
});

/** A row of the shipped table, by command — never its text retyped here. */
function row(command: string): Shortcut {
  const found = SHORTCUTS.find((s) => String(s.command) === command);
  if (found === undefined) throw new Error(`no such command: ${command}`);
  return found;
}

const shipped = () => resolveBindings(SHORTCUTS, {});

describe("a key another command already answers", () => {
  it("names the command holding it, not merely that it is held", () => {
    // The judgement worth having: "that key is taken" sends a person
    // hunting through thirty-six rows for what the app already knows.
    const verdict = inspectBinding("switcher", row("duplicate-tab").keys!, shipped());

    expect(verdict.taken).toHaveLength(1);
    expect(verdict.taken[0].command).toBe("duplicate-tab");
    expect(verdict.taken[0].label).toBe(row("duplicate-tab").label);
    expect(verdict.taken[0].local, "an app-wide row, not a view's").toBe(false);
    expect(verdict.blocked, "cannot be saved onto an occupied key").toBe(true);
    expect(verdict.free).toBe(false);
  });

  it("says nothing when a command is recorded onto the key it already has", () => {
    const verdict = inspectBinding("duplicate-tab", row("duplicate-tab").keys!, shipped());
    expect(verdict.taken).toEqual([]);
    expect(verdict.blocked).toBe(false);
    expect(verdict.free).toBe(true);
  });

  it("judges the composition in force, not the table as shipped", () => {
    // The user moved the switcher; the key it used to hold is free and the
    // key it holds now is not. A check written against SHORTCUTS passes
    // every case above and fails both of these.
    const moved = resolveBindings(SHORTCUTS, { switcher: "⌘⇧Y" });

    expect(inspectBinding("reload", "⌘⇧Y", moved).taken.map((t) => t.command))
      .toEqual(["switcher"]);
    expect(inspectBinding("reload", row("switcher").keys!, moved).free).toBe(true);
  });

  it("finds the row a range covers, and both halves of a pair", () => {
    // ⌘1…9 is nine keys held by one row: a rebinding onto ⌘5 collides with
    // it rather than sliding underneath it.
    const onFive = inspectBinding("switcher", "⌘5", shipped());
    expect(onFive.taken.map((t) => t.command)).toEqual(["jump-n"]);
    expect(onFive.taken[0].chords).toEqual(["⌘5"]);

    const onUp = inspectBinding("switcher", "⌘↑", shipped());
    expect(onUp.taken.map((t) => t.command)).toEqual(["scroll-end"]);
  });

  it("refuses a candidate that is not a key at all", () => {
    const verdict = inspectBinding("switcher", "", shipped());
    expect(verdict.unreadable).toBe(true);
    expect(verdict.blocked).toBe(true);
    expect(verdict.free).toBe(false);
  });
});

describe("a key a view owns — the blind spot", () => {
  const localRows = SHORTCUTS.filter((s) => s.local === true);

 it("has the six rows the named, and they are not app-wide", () => {
    expect(localRows.length).toBeGreaterThanOrEqual(6);
  });

  for (const local of localRows) {
    it(`reports ${String(local.command)} when a command is recorded onto its key`, () => {
      // ⌘S is the editor's save, ⌘⇧P the file tab's quick open, ⌘J its
      // terminal panel. None of them is in the app-wide handler's index, so
      // a check built on that index calls every one of these keys free.
      const verdict = inspectBinding("switcher", local.keys!, shipped());
      const claim = verdict.taken.find((t) => t.command === String(local.command));

      expect(claim, `${String(local.command)} was not reported`).toBeDefined();
      expect(claim!.local, "a view answers this one itself").toBe(true);
      expect(claim!.label).toBe(local.label);
      expect(verdict.blocked).toBe(true);
    });
  }

  it("keeps the two kinds apart, because they behave differently", () => {
    // Two table rows on one chord are one index entry and one of them stops
    // answering. A view's own listener and the app-wide one are siblings on
    // the window: both run, and neither can call the other off
    // (components/files/fileCloseKey.ts records the rule and uses it). The
    // interface says different things about the two, so the judgement has
    // to tell them apart rather than count collisions.
    const view = inspectBinding("switcher", row("save-file").keys!, shipped());
    const wide = inspectBinding("switcher", row("duplicate-tab").keys!, shipped());
    expect(view.taken[0].local).toBe(true);
    expect(wide.taken[0].local).toBe(false);
  });
});

describe("a key other software holds", () => {
  it("warns about the system's own key without refusing it", () => {
    // ⌘Q on a Mac: the system and the app menu are offered it long before
    // this window is. Warned about, never blocked — see below for why.
    const verdict = inspectBinding("switcher", "⌘Q", shipped(), "mac");

    expect(verdict.taken, "no row of this table holds it").toEqual([]);
    expect(verdict.reserved.map((r) => r.str)).toEqual([
      "settings.keyboard.reserved.quit",
    ]);
    expect(verdict.blocked, "a warning, not a refusal").toBe(false);
    expect(verdict.free, "still not free").toBe(false);
  });

  it("refuses nothing on this list, however it is spelled", () => {
    // The reason it warns: the list is maintained by hand, differs per
    // platform and per platform VERSION, and a user may have moved their
    // own. A refusal built on it would be wrong in the direction a user
    // cannot work around.
    for (const reserved of RESERVED_KEYS) {
      expect(
        inspectBinding("switcher", reserved.keys, shipped(), "mac").blocked,
        reserved.keys
      ).toBe(false);
      expect(
        inspectBinding("switcher", reserved.keys, shipped(), "other").blocked,
        reserved.keys
      ).toBe(false);
    }
  });

  it("applies the platform's own list and not the other one's", () => {
    // Quit is macOS's; copy and paste are everybody's. A list that ignored
    // `where` would warn a Linux user about ⌘Q — a key that does nothing
    // there — and that is how a warning teaches people to ignore warnings.
    const macOnly = (keys: string, platform: KeyPlatform) =>
      inspectBinding("switcher", keys, shipped(), platform).reserved.length;

    expect(macOnly("⌘Q", "mac")).toBe(1);
    expect(macOnly("⌘Q", "other")).toBe(0);
    expect(macOnly("⌘C", "mac")).toBe(1);
    expect(macOnly("⌘C", "other")).toBe(1);
    expect(reservedKeysFor("mac").length).toBeGreaterThan(
      reservedKeysFor("other").length
    );
  });

  it("names a holder the strings table can actually produce", () => {
    // A `str` that leads nowhere would show the dotted path to the user.
    // The interface falls back to it on purpose; this is what keeps the
    // fallback from being the normal case.
    for (const reserved of RESERVED_KEYS) {
      expect(strAt(reserved.str), reserved.str).not.toBeNull();
    }
  });

  it("holds keys this app's own table stays off", () => {
    // A shipped binding sitting on a reserved key would mean the app warns
    // about a key it hands out itself. The check is over the composition of
    // the shipped table, so it also fails if a reserved entry is added on
    // top of a key already in use.
    for (const platform of ["mac", "other"] as KeyPlatform[]) {
      const held = new Set(
        reservedKeysFor(platform).flatMap((r) => occupiedChords(r.keys))
      );
      const clashes = SHORTCUTS.filter(
        (s) => s.keys !== undefined && occupiedChords(s.keys).some((c) => held.has(c))
      ).map((s) => `${String(s.command)} ${s.keys}`);
      expect(clashes, `shipped bindings on a ${platform} reserved key`).toEqual([]);
    }
  });

  it("spells every reserved key so that something can read it back", () => {
    for (const reserved of RESERVED_KEYS) {
      expect(occupiedChords(reserved.keys).length, reserved.keys).toBeGreaterThan(0);
    }
  });
});

describe("reading a press as a key", () => {
  /** A keydown as the DOM presents one, on a Mac. */
  const press = (key: string, mods: Partial<Record<string, boolean>> = {}) => ({
    key,
    shiftKey: mods.shift === true,
    ctrlKey: mods.ctrl === true,
    altKey: mods.alt === true,
    metaKey: mods.meta !== false,
  });

  it("writes a recorded chord the way the table writes one", () => {
    // Round trip matters more than the spelling: what is recorded goes into
    // the configuration file, and a file holding `⌘arrowup` beside `⌘↑`
    // would be two dialects of one table.
    expect(recordChord(press("d", { shift: true }), true)?.keys).toBe("⌘⇧D");
    expect(recordChord(press("ArrowUp"), true)?.keys).toBe("⌘↑");
    expect(recordChord(press(" "), true)?.keys).toBe("⌘Space");
    // The one row of the shipped table on ⌃ rather than ⌘, recorded on a
    // Mac, where those two modifiers are different things.
    expect(recordChord(press("Tab", { ctrl: true, meta: false }), false)?.keys)
      .toBe("⌃Tab");
  });

  it("takes the platform's word for which modifier is the command one", () => {
    // Off a Mac, Ctrl IS the command modifier and must not be reported
    // twice — a chord that came out `⌘⌃T` would match neither spelling in
    // the table. The default argument is the platform's answer, so this
    // asserts the pair of them rather than the machine the test runs on.
    const ctrlT = press("t", { ctrl: true, meta: false });
    expect(recordChord(ctrlT, true)?.keys).toBe("⌘T");
    expect(recordChord(ctrlT, false)?.keys).toBe("⌃T");
  });

  it("reads back into the same chord it recorded", () => {
    for (const key of ["k", "ArrowDown", "Tab", " ", "1", "["]) {
      const recorded = recordChord(press(key, { shift: true }), true)!;
      expect(chordId(parseChord(recorded.keys)!), recorded.keys).toBe(
        chordId(recorded.chord)
      );
    }
  });

  it("records nothing for a modifier held on its own", () => {
    for (const bare of ["Meta", "Shift", "Control", "Alt"]) {
      expect(recordChord(press(bare)), bare).toBeNull();
    }
  });

  it("spells the shipped table's own keys back, unchanged", () => {
    // Every single-chord row, put through parse and spell again. A recorder
    // whose spelling drifts from the table's writes overrides that look
    // nothing like the lines around them.
    for (const s of SHORTCUTS) {
      const chord = s.keys === undefined ? null : parseChord(s.keys);
      if (chord === null) continue;
      expect(chordKeys(chord), s.keys).toBe(s.keys);
    }
  });
});

describe("the composition already in force", () => {
  it("still reports a conflict the configuration file created", () => {
    // The recorder refuses to make one, but a hand-edited `[keys]` section
    // can, and the page reads that file. Both roads are covered: this is
    // resolveBindings' own list, the recorder's is inspectBinding's.
    setKeyOverrides({ "duplicate-tab": "⌘S" });
    const conflicts = keyBindings().conflicts;
    expect(conflicts).toHaveLength(1);
    expect([...conflicts[0].commands].sort()).toEqual([
      "duplicate-tab",
      "save-file",
    ]);
  });
});
