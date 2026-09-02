import type { ShareViewer } from "../../state/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The actions gate is the capability registry, not a type check, and what
 * crosses the command boundary is the tab id plus an access level. Each test
 * rebuilds the module graph with the Tauri marker set before anything reads
 * it, and with the shipped declarations registered the way bootstrap does.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

async function fresh() {
  vi.resetModules();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  await import("../capabilities");
  const { useStore } = await import("../../state/store");
  const actions = await import("./actions");
  useStore.setState({ tabs: [], activeTabId: null });
  return { useStore, actions };
}

/** The browser-demo module graph: no Tauri marker, so every action takes its
 * mock branch and nothing may cross the command boundary. */
async function freshDemo() {
  vi.resetModules();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  await import("../capabilities");
  const { useStore } = await import("../../state/store");
  const actions = await import("./actions");
  useStore.setState({ tabs: [], activeTabId: null });
  return { useStore, actions };
}

/** The share_start calls made so far, ignoring persistence traffic. */
function shareStartCalls() {
  return mocks.invoke.mock.calls.filter(([cmd]) => cmd === "share_start");
}

/** Commands other than the store's independent deferred persistence write. */
function nonPersistenceCalls() {
  return mocks.invoke.mock.calls.filter(([cmd]) => cmd !== "state_save");
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "share_start" || cmd === "app_share_start")
      return { shareId: "share-1", ticket: "tabv-abc" };
    return undefined;
  });
});

describe("startShare's gate", () => {
  it("refuses a Settings tab with its declared reason, before any command", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "settings" });
    await expect(actions.startShare(id)).rejects.toThrow(
      "settings tabs cannot be shared"
    );
    expect(shareStartCalls()).toHaveLength(0);
  });

  it("refuses a level the type never declared, before any command", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    // Terminals declare view and steer only; approve exists, but not here.
    await expect(actions.startShare(id, { access: "approve" })).rejects.toThrow(
      /cannot be shared at "approve"/
    );
    expect(shareStartCalls()).toHaveLength(0);
  });
});

