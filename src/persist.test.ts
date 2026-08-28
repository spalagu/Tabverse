import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The doorway picks its carrier at import time and keeps its debounce
 * buffers as module state, so every test starts from a fresh import — with
 * or without the Tauri marker on window — against a cleared carrier.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

type Persist = typeof import("./persist");

async function importPersist(tauri: boolean): Promise<Persist> {
  vi.resetModules();
  const w = window as unknown as Record<string, unknown>;
  if (tauri) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
  return await import("./persist");
}

/** Let chained promise callbacks (not timers) run to completion. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** In-memory stand-in for the Rust state_* commands. */
function fakeDisk() {
  const disk = new Map<string, string>();
  mocks.invoke.mockImplementation(async (cmd, args) => {
    const scope = args?.scope as string;
    switch (cmd) {
      case "state_save":
        disk.set(scope, args?.json as string);
        return;
      case "state_load":
        return disk.has(scope) ? disk.get(scope) : null;
      case "state_delete":
        disk.delete(scope);
        return;
      case "state_list":
        return [...disk.keys()];
      default:
        return; // js_log and friends
    }
  });
  return disk;
}

/** The state_* calls made so far, in order, ignoring log traffic. */
function stateCalls(): string[] {
  return mocks.invoke.mock.calls
    .map(([cmd]) => cmd)
    .filter((c) => c.startsWith("state_"));
}

beforeEach(() => {
  localStorage.clear();
  // Only the two functions the doorway uses: faking Date/performance breaks
  // vitest's own hook-duration accounting (hooks then "time out" instantly).
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mocks.invoke.mockReset();
});

afterEach(() => {
  vi.clearAllTimers(); // no dangling debounce leaks into the next test
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("browser-demo carrier (localStorage fallback)", () => {
  it("buffers a save, then lands it on the carrier after the debounce", async () => {
    const p = await importPersist(false);
    p.saveState("s", { v: 1 });
    expect(localStorage.getItem("tabverse.state.s")).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(JSON.parse(localStorage.getItem("tabverse.state.s")!)).toEqual({
      v: 1,
    });
  });

  it("serves the buffered value to loadState before the write lands", async () => {
    const p = await importPersist(false);
    p.saveState("s", { v: 2 });
    expect(await p.loadState("s")).toEqual({ v: 2 });
  });

  it("flushAll lands buffered writes without waiting for the timer", async () => {
    const p = await importPersist(false);
    p.saveState("s", { v: 3 });
    await p.flushAll();
    expect(JSON.parse(localStorage.getItem("tabverse.state.s")!)).toEqual({
      v: 3,
    });
  });

  it("deleteState cancels a buffered save and clears the carrier", async () => {
    const p = await importPersist(false);
    p.saveState("s", { v: 4 });
    await p.flushAll(); // now on the carrier
    p.saveState("s", { v: 5 }); // buffered again
    p.deleteState("s");
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(localStorage.getItem("tabverse.state.s")).toBeNull();
    expect(await p.loadState("s")).toBeNull();
  });

  it("returns null for a corrupt payload instead of throwing", async () => {
    const p = await importPersist(false);
    localStorage.setItem("tabverse.state.bad", "{ not json");
    expect(await p.loadState("bad")).toBeNull();
    expect(await p.loadStateResult("bad")).toEqual({ kind: "invalid-json" });
  });

  it("distinguishes a missing scope from a failed carrier read", async () => {
    const browser = await importPersist(false);
    expect(await browser.loadStateResult("missing")).toEqual({ kind: "missing" });

    const disk = fakeDisk();
    const desktop = await importPersist(true);
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "state_load" && args?.scope === "unreadable") {
        throw new Error("permission denied");
      }
      return base(cmd, args);
    });

    expect(await desktop.loadStateResult("unreadable")).toEqual({
      kind: "read-failed",
    });
    expect(disk.has("unreadable")).toBe(false);
  });


  it("listScopes sees the doorway's own keys, buffered or landed", async () => {
    const p = await importPersist(false);
    localStorage.setItem("tabverse.showHidden", "1"); // foreign key, not ours
    const tab = p.tabScope("files", "11111111-2222-4333-8444-555555555555");
    p.saveState("a", 1);
    p.saveState(tab, 2);
    // Buffered saves are already listed — cleanup must see them too.
    expect((await p.listScopes()).sort()).toEqual(["a", tab]);
    await p.flushAll();
    expect((await p.listScopes()).sort()).toEqual(["a", tab]);
  });

  it("refuses scope names the desktop carrier would reject", async () => {
    const p = await importPersist(false);
    for (const bad of ["tab.x", "a b", "path/like", "\u540d\u5b57", "x".repeat(121), ""]) {
      p.saveState(bad, { v: 1 }); // dropped, not thrown
      expect(await p.loadState(bad)).toBeNull();
      p.deleteState(bad); // harmless no-op
    }
    await p.flushAll();
    expect(await p.listScopes()).toEqual([]);
  });

  it("scopeTabId marks ownership by the uuid tail alone", async () => {
    const p = await importPersist(false);
    const id = "11111111-2222-4333-8444-555555555555";
    expect(p.scopeTabId(p.tabScope("files", id))).toBe(id);
    expect(p.scopeTabId("settings:global")).toBeNull();
    expect(p.scopeTabId("session")).toBeNull();
  });
});

