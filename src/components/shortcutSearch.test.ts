import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  IS_MAC: true,
  isCommandModifier: (e: { metaKey: boolean }) => e.metaKey,
}));

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { STR } from "../strings";
import { formatKeys } from "../strings/formatKeys";
import {
  SHORTCUTS,
  chordId,
  keyOverlay,
  keysFor,
  parseChord,
  resolveBindings,
  setKeyOverrides,
  visibleShortcuts,
  type Shortcut,
} from "../shortcuts";
import { SettingsView } from "./SettingsView";
import { KEYBOARD_SECTION_ID, SETTINGS_SECTIONS } from "./settingsSections";
import {
  SECTION_INDEX,
  buildShortcutIndex,
  searchSettings,
  shortcutsAt,
} from "./settingsSearch";

/** A row of the shipped table, by command — its words are never retyped. */
function row(command: string): Shortcut {
  const found = SHORTCUTS.find((s) => String(s.command) === command);
  if (found === undefined) throw new Error(`no such command: ${command}`);
  return found;
}

const chord = (keys: string) => chordId(parseChord(keys)!);

// --------------------------------------------------------------- the index

describe("the shortcut index is derived, never written down", () => {
  /** A table of three, of a shape this file made up. */
  const TINY: Shortcut[] = [
    { command: "new-terminal", keys: "⌘T", label: "One" },
    { command: "reload", keys: "⌘R", label: "Two" },
    { command: "print", label: "Three" },
  ];

  /**
   * A table of sixty, none of whose rows anybody wrote down. Generated so
   * that its SIZE is the variable: an index that is really a copy of the
   * shipped thirty-six cannot answer for it.
   */
  const LARGE: Shortcut[] = Array.from({ length: 60 }, (_, i) => ({
    command: `made-up-${i}` as Shortcut["command"],
    keys: `⌘⇧${String.fromCharCode(97 + (i % 26))}`,
    label: `Invented row ${i}`,
  }));

  it("holds one entry per row of the shipped composition", () => {
    const rows = resolveBindings(SHORTCUTS, {}).list;
    const index = buildShortcutIndex(rows);
    expect(index.length, "one entry per row").toBe(rows.length);
    expect(index.map((e) => e.command)).toEqual(rows.map((r) => String(r.command)));
  });

  it("holds one entry per row of a composition a tenth the size", () => {
    const rows = resolveBindings(TINY, {}).list;
    const index = buildShortcutIndex(rows);
    expect(index.length).toBe(rows.length);
    expect(index.length).not.toBe(SHORTCUTS.length);
    expect(index.map((e) => e.command)).toEqual(["new-terminal", "reload", "print"]);
  });

  it("holds one entry per row of a composition twice the size", () => {
    const rows = resolveBindings(LARGE, {}).list;
    const index = buildShortcutIndex(rows);
    expect(index.length).toBe(rows.length);
    expect(index.length).toBeGreaterThan(SHORTCUTS.length);
    // And the words come from the rows handed in, not from the shipped
    // table: a row this file invented is findable by the label it invented.
    expect(searchSettings("invented row 41", [], SECTION_INDEX, index)!.commands)
      .toEqual(["made-up-41"]);
  });

  it("indexes a command that answers no key at all", () => {
    // `print` and two others ship key-less on purpose. They are still rows
    // of the table and still what somebody is looking for when they search
    // for printing — an index built from the KEYS would drop all three.
    const index = buildShortcutIndex(resolveBindings(SHORTCUTS, {}).list);
    const print = index.find((e) => e.command === "print");
    expect(print, "the key-less row").toBeDefined();
    expect(print!.keys).toBeNull();
    expect(print!.chords).toEqual([]);
  });

  it("indexes the keys in force rather than the keys as shipped", () => {
    const moved = resolveBindings(SHORTCUTS, { "duplicate-tab": "⌘⇧Y" });
    const index = buildShortcutIndex(moved.list);
    const entry = index.find((e) => e.command === "duplicate-tab")!;
    expect(entry.keys).toBe("⌘⇧Y");
    expect(entry.chords).toEqual([chord("⌘⇧Y")]);
  });
});

// -------------------------------------------------------------- matching

