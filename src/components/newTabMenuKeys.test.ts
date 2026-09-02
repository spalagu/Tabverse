import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NewTabMenu, DIRECT_KEYS, directIndex } from "./NewTabMenu";
import { useGlobalKeys } from "../keys";
import { keyBindings, parseChord } from "../shortcuts";
import { useStore } from "../state/store";
import {
  BOOT_CONFIG_KEY,
  DEMO_SCHEMA_KEY,
  type ConfigValues,
} from "../state/config";


const w = () => window as unknown as Record<string, unknown>;

const CONFIG: ConfigValues = {
  appearance: { theme: "light", sidebar_width: 301, sidebar_pinned: false },
  browser: {
    search_engine: "duckduckgo",
    custom_search_template: "",
    archive_after: "24h",
  },
  terminal: {
    profiles: [
      { name: "deploy", shell: "/bin/bash", cwd: "/srv" },
      { name: "local" },
    ],
    templates: [
      {
        name: "work",
        tree: {
          kind: "split",
          vertical: false,
          children: [
            { kind: "leaf", cwd: "/work/app" },
            { kind: "leaf", cwd: "/work/logs" },
          ],
        },
      },
    ],
  },
};

const SCHEMA = [
  {
    key: "appearance.sidebar_width",
    kind: { number: { min: 180, max: 520 } },
    section: "appearance",
    str_key: "settings.appearance.sidebarWidth",
    default: 301,
  },
];

/**
 * What a terminal would see: a bubble-phase listener on the window, which is
 * the last thing a key event reaches. The picker's own handler runs in the
 * capture phase and stops what it takes, so this list is exactly the keys
 * that got past the interface — the stand-in for "the shell received it".
 */
let reachedTerminal: { key: string; prevented: boolean }[] = [];

function terminalListener(e: KeyboardEvent) {
  reachedTerminal.push({ key: e.key, prevented: e.defaultPrevented });
}

/**
 * The app's two keyboard citizens: the global handler, always mounted, and
 * the picker, mounted only while it is open — which is how the app itself
 * renders it (App.tsx draws it on `newTabMenuOpen`).
 */
