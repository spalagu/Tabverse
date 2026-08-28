import keysSource from "../src-tauri/src/keys.rs?raw";
import overlaySource from "./components/ShortcutsOverlay.tsx?raw";
import settingsSource from "./components/SettingsView.tsx?raw";
import { afterEach, describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  chordId,
  keyBindings,
  keysFor,
  keysShownFor,
  occupiedChords,
  parseChord,
  parseRange,
  resolveBindings,
  setKeyOverrides,
  visibleShortcuts,
} from "./shortcuts";
import { buildHandlerIndex, handlerRows } from "./keys";
import { keyOverrides } from "./state/config";


afterEach(() => {
  // The overlay is module state, as it must be — twenty-odd callers of
  // `keysFor` are not components and cannot subscribe to anything.
  setKeyOverrides({});
});

const SHIPPED_DUPLICATE_KEY = SHORTCUTS.find(
  (s) => s.command === "duplicate-tab"
)!.keys as string;

/** The chord a table row occupies, as the handler's index names it. */
function chordOf(keys: string): string {
  const chord = parseChord(keys);
  if (chord === null) throw new Error(`not one chord: ${keys}`);
  return chordId(chord);
}

/**
 * The chord these tests move a command ONTO has to be one the shipped table
 * does not use. Move a command onto the key it already has and the second
 * half of every override test — "and the old key is free now" — passes for
 * the wrong reason, because the old key and the new key are the same key.
 *
 * That is not hypothetical. duplicate-tab was moved to ⌘⇧U while eight tests
 * in three files were using ⌘⇧U as their spare, and all eight went red at
 * once. The literal is still written out below (a spare key you cannot read
 * is worse than one you can), but it is guarded here, in one place, instead
 * of in the twenty copies of it.
 */
const PROBE_CHORD = "⌘⇧Y";

it("keeps the probe chord out of the shipped table", () => {
  expect(SHORTCUTS.some((r) => r.keys === PROBE_CHORD)).toBe(false);
});

describe("composing defaults with an overlay", () => {
  it("leaves the table alone when the overlay is empty", () => {
    const b = resolveBindings(SHORTCUTS, {});
    expect(b.list).toEqual([...SHORTCUTS]);
    expect(b.conflicts).toEqual([]);
    expect(b.unknown).toEqual([]);
  });

  it("puts a command on the key the overlay names", () => {
    const b = resolveBindings(SHORTCUTS, { "duplicate-tab": "⌘⇧Y" });
    expect(b.byCommand.get("duplicate-tab")).toBe("⌘⇧Y");
    expect(b.byChord.get(chordOf("⌘⇧Y"))?.command).toBe("duplicate-tab");
    // And lets go of what it left, which is the half a "the new key works"
    // check passes without ever noticing.
    expect(b.byChord.has(chordOf(SHIPPED_DUPLICATE_KEY))).toBe(false);
  });

  it("unbinds on the empty string, and then nothing answers", () => {
    const b = resolveBindings(SHORTCUTS, { "duplicate-tab": "" });
    expect(b.byCommand.has("duplicate-tab")).toBe(false);
    expect(b.byChord.has(chordOf(SHIPPED_DUPLICATE_KEY))).toBe(false);
    expect(b.list.find((s) => s.command === "duplicate-tab")?.keys).toBeUndefined();
    // "Unbound" and "left alone" are different sentences in that file, and
    // this is the difference: an absent line keeps the shipped key.
    expect(resolveBindings(SHORTCUTS, {}).byCommand.get("duplicate-tab")).toBe(
      SHIPPED_DUPLICATE_KEY
    );
  });

  it("reports an overlay key that names no command, and applies nothing", () => {
    const b = resolveBindings(SHORTCUTS, { "not-a-command": "⌘⇧Z" });
    expect(b.unknown).toEqual(["not-a-command"]);
    expect(b.list).toEqual([...SHORTCUTS]);
  });

  it("finds two commands on one key, including a key a view owns", () => {
    // ⌘S is the editor's save — a `local` row, and the six local rows were
    // the blind spot: the old menu-only check skipped them outright, so a
    // global binding could be laid on top of one and nothing would say so.
    const b = resolveBindings(SHORTCUTS, { "duplicate-tab": "⌘S" });
    expect(b.conflicts).toHaveLength(1);
    expect(b.conflicts[0].keys).toBe("⌘S");
    expect([...b.conflicts[0].commands].sort()).toEqual(["duplicate-tab", "save-file"]);
  });

  it("counts a range as every key in it, and a compound as both halves", () => {
    expect(occupiedChords("⌘1…9")).toHaveLength(9);
    expect(occupiedChords("⌘1…9")).toContain("⌘5");
    expect(occupiedChords("⌘↑ / ⌘↓")).toEqual(["⌘↑", "⌘↓"]);
    // So a rebinding onto ⌘3 collides with the tab-jump row rather than
    // sliding under it, which one chord per row would have let it do.
    const b = resolveBindings(SHORTCUTS, { switcher: "⌘3" });
    expect(b.conflicts.map((c) => c.commands.sort())).toEqual([["jump-n", "switcher"]]);
  });

  it("reads a range's ends off the row rather than assuming them", () => {
    expect(parseRange("⌘1…9")).toEqual({
      chord: { cmd: true, shift: false, ctrl: false, alt: false, key: "" },
      from: "1",
      to: "9",
    });
    expect(parseRange("⌘1…4")?.to).toBe("4");
    expect(parseRange("⌘T")).toBeNull();
  });

  it("parses the modifiers the table writes, and refuses the shapes it does not", () => {
    expect(parseChord("⌘⇧B")).toEqual({
      cmd: true, shift: true, ctrl: false, alt: false, key: "b",
    });
    expect(parseChord("⌃Tab")).toEqual({
      cmd: false, shift: false, ctrl: true, alt: false, key: "tab",
    });
    expect(parseChord("⌘⇧\\")?.key).toBe("\\");
    expect(parseChord("⌘1…9")).toBeNull();
    expect(parseChord("⌘↑ / ⌘↓")).toBeNull();
    expect(parseChord("⌘")).toBeNull();
  });
});

