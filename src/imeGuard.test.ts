import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


vi.mock("./platform", async (original) => ({
  ...(await original<typeof import("./platform")>()),
  // Pinned to macOS, as `localKeys.test.ts` pins it: the chords below are
  // ⌘-chords, and on a platform where Ctrl is the command modifier they
  // would be spelling something else.
  IS_MAC: true,
  isCommandModifier: (e: { metaKey: boolean }) => e.metaKey,
}));

import { NewTabMenu } from "./components/NewTabMenu";
import {
  filesKeyAction,
  onLocalKeys,
  terminalKeyAction,
  type FilesKeyAction,
  type TerminalKeyAction,
} from "./localKeys";
import { useGlobalKeys } from "./keys";
import { setKeyOverrides } from "./shortcuts";
import { useStore, visibleOrdered, withPresetGroups } from "./state/store";
import {
  BOOT_CONFIG_KEY,
  DEMO_SCHEMA_KEY,
  type ConfigValues,
} from "./state/config";

const w = () => window as unknown as Record<string, unknown>;

/** Enough config for the ⌘N picker to mount with no profiles or templates. */
const CONFIG: ConfigValues = {
  appearance: { theme: "light", sidebar_width: 301, sidebar_pinned: false },
  browser: {
    search_engine: "duckduckgo",
    custom_search_template: "",
    archive_after: "24h",
  },
  terminal: { profiles: [], templates: [] },
};

/** A keydown with exactly the fields a platform's composition shape fills. */
function keydown(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(e);
  return e;
}

/* ------------------------------------------------------------------ *
 * The local entrance: onLocalKeys answers nothing mid-composition.
 * ------------------------------------------------------------------ */

let release: (() => void) | null = null;

function watchTerminal(): TerminalKeyAction[] {
  const seen: TerminalKeyAction[] = [];
  release = onLocalKeys(terminalKeyAction, (a) => seen.push(a));
  return seen;
}

function watchFiles(): FilesKeyAction[] {
  const seen: FilesKeyAction[] = [];
  release = onLocalKeys(filesKeyAction, (a) => seen.push(a));
  return seen;
}