describe("startShare on a shareable tab", () => {
  it("uses the contribution adapter default steer permission for Browser", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "browser" });
    const browserUrl = useStore.getState().tabs.find((tab) => tab.id === id)?.url;
    await actions.startShare(id);
    expect(shareStartCalls()[0][1]).toMatchObject({
      tabId: id,
      kind: "browser",
      browserUrl,
      access: "steer",
    });
  });

  it("invokes share_start with the tab id and the declared default level", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    await actions.startShare(id);
    expect(shareStartCalls()).toHaveLength(1);
    const [, args] = shareStartCalls()[0];
    expect(args).toMatchObject({
      tabId: id,
      kind: "terminal",
      ttlSecs: actions.SHARE_TTL_SECS,
      access: "steer", // the terminal declaration's default
    });
  });

  it("carries an explicitly chosen level through to the command and the store", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    await actions.startShare(id, { access: "view" });
    const [, args] = shareStartCalls()[0];
    expect(args).toMatchObject({ tabId: id, access: "view" });
    expect(useStore.getState().tabs.find((t) => t.id === id)?.share?.access).toBe(
      "view"
    );
  });

  it("carries a chosen join window through to the command and the store", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    await actions.startShare(id, { ttlSecs: 3_600 });
    const [, args] = shareStartCalls()[0];
    expect(args).toMatchObject({ tabId: id, ttlSecs: 3_600 });
    expect(
      useStore.getState().tabs.find((t) => t.id === id)?.share?.ttlSecs
    ).toBe(3_600);
  });

  it("carries the explicit no-expiry window (null) as null, not as a default", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    await actions.startShare(id, { ttlSecs: null });
    const [, args] = shareStartCalls()[0];
    // share_start's ttl_secs is Option<u64>: null means the join window
    // never closes. It must reach the wire as null — a fallback to 24h here
    // would silently rewrite the user's choice.
    expect(args).toMatchObject({ tabId: id, ttlSecs: null });
    expect(
      useStore.getState().tabs.find((t) => t.id === id)?.share?.ttlSecs
    ).toBe(null);
  });

  it("stores the unified share state: link, default level, empty roster, ttl", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    const before = Date.now();
    await actions.startShare(id);
    const share = useStore.getState().tabs.find((t) => t.id === id)?.share;
    expect(share).toMatchObject({
      shareId: "share-1",
      ticket: "tabv-abc",
      joinLink: "https://spalagu.github.io/Tabverse/join/#tabv-abc",
      access: "steer",
      viewers: [],
      ttlSecs: actions.SHARE_TTL_SECS,
    });
    expect(share!.startedAt).toBeGreaterThanOrEqual(before);
  });

  it("setViewerAccess carries tab, viewer and level to the command", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    await actions.startShare(id);
    await actions.setViewerAccess(id, 7, "view");
    const call = mocks.invoke.mock.calls.find(
      ([cmd]) => cmd === "share_set_viewer_access"
    );
    expect(call?.[1]).toEqual({ tabId: id, viewerId: 7, access: "view" });
    // The roster is NOT written optimistically: the presence event — fired by
    // the hub after it applied the change — is the one writer, so the store
    // never claims a level the host has not actually enforced.
    expect(
      useStore.getState().tabs.find((t) => t.id === id)?.share?.viewers
    ).toEqual([]);
  });

  it("setViewerAccess refuses a tab that is not sharing, before any command", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    await expect(actions.setViewerAccess(id, 7, "view")).rejects.toThrow(
      "tab is not shared"
    );
    expect(
      mocks.invoke.mock.calls.some(([cmd]) => cmd === "share_set_viewer_access")
    ).toBe(false);
  });

  it("setViewerAccess refuses a level the type never declared, before any command", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    await actions.startShare(id);
    // Terminals declare view and steer only; approve exists, but not here.
    await expect(actions.setViewerAccess(id, 7, "approve")).rejects.toThrow(
      /cannot grant "approve"/
    );
    expect(
      mocks.invoke.mock.calls.some(([cmd]) => cmd === "share_set_viewer_access")
    ).toBe(false);
  });

  it("stopShare clears the tab's share through share_stop", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    await actions.startShare(id);
    await actions.stopShare(id);
    expect(
      mocks.invoke.mock.calls.some(([cmd]) => cmd === "share_stop")
    ).toBe(true);
    expect(useStore.getState().tabs.find((t) => t.id === id)?.share).toBe(
      undefined
    );
  });
});

describe("the browser demo (no Tauri): fabricated share, no commands", () => {
  it("startShare fabricates a share with a two-viewer roster at distinct levels", async () => {
    const { useStore, actions } = await freshDemo();
    const id = useStore.getState().addTab({ type: "terminal" });
    await actions.startShare(id);
    const share = useStore.getState().tabs.find((t) => t.id === id)?.share;
    expect(share).toBeDefined();
    expect(share!.viewers).toHaveLength(2);
    expect(share!.viewers.map((v) => v.name)).toEqual([
      "tabverse@demo-mac",
      "Safari (web)",
    ]);
    // Two different levels, both from the terminal's declared pair.
    expect(share!.viewers[0].access).not.toBe(share!.viewers[1].access);
    for (const v of share!.viewers) {
      expect(["view", "steer"]).toContain(v.access);
    }
    expect(share!.joinLink.endsWith(`#${share!.ticket}`)).toBe(true);
    expect(nonPersistenceCalls()).toHaveLength(0);
  });

  it("still refuses undeclared levels — the demo is not a laxer gate", async () => {
    const { useStore, actions } = await freshDemo();
    const id = useStore.getState().addTab({ type: "terminal" });
    await expect(actions.startShare(id, { access: "approve" })).rejects.toThrow(
      /cannot be shared at "approve"/
    );
  });

  it("setViewerAccess and kickViewer rewrite the fabricated roster in place", async () => {
    const { useStore, actions } = await freshDemo();
    const id = useStore.getState().addTab({ type: "terminal" });
    await actions.startShare(id);
    const roster = () =>
      useStore.getState().tabs.find((t) => t.id === id)!.share!.viewers;
    const second = roster()[1];
    await actions.setViewerAccess(id, second.id, "steer");
    expect(roster().find((v) => v.id === second.id)?.access).toBe("steer");
    await expect(actions.kickViewer(id, second.id)).resolves.toBe(true);
    expect(roster().some((v) => v.id === second.id)).toBe(false);
    await actions.stopShare(id);
    expect(useStore.getState().tabs.find((t) => t.id === id)?.share).toBe(
      undefined
    );
    expect(nonPersistenceCalls()).toHaveLength(0);
  });
});