describe("finding a shortcut", () => {
  const index = () => buildShortcutIndex(resolveBindings(SHORTCUTS, {}).list);

  it("finds it by a fragment of what the action is called", () => {
    // Checked against the table's own label so that rewording the row fails
    // this loudly rather than quietly testing nothing.
    const fragment = "duplicate this tab";
    expect(row("duplicate-tab").label.toLowerCase()).toContain(fragment);

    const match = searchSettings(fragment, [], SECTION_INDEX, index())!;
    expect(match.commands).toEqual(["duplicate-tab"]);
    expect(match.sections, "the section its row is in").toEqual([
      KEYBOARD_SECTION_ID,
    ]);
    expect(match.empty).toBe(false);
  });

  it("finds it by the command id the configuration file spells", () => {
    // The one term a user editing `[keys]` is certain to have in front of
    // them, which is the same reason the settings index carries its key.
    const match = searchSettings("duplicate-tab", [], SECTION_INDEX, index())!;
    expect(match.commands).toEqual(["duplicate-tab"]);
  });

  it("finds it by the key, in the spelling of either platform", () => {
    const glyphs = row("duplicate-tab").keys!;
    const words = formatKeys(glyphs, "other");
    expect(searchSettings(glyphs, [], SECTION_INDEX, index())!.commands).toEqual([
      "duplicate-tab",
    ]);
    // Off the Mac the same chord is spelled in words, and the words of one
    // chord can be the beginning of another's: Ctrl+Alt+D is how
    // duplicate-tab reads there and also the first eleven characters of the
    // pane row's Ctrl+Alt+Down. Both are honest answers to that query, so
    // what is asserted is that the row asked for is among them — narrowing
    // it to one would mean teaching the box to stop matching prefixes,
    // which is the behaviour that finds anything at all while it is typed.
    expect(searchSettings(words, [], SECTION_INDEX, index())!.commands).toContain(
      "duplicate-tab"
    );
  });

  it("was invisible to this box before, which is the gap it closes", () => {
    // Without the shortcut index the same query answers nothing at all: the
    // settings index is built from the registry, which knows no shortcuts,
    // and a section's own words come from the strings table, where a
    // shortcut's label does not live either.
    const without = searchSettings("duplicate this tab", [], SECTION_INDEX)!;
    expect(without.sections).toEqual([]);
    expect(without.empty).toBe(true);
  });

  it("answers which command a chord runs, ranges included", () => {
    expect(shortcutsAt(chord("⌘5"), index()).map((e) => e.command)).toEqual([
      "jump-n",
    ]);
    expect(shortcutsAt(chord("⌘S"), index()).map((e) => e.command)).toEqual([
      "save-file",
    ]);
    expect(shortcutsAt(chord("⌘⇧Y"), index())).toEqual([]);
  });
});

// ---------------------------------------------------------------- the page

let host: HTMLElement | null = null;
let root: Root | null = null;

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
}

const w = () => window as unknown as Record<string, unknown>;

async function openSettings(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(createElement(SettingsView)));
  await settle();
  return host;
}

async function typeSearch(text: string) {
  const input = host!.querySelector<HTMLInputElement>(".settings-search-input")!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )!.set!;
  setValue.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

/** Press a chord at the window, the way a keyboard delivers one. */
async function press(keys: string) {
  const c = parseChord(keys)!;
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: c.key.length === 1 ? c.key : c.key,
      metaKey: c.cmd,
      ctrlKey: c.ctrl,
      altKey: c.alt,
      shiftKey: c.shift,
      bubbles: true,
      cancelable: true,
    })
  );
  await settle();
}

/** The section ids still on screen — the userscripts one sits in a wrapper. */
function visibleSections(): string[] {
  return Array.from(host!.querySelectorAll("section"))
    .filter((s) => !s.hasAttribute("hidden") && s.closest("[hidden]") === null)
    .map((s) => s.getAttribute("id") ?? "");
}

/** Every shortcut row the Keyboard section is showing. */
function shortcutRows(): string[] {
  return Array.from(host!.querySelectorAll("tr[data-command]")).map(
    (tr) => tr.getAttribute("data-command") ?? ""
  );
}