describe("the local entrance during composition", () => {
  afterEach(() => {
    release?.();
    release = null;
  });

  it("answers none of the three platform shapes, then answers the plain key", () => {
    const seen = watchTerminal();

    // ⌘F is the terminal's own find — the same chord, in all three shapes.
    keydown({ key: "f", metaKey: true, isComposing: true });
    keydown({ key: "Process", keyCode: 229, metaKey: true });
    keydown({ key: "f", metaKey: true, keyCode: 229 });
    expect(seen).toEqual([]);

    // The control, asserted BETWEEN the presses (a guard that answered
    // nothing at all would pass the half above as happily as the real one).
    keydown({ key: "f", metaKey: true });
    expect(seen).toEqual([{ command: "find" }]);
  });

  it("holds the explorer's save back the same way", () => {
    const seen = watchFiles();

    keydown({ key: "s", metaKey: true, isComposing: true });
    expect(seen).toEqual([]);

    keydown({ key: "s", metaKey: true });
    expect(seen).toEqual([{ command: "save-file" }]);
  });

 it("keeps ⌘↑/⌘↓ answering mid-composition — the one exception", () => {
    const seen = watchTerminal();

    // Scroll top then bottom, pressed as Windows delivers them
    // mid-composition: real arrows, ⌘ held, isComposing set. Without the
    // cmdArrow exception both presses vanish into the guard and this fails.
    keydown({ key: "ArrowUp", metaKey: true, isComposing: true });
    expect(seen).toEqual([{ command: "scroll-end", dir: -1 }]);
    keydown({ key: "ArrowDown", metaKey: true, isComposing: true });
    expect(seen).toEqual([
      { command: "scroll-end", dir: -1 },
      { command: "scroll-end", dir: 1 },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The global entrance: useGlobalKeys, mounted exactly as the app mounts
 * it — always up, with the ⌘N picker beside it only while it is open.
 * ------------------------------------------------------------------ */

/**
 * The app's own arrangement (App.tsx): the global handler lives for the
 * window's whole life; the picker is drawn on `newTabMenuOpen` and mounts
 * its own window listener only while it exists.
 */
function Harness() {
  useGlobalKeys();
  const open = useStore((s) => s.newTabMenuOpen);
  return open ? createElement(NewTabMenu) : null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountHarness(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const el = host;
  await act(async () => {
    root = createRoot(el);
    root.render(createElement(Harness));
  });
  // The profile list arrives over a promise; let it land so the picker is
  // drawing the entries its digits address.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Press on the window inside act, so store writes land before asserting. */
function press(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

async function tabsOf(count: number): Promise<string[]> {
  const st = useStore.getState();
  let ids: string[] = [];
  await act(async () => {
    ids = Array.from({ length: count }, () =>
      st.addTab({ type: "terminal" })
    );
    useStore.setState({ activeTabId: ids[0] });
  });
  return ids;
}

/** The sidebar's own answer to "which tab is the n-th row". */
function visibleIds(): string[] {
  const s = useStore.getState();
  return visibleOrdered(s.tabs, s.groups, s.split).map((t) => t.id);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  w()[BOOT_CONFIG_KEY] = CONFIG;
  w()[DEMO_SCHEMA_KEY] = [];
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    peekTabId: null,
    selectedTabIds: [],
    newTabMenuOpen: false,
    menu: null,
  });
});

afterEach(() => {
  if (root && host) {
    const done = root;
    act(() => done.unmount());
    host.remove();
  }
  root = null;
  host = null;
  setKeyOverrides({});
  delete w()[BOOT_CONFIG_KEY];
  delete w()[DEMO_SCHEMA_KEY];
});

describe("the global entrance: a composition-cancel Escape is not the app's", () => {
  it("does not discard the peek nor clear the selection (keys.ts's two unguarded branches)", async () => {
    await mountHarness();
    const [t0, t1, t2] = await tabsOf(3);
    useStore.setState({ peekTabId: t1, selectedTabIds: [t2] });

    // Both composition shapes of the Escape that cancels an input method:
    // Windows delivers the real key with isComposing; some platforms mark
    // it 229 instead.
    const win = press({ key: "Escape", isComposing: true });
    const mac = press({ key: "Escape", keyCode: 229 });
    for (const e of [win, mac]) {
      expect(e.defaultPrevented, "the key must be let through").toBe(false);
    }
    const st = useStore.getState();
    expect(st.peekTabId, "the peek survives a composition cancel").toBe(t1);
    expect(st.tabs.map((t) => t.id), "the peeked tab is still a tab").toContain(
      t1
    );
    expect(st.selectedTabIds).toEqual([t2]);

    // The controls: the same Escape outside composition does both jobs —
    // and the peek branch DROPS the tab, which is what makes its survival
    // above a real assertion rather than a restatement.
    press({ key: "Escape" });
    expect(useStore.getState().peekTabId).toBeNull();
    expect(useStore.getState().tabs.map((t) => t.id)).not.toContain(t1);

    useStore.setState({ peekTabId: null, selectedTabIds: [t2] });
    press({ key: "Escape" });
    expect(useStore.getState().selectedTabIds).toEqual([]);

    // Nothing above may have moved the keyboard either: the first tab held
    // it the whole time.
    expect(useStore.getState().activeTabId).toBe(t0);
  });
});

describe("the global entrance: a composition digit opens nothing", () => {
  it("does not jump on a ⌘digit mid-composition, with the picker up", async () => {
    await mountHarness();
    const [t0, t1, t2] = await tabsOf(3);
    // Tabs first, THEN the picker: addTab closes the picker (store.ts sets
    // newTabMenuOpen false on every add), so mounting it first would have
    // it unmounted again by the time the keys are pressed.
    await act(async () => {
      useStore.setState({ newTabMenuOpen: true });
    });

    // ⌘n addresses the n-th VISIBLE row (the same reading activateIndex
    // makes), so the digit this test presses is read off the real order
    // rather than assumed: it names the first row that is not the active
    // tab, wherever the prepend put it.
    const at = visibleIds().findIndex((id) => id !== t0);
    expect(at).toBeGreaterThanOrEqual(0);
    const digit = String(at + 1);

    press({ key: digit, metaKey: true, isComposing: true });
    press({ key: digit, metaKey: true, keyCode: 229 });
    let st = useStore.getState();
    expect([...st.tabs.map((t) => t.id)].sort()).toEqual([t0, t1, t2].sort());
    expect(st.tabs).toHaveLength(3);
    expect(st.activeTabId, "no jump out of a composition").toBe(t0);
    expect(st.newTabMenuOpen, "the picker stays up").toBe(true);

    // The control: the same chord outside composition jumps — and the
    // picker's digits decline modifiers, so the jump is the only reader.
    press({ key: digit, metaKey: true });
    st = useStore.getState();
    expect(st.activeTabId, "the plain chord must still jump").toBe(
      visibleIds()[at]
    );
    expect(st.newTabMenuOpen).toBe(true);
  });

  it("opens nothing for the macOS shape (keyCode 229, key Process)", async () => {
    useStore.setState({ newTabMenuOpen: true });
    await mountHarness();

    press({ key: "Process", keyCode: 229 });

    const st = useStore.getState();
    expect(st.tabs).toEqual([]);
    expect(st.newTabMenuOpen).toBe(true);
  });

  // The picker's own listener is a SIBLING of the two capture entrances,
  // not downstream of them — the entrances' guard deliberately lets a
  // composing key through, and what it is let through to includes that
  // listener. So the picker carries the same one-line sentence itself
  // (NewTabMenu.tsx), and this is the ordinary test that it works: a bare
  // digit in the Windows composition shape opens nothing and keeps the
  // picker up. It began life as an it.fails tripwire while the fix sat
  // outside a change's boundary; the flip to green is the fix's proof.
  it("holds the picker's bare digit back in the Windows shape", async () => {
    useStore.setState({ newTabMenuOpen: true });
    await mountHarness();

    press({ key: "3", isComposing: true });

    const st = useStore.getState();
    expect(st.tabs, "no entry may open out of a composition").toEqual([]);
    expect(st.newTabMenuOpen, "and the picker must stay up").toBe(true);
  });
});

describe("the cmdArrow exception at the global entrance", () => {
  it("keeps a chord the user moved onto ⌘↑ reachable mid-composition", async () => {
    await mountHarness();
    // ⌘↑ ships as the terminal's command-blocks row (local, so the global
    // index never sees it) — to give the GLOBAL entrance something to answer
    // on that key, move a global command onto it. The exception is then the
    // only difference between "answers" and "swallows".
    setKeyOverrides({ "new-terminal": "⌘↑" });
    const [t0, t1] = await tabsOf(2);
    expect(useStore.getState().tabs).toHaveLength(2);

    press({ key: "ArrowUp", metaKey: true, isComposing: true });

    const st = useStore.getState();
    expect(
      st.tabs,
      "the exception let the command through"
    ).toHaveLength(3);
    const ids = st.tabs.map((t) => t.id);
    expect(ids).toContain(t0);
    expect(ids).toContain(t1);
  });
});
