import { create } from "zustand";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppStore, sessionSnapshot, type AppStore } from "./store";
import {
  applyMirrorAction,
  MIRROR_ACTIONS,
  resetMirrorStore,
  setMirrorStore,
} from "./mirrorActions";
import {
  applyMirrorSnapshot,
  configureRemoteTabContributions,
  resetRemoteMirror,
  useRemoteMirrorStore,
} from "@tabverse/runtime-remote/app-mirror";
import { createRemoteTestContributions } from "@tabverse/test-runtime";
import {
  installMirrorBroadcast,
  wireArgsFor,
  type ActionSender,
  type ProvenanceGen,
} from "./mirrorBroadcast";

/** Both sides are zero-trace runs: no session inherited, none written. */
beforeEach(() => {
  localStorage.clear();
  configureRemoteTabContributions(createRemoteTestContributions());
  resetRemoteMirror();
});

afterEach(() => {
  resetMirrorStore();
});

/** Pinned provenance: ids and clocks the assertions can name. Fresh per
 * test so the counts in one test cannot leak into another's expectation. */
let idSeq = 0;
let clock = 0;
const pinnedGen = (): ProvenanceGen => ({
  id: () => `host-${++idSeq}`,
  now: () => (clock += 60),
});

/** A real second store — the same factory the app's singleton uses. */
const newStore = () =>
  create<AppStore>()((set, get) => createAppStore(set, get));

/** One recorded broadcast: the name and the wire args, in order. */
interface Sent {
  name: string;
  args: unknown;
}

/**
 * The host/joiner pair with everything wired: the host's whitelisted
 * actions broadcast into `sent`, and the mirror is pointed at the joiner
 * so replays land there — the wire from a host store to an independent
 * joiner store, minus only the Tauri pipe. `replay()` is the joiner's
 * half: consume the recorded frames in order.
 */
function makePair() {
  const host = newStore();
  const join = newStore();
  const sent: Sent[] = [];
  const send: ActionSender = (name, args) => sent.push({ name, args });
  const restore = installMirrorBroadcast(host, pinnedGen(), send);
  setMirrorStore(join);
  // The joiner consumes each frame once, the way a socket would; a second
  // call picks up only what arrived since (replaying the whole log again
  // would duplicate every create).
  let consumed = 0;
  return {
    host,
    join,
    sent,
    restore,
    replay: () => {
      for (; consumed < sent.length; consumed++) {
        applyMirrorAction(sent[consumed].name, sent[consumed].args);
      }
    },
  };
}

/** The mirror's own contract, as one comparable shape: the snapshot fields
 * plus the UI state a replay touches. */
const coreOf = (s: AppStore) => ({
  tabs: s.tabs.map((t) => ({ ...t })),
  groups: s.groups,
  activeTabId: s.activeTabId,
  split: s.split,
  menu: s.menu,
  sidebarPinned: s.sidebarPinned,
  sidebarPeeking: s.sidebarPeeking,
});