function rowOf(command: string): HTMLElement {
  const tr = host!.querySelector<HTMLElement>(`tr[data-command="${command}"]`);
  if (tr === null) throw new Error(`no row for ${command}`);
  return tr;
}

/** The button in a row whose label is this string. */
function button(within: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(within.querySelectorAll("button")).find(
    (b) => b.textContent === label
  );
  if (found === undefined) throw new Error(`no “${label}” button`);
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();
}

/** The sentences the section is showing, wherever a verdict is drawn. */
function verdicts(within: HTMLElement = host!): string[] {
  return Array.from(within.querySelectorAll(".keyboard-verdict p")).map(
    (p) => p.textContent ?? ""
  );
}

beforeEach(() => {
  mocks.invoke.mockImplementation(async (cmd) =>
    cmd === "config_schema" ? [] : undefined
  );
  w().__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  if (root !== null) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  delete w().__TAURI_INTERNALS__;
  setKeyOverrides({});
});

describe("the Keyboard section under a search", () => {
  it("shows every shortcut before anything is typed", async () => {
    await openSettings();
    expect(shortcutRows()).toEqual(
      visibleShortcuts().map((s) => String(s.command))
    );
  });

  it("thins to the one row the query names, section and all", async () => {
    await openSettings();
    await typeSearch("duplicate this tab");

    expect(shortcutRows()).toEqual(["duplicate-tab"]);
    expect(visibleSections()).toEqual([KEYBOARD_SECTION_ID]);
    expect(rowOf("duplicate-tab").className).toContain("settings-hit");
  });

  it("puts every row back when the box is cleared", async () => {
    await openSettings();
    await typeSearch("duplicate this tab");
    await typeSearch("");
    expect(shortcutRows().length).toBe(visibleShortcuts().length);
    expect(host!.querySelectorAll(".settings-hit").length).toBe(0);
  });

  it("leaves the rest of the page searchable as it was", async () => {
    // The shortcut index is an addition, not a replacement: a query that
    // answers to a section's own prose still answers.
    await openSettings();
    await typeSearch("shell integration");
    expect(visibleSections()).toEqual(["status"]);
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain(KEYBOARD_SECTION_ID);
  });
});

describe("looking a key up", () => {
  it("names the command a pressed key runs", async () => {
    await openSettings();
    await click(button(host!, STR.settings.keyboard.lookup));
    await press(row("switcher").keys!);

    expect(verdicts()).toEqual([
      STR.settings.keyboard.lookupHit({
        keys: formatKeys(row("switcher").keys!),
        action: row("switcher").label,
      }),
    ]);
  });

  it("answers for a key inside a range, which is the point of chords", async () => {
    await openSettings();
    await click(button(host!, STR.settings.keyboard.lookup));
    await press("⌘5");

    expect(verdicts()).toEqual([
      STR.settings.keyboard.lookupHit({
        keys: formatKeys("⌘5"),
        action: row("jump-n").label,
      }),
    ]);
  });

  it("says so when nothing answers, and names what the system holds", async () => {
    await openSettings();
    await click(button(host!, STR.settings.keyboard.lookup));
    await press("⌘⇧Y");
    expect(verdicts()).toEqual([
      STR.settings.keyboard.lookupMiss({ keys: formatKeys("⌘⇧Y") }),
    ]);

    // ⌘C is nobody's shortcut here and everybody's copy: "nothing answers
    // it" would be true of this table and useless to the person asking.
    await click(button(host!, STR.settings.keyboard.lookup));
    await press("⌘C");
    expect(verdicts()).toEqual([
      STR.settings.keyboard.lookupHeld({
        keys: formatKeys("⌘C"),
        holder: STR.settings.keyboard.reserved.copy,
      }),
    ]);
  });
});