describe("one override reaches every consumer", () => {
  it("moves the handler and the lists that teach the keys, together", () => {
    const before = buildHandlerIndex(keyBindings());
    expect(before.get(chordOf(SHIPPED_DUPLICATE_KEY))).toBe("duplicate-tab");

    setKeyOverrides({ "duplicate-tab": "⌘⇧Y" });

    // Consumer one: what the app-wide handler answers.
    const after = buildHandlerIndex(keyBindings());
    expect(after.get(chordOf("⌘⇧Y"))).toBe("duplicate-tab");
    expect(after.has(chordOf(SHIPPED_DUPLICATE_KEY))).toBe(false);

    // Consumer two: the ⌘/ overlay and the settings page, which render this
    // one function — `shortcuts.test.ts` is where the screens are held to it.
    const row = visibleShortcuts().find((s) => s.command === "duplicate-tab");
    expect(row?.keys).toBe("⌘⇧Y");
    // And the sentences and badges that name a key, which are the same
    // reading by another door.
    expect(keysFor("duplicate-tab")).toBe("⌘⇧Y");
    expect(keysShownFor("duplicate-tab")).toBe("⌘⇧Y");
  });

  it("takes the key away from every consumer when the overlay unbinds it", () => {
    setKeyOverrides({ "duplicate-tab": "" });
    const index = buildHandlerIndex(keyBindings());
    expect([...index.values()]).not.toContain("duplicate-tab");
    expect(visibleShortcuts().find((s) => s.command === "duplicate-tab")?.keys)
      .toBeUndefined();
    // A badge with no key does not render; a sentence falls back to the
    // command's own name rather than naming a key that does nothing.
    expect(keysShownFor("duplicate-tab")).toBe("");
    expect(keysFor("duplicate-tab")).toBe("duplicate-tab");
  });

  it("keeps the three special shapes special, with the keys the table gives", () => {
    // The handler's own branches — find is dispatched by where the user is
    // looking, the jump row answers nine keys, cycle-tabs answers two
    // commands — so none of them is in the plain index. Their KEYS still
    // come from the table, which is what these three assert.
    const index = buildHandlerIndex(keyBindings());
    expect(index.has(chordOf("⌘F"))).toBe(false);
    expect(index.has(chordOf("⌃Tab"))).toBe(false);

    setKeyOverrides({ find: "⌘⇧F", "jump-n": "⌘1…4", "cycle-tabs": "⌃Q" });
    const b = keyBindings();
    expect(b.byCommand.get("find")).toBe("⌘⇧F");
    expect(parseRange(b.byCommand.get("jump-n") as string)?.to).toBe("4");
    expect(parseChord(b.byCommand.get("cycle-tabs") as string)?.key).toBe("q");
    // Still not in the plain index after the move: a special shape that
    // quietly became an ordinary binding would dispatch find everywhere.
    expect(buildHandlerIndex(b).has(chordOf("⌘⇧F"))).toBe(false);
  });

  it("answers a zoom key under both of the names one physical key has", () => {
    const index = buildHandlerIndex(keyBindings());
    // A US keyboard types "+" as shift+"=", so the row that reads ⌘= has to
    // answer four ways. It is a rule about keyboards, applied to whatever
    // the table says, not four rows in the table.
    for (const chord of ["⌘=", "⌘+", "⌘⇧=", "⌘⇧+"]) {
      expect(index.get(chordOf(chord)), chord).toBe("zoom-in");
    }
  });
});