describe("app-share determinism: one sequence, two stores, zero diff", () => {
  it("the full first-batch sequence replays to an identical core state", () => {
    const { host, join, replay } = makePair();
    const h = host.getState();
    const t1 = h.addTab({ type: "terminal" });
    const t2 = h.addTab({ type: "files", cwd: "/tmp" });
    h.activateTab(t2);
    h.toggleSidebar();
    h.setSidebarPeeking(true);
    h.openMenu(t1, 10, 20);
    h.closeMenu();
    h.openMenu(t2, 5, 5);
    const third = h.addTab({ type: "browser", url: "https://example.com" });
    h.activateTab(t1);
    h.splitWith(third);
    h.activateTab(t2);
    h.closeTab(t2);

    replay();

    expect(coreOf(join.getState())).toEqual(coreOf(host.getState()));
    // The three claims that matter most, named rather than implied by the
    // diff: the host's ids, the host's titles (its counter, not the
    // joiner's), and the host's stamps.
    expect(join.getState().tabs.map((t) => t.id)).toEqual(
      host.getState().tabs.map((t) => t.id)
    );
    expect(join.getState().tabs.map((t) => t.title)).toEqual(
      host.getState().tabs.map((t) => t.title)
    );
    expect(
      join.getState().tabs.every((t) => t.lastActiveAt !== undefined)
    ).toBe(true);
    // The split is real on both ends, so the split assertion above was
    // comparing layouts, not null with null.
    expect(host.getState().split).not.toBeNull();
    expect(join.getState().split).toEqual(host.getState().split);
  });

  it("unsplit and a second toggle replay with the same evenness", () => {
    const { host, join, replay } = makePair();
    const h = host.getState();
    const a = h.addTab({ type: "terminal" });
    const b = h.addTab({ type: "files" });
    h.activateTab(a);
    h.splitWith(b);
    h.toggleSidebar();

    replay();
    expect(coreOf(join.getState())).toEqual(coreOf(host.getState()));

    // The sequence continues AFTER a first converged replay — the pair is
    // still wired, still in sync, not reset by the first flush.
    h.unsplit();
    h.unsplit(); // idempotence on both ends
    h.activateTab(b);

    replay();
    expect(coreOf(join.getState())).toEqual(coreOf(host.getState()));
    expect(host.getState().split).toBeNull();
  });

  it("replay is what closes the gap: without it the stores differ", () => {
    const { host, join, sent } = makePair();
    const t = host.getState().addTab({ type: "terminal" });

    expect(sent).toHaveLength(1);
    // No replay ran: the joiner never learned the host's tab.
    expect(join.getState().tabs).toHaveLength(0);
    expect(coreOf(join.getState())).not.toEqual(coreOf(host.getState()));

    applyMirrorAction(sent[0].name, sent[0].args);
    expect(join.getState().tabs.map((x) => x.id)).toEqual([t]);
  });

  it("a mid-stream snapshot reconciles a diverged joiner back to the host", () => {
    const { host, replay } = makePair();
    const h = host.getState();
    const t1 = h.addTab({ type: "terminal" });
    h.activateTab(t1);
    replay();

    applyMirrorSnapshot(sessionSnapshot(host.getState()));

    // The joiner drifts the way only a local writer can (the join page's
    // optimistic layer, or a bug): a row the host never made.
    const remote = useRemoteMirrorStore.getState();
    const junk = { ...remote.tabs[0], id: "local-junk", title: "Junk" };
    useRemoteMirrorStore.setState({ tabs: [...remote.tabs, junk] });
    expect(useRemoteMirrorStore.getState().tabs).toHaveLength(2);

    h.addTab({ type: "files" });
    applyMirrorSnapshot(sessionSnapshot(host.getState()));
    expect(useRemoteMirrorStore.getState().tabs.map((t) => t.id)).toEqual(
      host.getState().tabs.map((t) => t.id)
    );
  });
});

describe("the broadcast wrapper's own behavior", () => {
  it("keeps every Settings tab, group, menu, rename, activate, and close action off the wire", () => {
    const host = newStore();
    const sent: Sent[] = [];
    const restore = installMirrorBroadcast(
      host,
      pinnedGen(),
      (name, args) => sent.push({ name, args })
    );
    try {
      const settings = host.getState().addTab({ type: "settings" });
      expect(sent).toEqual([]);
      host.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === settings ? { ...tab, groupId: "settings-private" } : tab
        ),
        groups: [
          ...state.groups,
          {
            id: "settings-private",
            name: "PRIVATE_SETTINGS_GROUP",
            colorIndex: 0,
            collapsed: false,
          },
        ],
      }));
      host.getState().activateTab(settings);
      host.getState().openMenu(settings, 1, 2);
      host.getState().renameTab(settings, "PRIVATE_SETTINGS_TITLE");
      host.getState().toggleGroupCollapsed("settings-private");
      host.getState().closeTab(settings);
      expect(sent).toEqual([]);
    } finally {
      restore();
    }
  });

  it("embeds read-back provenance: the host's id, title and stamp", () => {
    const host = newStore();
    const sent: Sent[] = [];
    const restore = installMirrorBroadcast(
      host,
      pinnedGen(),
      (name, args) => sent.push({ name, args })
    );
    try {
      const t = host.getState().addTab({ type: "terminal" });
      const created = host.getState().tabs[0];
      expect(sent[0]).toEqual({
        name: "addTab",
        args: {
          type: "terminal",
          id: t,
          // The title is whatever the host's own counter produced (the
          // module counter is shared across tests, so only equality with
          // the row itself is a stable claim).
          title: created.title,
          groupId: null,
          lastActiveAt: created.lastActiveAt,
        },
      });

      host.getState().activateTab(t);
      expect(sent[1]).toEqual({
        name: "activateTab",
        args: { id: t, now: host.getState().tabs[0].lastActiveAt },
      });

      host.getState().openMenu(t, 1, 2);
      host.getState().closeMenu();
      host.getState().toggleSidebar();
      expect(sent.slice(2)).toEqual([
        { name: "openMenu", args: { tabId: t, x: 1, y: 2 } },
        { name: "closeMenu", args: null },
        { name: "toggleSidebar", args: null },
      ]);
    } finally {
      restore();
    }
  });

  it("restore unwraps: after it, actions run but nothing is sent", () => {
    const host = newStore();
    const sent: Sent[] = [];
    const restore = installMirrorBroadcast(
      host,
      pinnedGen(),
      (name, args) => sent.push({ name, args })
    );
    host.getState().addTab({ type: "terminal" });
    expect(sent).toHaveLength(1);

    restore();
    host.getState().addTab({ type: "terminal" });
    expect(sent).toHaveLength(1);
    expect(host.getState().tabs).toHaveLength(2);
  });

  it("never wraps actions outside the shared table", () => {
    const host = newStore();
    const sent: Sent[] = [];
    const restore = installMirrorBroadcast(
      host,
      pinnedGen(),
      (name, args) => sent.push({ name, args })
    );
    try {
      const h = host.getState();
      const a = h.addTab({ type: "terminal" });
      sent.length = 0; // the add itself is whitelisted; start clean
      h.setTabTitle(a, "Renamed");
      h.moveTab(a, null);
      expect(sent).toEqual([]);
    } finally {
      restore();
    }
  });

  it("wireArgsFor drops shapes the mirror would refuse", () => {
    const gen = pinnedGen();
    expect(wireArgsFor("addTab", { args: [42], gen })).toBeUndefined();
    expect(wireArgsFor("closeTab", { args: [7], gen })).toBeUndefined();
    expect(
      wireArgsFor("openMenu", { args: ["t", "x", 2], gen })
    ).toBeUndefined();
    // Degraded addTab (no read-back) still carries generated provenance.
    expect(wireArgsFor("addTab", { args: [{ type: "browser" }], gen })).toEqual({
      type: "browser",
      id: "host-1",
      lastActiveAt: 60,
    });
  });
});