describe("the whole-app share", () => {
  it("startAppShare invokes app_share_start with steer and the 24h window, addressing no tab", async () => {
    const { useStore, actions } = await fresh();
    await actions.startAppShare();
    const call = mocks.invoke.mock.calls.find(
      ([cmd]) => cmd === "app_share_start"
    );
    expect(call?.[1]).toEqual({
      ttlSecs: actions.SHARE_TTL_SECS,
      access: "steer",
    });
    expect(useStore.getState().appShare).toMatchObject({
      shareId: "share-1",
      ticket: "tabv-abc",
      joinLink: "https://spalagu.github.io/Tabverse/join/#tabv-abc",
      access: "steer",
      viewers: [],
      ttlSecs: actions.SHARE_TTL_SECS,
    });
  });

  it("startAppShare carries the chosen level and window; null means no expiry", async () => {
    const { useStore, actions } = await fresh();
    await actions.startAppShare({ access: "view", ttlSecs: null });
    const call = mocks.invoke.mock.calls.find(
      ([cmd]) => cmd === "app_share_start"
    );
    expect(call?.[1]).toEqual({ ttlSecs: null, access: "view" });
    expect(useStore.getState().appShare).toMatchObject({
      access: "view",
      ttlSecs: null,
    });
  });

  it("an undeclared level is refused before any command crosses", async () => {
    const { actions } = await fresh();
    await expect(
      actions.startAppShare({ access: "approve" })
    ).rejects.toThrow(/cannot be shared at "approve"/);
    expect(
      mocks.invoke.mock.calls.some(([cmd]) => cmd === "app_share_start")
    ).toBe(false);
  });

  it("a second start while one is live crosses no command boundary", async () => {
    const { actions } = await fresh();
    await actions.startAppShare();
    await actions.startAppShare();
    expect(
      mocks.invoke.mock.calls.filter(([cmd]) => cmd === "app_share_start")
    ).toHaveLength(1);
  });

  it("stopAppShare invokes app_share_stop and clears the app-level state", async () => {
    const { useStore, actions } = await fresh();
    await actions.startAppShare();
    await actions.stopAppShare();
    expect(
      mocks.invoke.mock.calls.some(([cmd]) => cmd === "app_share_stop")
    ).toBe(true);
    expect(useStore.getState().appShare).toBe(null);
  });

  it("presence routing: the fixed id 'app' feeds the app roster, a tab id its tab", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "terminal" });
    await actions.startShare(id);
    await actions.startAppShare();
    const far: ShareViewer = { id: 9, name: "tabverse@far", access: "steer" };
    actions.applySharePresence("app", [far]);
    expect(useStore.getState().appShare?.viewers).toEqual([far]);
    // The app event must not leak into the tab's roster, nor a tab's into
    // the app's — one channel, two rosters, the id decides which.
    expect(
      useStore.getState().tabs.find((t) => t.id === id)?.share?.viewers
    ).toEqual([]);
    const web: ShareViewer = { id: 4, name: "Safari (web)", access: "view" };
    actions.applySharePresence(id, [web]);
    expect(
      useStore.getState().tabs.find((t) => t.id === id)?.share?.viewers
    ).toEqual([web]);
    expect(useStore.getState().appShare?.viewers).toEqual([far]);
  });
});

describe("the whole-app share in the browser demo", () => {
  it("fabricates the share with the demo roster, crossing no command boundary", async () => {
    const { useStore, actions } = await freshDemo();
    await actions.startAppShare();
    const share = useStore.getState().appShare;
    expect(share).not.toBeNull();
    expect(share!.viewers).toHaveLength(2);
    expect(share!.joinLink.endsWith(`#${share!.ticket}`)).toBe(true);
    expect(nonPersistenceCalls()).toHaveLength(0);
    await actions.stopAppShare();
    expect(useStore.getState().appShare).toBe(null);
  });
});