function Harness({ open }: { open: boolean }) {
  useGlobalKeys();
  return open ? createElement(NewTabMenu) : null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function show(open: boolean): Promise<void> {
  if (host === null) {
    host = document.createElement("div");
    document.body.appendChild(host);
  }
  const el = host;
  await act(async () => {
    root ??= createRoot(el);
    root.render(createElement(Harness, { open }));
  });
  // The profile list arrives over a promise; let it land so the picker is
  // drawing the entries the digits are supposed to address.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Press a key on the window, as a real key press arrives. Returns whether
 * anything called preventDefault on it. */
async function press(
  key: string,
  modifiers: { metaKey?: boolean } = {}
): Promise<boolean> {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  await act(async () => {
    window.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const tabs = () => useStore.getState().tabs;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  reachedTerminal = [];
  w()[BOOT_CONFIG_KEY] = CONFIG;
  w()[DEMO_SCHEMA_KEY] = SCHEMA;
  useStore.setState({ tabs: [], activeTabId: null, newTabMenuOpen: false });
  window.addEventListener("keydown", terminalListener);
});

afterEach(() => {
  window.removeEventListener("keydown", terminalListener);
  if (root && host) {
    const done = root;
    act(() => done.unmount());
    host.remove();
  }
  root = null;
  host = null;
  delete w()[BOOT_CONFIG_KEY];
  delete w()[DEMO_SCHEMA_KEY];
});

describe("the picker's number keys, while it is open", () => {
  it("opens the entry a digit names", async () => {
    await show(true);
    // The third fixed entry is the browser one; the picker draws them in the
    // order it lists them, which is the order the digits address.
    expect(await press("3")).toBe(true);
    expect(tabs().map((t) => t.type)).toEqual(["browser"]);
  });

  it("opens a terminal under the profile a digit names", async () => {
    await show(true);
    // Five fixed entries, then the profiles: `deploy` is the sixth.
    expect(await press("6")).toBe(true);
    const [tab] = tabs();
    expect(tab.type).toBe("terminal");
    // THE POINT OF THE WHOLE STRAND: the profile's NAME is on the tab, which
    // is what a spawn reads to decide the shell, the environment and the
    // start command.
    expect(tab.profile).toBe("deploy");
  });

  it("opens a saved layout the digit names, as the layout it is", async () => {
    await show(true);
    // Five fixed entries, two profiles, then the layouts: `work` is the eighth.
    expect(await press("8")).toBe(true);
    const [tab] = tabs();
    expect(tab.type).toBe("terminal");
    // THE POINT: what opens is the declared tree, not one terminal — the
    // digit addressed a layout and a layout is what appeared.
    expect(tab.panes?.kind).toBe("split");
    const shape =
      tab.panes && tab.panes.kind === "split"
        ? tab.panes.children.map((c) => c.kind)
        : [];
    expect(shape).toEqual(["leaf", "leaf"]);
  });

  it("keeps the digit away from the terminal while it is up", async () => {
    await show(true);
    await press("7");
    expect(reachedTerminal, "a picked digit must not also reach the shell").toEqual(
      []
    );
  });

  it("leaves ⌘1…9 to the shortcut table it belongs to", async () => {
    await show(true);
    // The jump-to-tab row answers ⌘1…9 whether or not this picker is up. A
    // direct dial that took the digit regardless of modifiers would swallow
    // nine bindings for as long as the picker was open.
    const prevented = await press("2", { metaKey: true });
    expect(tabs(), "⌘2 must not have opened an entry").toEqual([]);
    // Whether the jump itself did anything is the shortcut table's business
    // (there are no tabs to jump to here); what this asserts is that the
    // picker did not answer it.
    expect(prevented || tabs().length === 0).toBe(true);
  });
});

describe("the same digits with the picker closed", () => {
  it("hands the digit to the terminal instead of opening anything", async () => {
    // Open, then closed — so this is the same window, the same handler set
    // and the same key as the passing case above, differing only in the one
    // thing the requirement is about.
    await show(true);
    await show(false);
    reachedTerminal = [];

    const prevented = await press("7");

    // ① Nothing was opened. An implementation with the digits in the global
    //    key table opens `deploy` here.
    expect(tabs(), "a closed picker must open nothing").toEqual([]);
    // ② The key reached the terminal, un-swallowed. This is the assertion
    //    that fails for a global-key implementation even if it somehow
    //    opened nothing: the digit would still have been taken.
    expect(reachedTerminal.map((e) => e.key)).toEqual(["7"]);
    expect(prevented, "the digit must arrive as a digit").toBe(false);
    expect(reachedTerminal[0].prevented).toBe(false);
  });

  it("hands over every digit the picker would have claimed", async () => {
    await show(true);
    await show(false);
    reachedTerminal = [];
    for (let n = 1; n <= DIRECT_KEYS; n++) {
      expect(await press(String(n))).toBe(false);
    }
    expect(reachedTerminal.map((e) => e.key)).toEqual(
      Array.from({ length: DIRECT_KEYS }, (_, i) => String(i + 1))
    );
    expect(tabs()).toEqual([]);
  });
});

describe("the shortcut table is left alone", () => {
  it("holds no bare digit, so nothing global answers one", async () => {
    // The other half of "modal scope": not only does the picker release the
    // digits when it closes, nothing else in the app ever claimed them. Read
    // from the composed table, so a row added to src/shortcuts.json with a
    // bare digit fails here rather than in a shell three months later.
    const bare = keyBindings()
      .list.filter((row) => typeof row.keys === "string")
      .map((row) => ({ row, chord: parseChord(row.keys as string) }))
      .filter(
        ({ chord }) =>
          chord !== null &&
          chord.key.length === 1 &&
          chord.key >= "0" &&
          chord.key <= "9" &&
          !chord.cmd &&
          !chord.ctrl &&
          !chord.alt
      )
      .map(({ row }) => `${String(row.command)} on ${row.keys}`);
    expect(bare, "bare digits in the shortcut table").toEqual([]);
  });
});

describe("which key names which entry", () => {
  it("is 1…9 and nothing else", () => {
    const plain = { meta: false, ctrl: false, alt: false };
    expect(directIndex("1", plain)).toBe(0);
    expect(directIndex("9", plain)).toBe(DIRECT_KEYS - 1);
    // Zero is not a place in a list that starts at one, and a letter is a
    // letter.
    expect(directIndex("0", plain)).toBeNull();
    expect(directIndex("a", plain)).toBeNull();
    expect(directIndex("Enter", plain)).toBeNull();
  });

  it("declines a digit that arrives with a modifier", () => {
    // Each modifier on its own, because each one belongs to something else:
    // ⌘1…9 jumps to a tab, and ⌃/⌥ digits are the terminal's to interpret.
    expect(directIndex("1", { meta: true, ctrl: false, alt: false })).toBeNull();
    expect(directIndex("1", { meta: false, ctrl: true, alt: false })).toBeNull();
    expect(directIndex("1", { meta: false, ctrl: false, alt: true })).toBeNull();
  });
});