it("activateIndex (the host's ⌘1…9 path) reaches wrapped activateTab and broadcasts it", () => {
  const host = newStore();
  const sent: Sent[] = [];
  const restore = installMirrorBroadcast(
    host,
    pinnedGen(),
    (name, args) => sent.push({ name, args })
  );
  try {
    host.getState().addTab({ type: "terminal" });
    host.getState().addTab({ type: "terminal" });
    sent.length = 0;
    // This is runAppCommand("jump-1")'s actual path, not a direct
    // activateTab call: it proves the wrapper survives get().activateTab.
    host.getState().activateIndex(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe("activateTab");
    expect((sent[0].args as { id: string }).id).toBe(
      host.getState().activeTabId
    );
  } finally {
    restore();
  }
});

describe("the host side of the action seam: a viewer's action lands through the same table", () => {
  it("a viewer's addTab runs the host store's addTab and broadcasts host provenance", () => {
    const host = newStore();
    const sent: Sent[] = [];
    const restore = installMirrorBroadcast(
      host,
      pinnedGen(),
      (name, args) => sent.push({ name, args })
    );
    setMirrorStore(host);
    try {
      const applied = applyMirrorAction("addTab", { type: "terminal" });
      expect(applied).toBe(true);
      expect(host.getState().tabs).toHaveLength(1);
      expect(host.getState().tabs[0].type).toBe("terminal");
      // The confirmation every viewer waits for: one frame, with the id
      // and stamp the HOST generated (read back from the created row —
      // the viewer supplied neither).
      expect(sent).toHaveLength(1);
      expect(sent[0].name).toBe("addTab");
      const wire = sent[0].args as {
        type: string;
        id: string;
        lastActiveAt: number;
      };
      expect(wire.type).toBe("terminal");
      expect(wire.id).toBe(host.getState().tabs[0].id);
      expect(typeof wire.id).toBe("string");
      expect(typeof wire.lastActiveAt).toBe("number");
    } finally {
      restore();
    }
  });

  it("a name outside the table is refused and the host store is untouched", () => {
    const host = newStore();
    setMirrorStore(host);
    expect(applyMirrorAction("fs_write", { path: "/tmp/x", content: "" })).toBe(
      false
    );
    expect(applyMirrorAction("setTheme", "neon")).toBe(false);
    expect(host.getState().tabs).toHaveLength(0);
    expect(host.getState().activeTabId).toBeNull();
  });
});

describe("the whitelist's full key set (the fold-loss regression)", () => {
  // An edit to the table once dropped `toggleGroupCollapsed` silently: the
  // host logged "not whitelisted" and the folder never folded in the field.
  // The exact key set is therefore asserted, not implied by per-entry tests.
  it("carries every whitelisted name — losing one is a red test, not a field report", () => {
    expect(Object.keys(MIRROR_ACTIONS).sort()).toEqual([
      "activateTab",
      "addTab",
      "closeMenu",
      "closeTab",
      "openMenu",
      "renameTab",
      "setFilesOpenDir",
      "setFilesOpenPath",
      "setSidebarPeeking",
      "splitWith",
      "toggleGroupCollapsed",
      "toggleSidebar",
      "unsplit",
    ]);
  });
});