describe("who holds a chord two rows both claim", () => {
  /**
   * The composition and the handler used to answer that question by
   * different rules — `byChord` kept the FIRST row to claim a chord, the
   * handler's index kept the LAST — and nothing reported it because only
   * tests read `byChord`. It becomes a defect the day a screen uses it to
   * say what holds a key: the sentence would name one command and a
   * different one would run.
   *
   * A conflict cannot be reached through the interface (`inspectBinding`
   * refuses to save one), so every case here is the hand-edited
   * `config.toml` that can.
   */

  /** Where the two indexes both have an opinion, and what each one says. */
  function disagreements(b: ReturnType<typeof resolveBindings>): string[] {
    const index = buildHandlerIndex(b);
    const answerable = new Set(handlerRows(b).map((s) => String(s.command)));
    const out: string[] = [];
    for (const [chord, command] of index) {
      const holder = b.byChord.get(chord);
      // Chords the handler reaches that `byChord` has no row for are the
      // keyboard aliases (⌘+ for a row that reads ⌘=); chords whose holder
      // is a row the handler skips are the local ones, where BOTH answer on
      // purpose and neither can cancel the other.
      if (holder === undefined) continue;
      if (!answerable.has(String(holder.command))) continue;
      if (String(holder.command) !== command) {
        out.push(`${chord}: the table says ${holder.command}, the handler runs ${command}`);
      }
    }
    return out;
  }

  it("is the earlier row, and both indexes say so", () => {
    // duplicate-tab is written above reload in the table, so moving it onto
    // reload's key makes it the first claim. Under the handler's old rule
    // the later row won and this chord ran reload.
    const b = resolveBindings(SHORTCUTS, { "duplicate-tab": "⌘R" });
    const chord = chordOf("⌘R");

    expect(b.conflicts.map((c) => c.commands)).toEqual([["duplicate-tab", "reload"]]);
    expect(b.byChord.get(chord)?.command).toBe("duplicate-tab");
    expect(buildHandlerIndex(b).get(chord)).toBe("duplicate-tab");
  });

  it("is still the earlier row when the conflict is written the other way up", () => {
    // The mirror image, so that neither answer can be right by accident:
    // here the row that MOVED is the later one, and the shipped row keeps
    // the key.
    const b = resolveBindings(SHORTCUTS, { reload: SHIPPED_DUPLICATE_KEY });
    const chord = chordOf(SHIPPED_DUPLICATE_KEY);

    expect(b.byChord.get(chord)?.command).toBe("duplicate-tab");
    expect(buildHandlerIndex(b).get(chord)).toBe("duplicate-tab");
  });

  it("lets a row that names a key outright keep it from another row's shadow", () => {
    // ⌘⇧+ is what a US keyboard sends for ⌘=, so zoom-in shadows it. A row
    // that asks for that chord BY NAME must still get it, or the two
    // indexes part company: `byChord` only ever hears the name.
    const b = resolveBindings(SHORTCUTS, { "zoom-reset": "⌘⇧+" });
    const chord = chordOf("⌘⇧+");

    expect(b.byChord.get(chord)?.command).toBe("zoom-reset");
    expect(buildHandlerIndex(b).get(chord)).toBe("zoom-reset");
    // And zoom-in keeps the shadow nobody named.
    expect(buildHandlerIndex(b).get(chordOf("⌘⇧="))).toBe("zoom-in");
  });

  it("agrees everywhere both indexes have an opinion, conflicts and all", () => {
    // The general form, so that the three cases above are examples of a
    // rule rather than the rule itself.
    const overlays: Record<string, string>[] = [
      {},
      { "duplicate-tab": "⌘R" },
      { reload: "⌘⇧D" },
      { "zoom-reset": "⌘⇧+" },
      { switcher: "⌘T", join: "⌘T", "toggle-pin": "⌘T" },
      // A local row claiming first: both answer, so this must NOT count as
      // a disagreement — the exclusion that keeps the check honest.
      { reload: "⌘3", "history-panel": "⌘S" },
    ];
    for (const overlay of overlays) {
      expect(disagreements(resolveBindings(SHORTCUTS, overlay)), JSON.stringify(overlay))
        .toEqual([]);
    }
  });
});

describe("the two screens that teach the keys read the composition", () => {
  it("both call the hook that repaints when a key moves", () => {
    // Rendering is out of this harness's scope (vitest.config.ts: pure logic),
    // so the check is that neither screen has a reading of its own — the way
    // both of them once had a hand-kept copy of the table.
    expect(overlaySource).toContain("useVisibleShortcuts()");
    expect(settingsSource).toContain("useVisibleShortcuts()");
  });
});

describe("the other language reads the same table", () => {
  it("keys.rs embeds the very file this side imports", () => {
    // The one thing neither side can assert alone. If Rust ever read a table
    // of its own, every test in both languages would still pass and the two
    // would drift exactly as the four copies did.
    expect(keysSource).toContain('include_str!("../../src/shortcuts.json")');
  });
});

describe("the [keys] section as the file writes it", () => {
  it("reads command-to-key pairs, and nothing else", () => {
    expect(
      keyOverrides({
        appearance: { theme: "dark", sidebar_width: 248, sidebar_pinned: true },
        browser: {
          search_engine: "duckduckgo",
          custom_search_template: "",
          archive_after: "24h",
        },
        keys: { "duplicate-tab": "⌘⇧Y", "close-tab": "", "bad-value": 7 },
      })
    ).toEqual({ "duplicate-tab": "⌘⇧Y", "close-tab": "" });
  });

  it("is an empty overlay when the file has no such section", () => {
    // Not "not read yet": the defaults are in the bundle either way, so an
    // absent section makes nothing unknown and nothing is guessed at.
    expect(keyOverrides(null)).toEqual({});
  });
});