describe("recording a new key", () => {
  /** Put a row into recording and press `keys` into it. */
  async function record(command: string, keys: string) {
    await click(button(rowOf(command), STR.settings.keyboard.change));
    await press(keys);
  }

  it("names the command already holding the key, and refuses to save", async () => {
    await openSettings();
    await record("switcher", row("duplicate-tab").keys!);

    expect(verdicts(rowOf("switcher"))).toEqual([
      STR.settings.keyboard.takenBy({
        keys: formatKeys(row("duplicate-tab").keys!),
        action: row("duplicate-tab").label,
      }),
    ]);
    expect(
      button(rowOf("switcher"), STR.settings.keyboard.save).disabled,
      "an occupied key cannot be saved"
    ).toBe(true);
  });

  it("names a key a view owns — the blind spot — and refuses that too", async () => {
    await openSettings();
    await record("switcher", row("save-file").keys!);

    expect(verdicts(rowOf("switcher"))).toEqual([
      STR.settings.keyboard.takenByView({
        keys: formatKeys(row("save-file").keys!),
        action: row("save-file").label,
      }),
    ]);
    expect(button(rowOf("switcher"), STR.settings.keyboard.save).disabled).toBe(
      true
    );
  });

  it("warns about a key the system holds without refusing it", async () => {
    await openSettings();
    await record("switcher", "⌘Q");

    expect(verdicts(rowOf("switcher"))).toEqual([
      STR.settings.keyboard.heldByApp({
        keys: formatKeys("⌘Q"),
        holder: STR.settings.keyboard.reserved.quit,
      }),
      STR.settings.keyboard.heldNote,
    ]);
    expect(
      button(rowOf("switcher"), STR.settings.keyboard.save).disabled,
      "the list of keys others take can never be complete"
    ).toBe(false);
  });

  it("takes a free key, and every consumer of the table moves with it", async () => {
    await openSettings();
    await record("switcher", "⌘⇧Y");

    expect(verdicts(rowOf("switcher"))).toEqual([
      STR.settings.keyboard.free({ keys: formatKeys("⌘⇧Y") }),
    ]);
    await click(button(rowOf("switcher"), STR.settings.keyboard.save));

    expect(keysFor("switcher"), "the composition").toBe("⌘⇧Y");
    expect(keyOverlay().switcher, "the overlay the file will hold").toBe("⌘⇧Y");
    expect(
      rowOf("switcher").querySelector("td")!.textContent,
      "the row on screen"
    ).toBe(formatKeys("⌘⇧Y"));
  });

  it("unbinds a command, and gives it its shipped key back", async () => {
    await openSettings();
    await click(button(rowOf("switcher"), STR.settings.keyboard.unbind));

    expect(keysFor("switcher"), "nothing answers for it").toBe("switcher");
    expect(rowOf("switcher").querySelector("td")!.textContent).toBe("");

    // "Unbound" and "left alone" are different lines in the file, so the way
    // back is deleting the line rather than writing today's default into it.
    await click(button(rowOf("switcher"), STR.settings.keyboard.reset));
    expect(keyOverlay().switcher).toBeUndefined();
    expect(keysFor("switcher")).toBe(row("switcher").keys);
  });

  it("gives the keyboard back the moment the search box is typed into", async () => {
    // The capture takes EVERY key while a row is listening, that box
    // included — a recording left running would leave somebody typing into
    // a box that stays empty and no way to tell why.
    await openSettings();
    await click(button(rowOf("switcher"), STR.settings.keyboard.change));
    expect(host!.querySelectorAll(".keyboard-recorder").length).toBe(1);

    await typeSearch("duplicate");
    expect(host!.querySelectorAll(".keyboard-recorder").length).toBe(0);

    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", spy, { capture: true });
    await press("⌘⇧Y");
    window.removeEventListener("keydown", spy, { capture: true });
    expect(seen, "keys reach the rest of the app again").toHaveLength(1);
  });

  it("does not run the command it is recording", async () => {
    // Recording ⌘W must not close the tab. The capture is offered the key
    // before the app-wide handler, which is why this holds; a listener the
    // page itself added could not have prevented it.
    const ran: string[] = [];
    const spy = (e: KeyboardEvent) => ran.push(e.key);
    window.addEventListener("keydown", spy, { capture: true });
    await openSettings();
    await record("switcher", row("close-tab").keys!);
    window.removeEventListener("keydown", spy, { capture: true });

    expect(ran, "no listener after the capture saw the key").toEqual([]);
    expect(verdicts(rowOf("switcher"))).toEqual([
      STR.settings.keyboard.takenBy({
        keys: formatKeys(row("close-tab").keys!),
        action: row("close-tab").label,
      }),
    ]);
  });
});