describe("desktop carrier (state_* commands)", () => {
  it("coalesces a burst into one state_save carrying the last payload", async () => {
    fakeDisk();
    const p = await importPersist(true);
    p.saveState("s", { v: 1 });
    p.saveState("s", { v: 2 });
    p.saveState("s", { v: 3 });
    await vi.advanceTimersByTimeAsync(299);
    expect(stateCalls()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(stateCalls()).toEqual(["state_save"]);
    const [, args] = mocks.invoke.mock.calls.find(
      ([cmd]) => cmd === "state_save"
    )!;
    expect(args).toEqual({ scope: "s", json: JSON.stringify({ v: 3 }) });
  });

  it("routes load, delete and list to their commands", async () => {
    const disk = fakeDisk();
    disk.set("s", JSON.stringify({ v: 7 }));
    disk.set("stale", "{}");
    const p = await importPersist(true);
    expect(await p.loadState("s")).toEqual({ v: 7 });
    expect((await p.listScopes()).sort()).toEqual(["s", "stale"]);
    p.deleteState("stale");
    await settle();
    expect(disk.has("stale")).toBe(false);
  });

  it("keeps save→delete order for one scope even with the save in flight", async () => {
    const disk = fakeDisk();
    let releaseSave!: () => void;
    const gate = new Promise<void>((r) => (releaseSave = r));
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "state_save") await gate;
      return base(cmd, args);
    });

    const p = await importPersist(true);
    p.saveState("s", { v: 1 });
    const flushed = p.flushAll(); // save now in flight, held by the gate
    p.deleteState("s");
    await settle();
    // The delete must queue behind the unfinished save, not overtake it —
    // overtaking would let the save land afterwards and resurrect the file.
    expect(stateCalls()).toEqual(["state_save"]);
    releaseSave();
    await flushed;
    await settle();
    expect(stateCalls()).toEqual(["state_save", "state_delete"]);
    expect(disk.has("s")).toBe(false);
  });

  it("flushAll resolves only after in-flight writes land", async () => {
    fakeDisk();
    let releaseSave!: () => void;
    const gate = new Promise<void>((r) => (releaseSave = r));
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "state_save") await gate;
      return base(cmd, args);
    });

    const p = await importPersist(true);
    p.saveState("s", { v: 1 });
    let first = false;
    const firstFlush = p.flushAll().then(() => (first = true));
    await settle();
    // A second flush with nothing buffered must still wait for the write
    // already in the air — "flushed" has to mean "on disk".
    let second = false;
    const secondFlush = p.flushAll().then(() => (second = true));
    await settle();
    expect(first).toBe(false);
    expect(second).toBe(false);
    releaseSave();
    await Promise.all([firstFlush, secondFlush]);
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it("a failing carrier never throws at callers", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd.startsWith("state_")) throw new Error("disk on fire");
    });
    const p = await importPersist(true);
    p.saveState("s", { v: 1 }); // must not blow up when the write fails
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    await expect(p.flushAll()).resolves.toBeUndefined();
    expect(await p.loadState("s")).toBeNull();
    expect(await p.listScopes()).toEqual([]);
    p.deleteState("s");
    await settle();
  });

});
