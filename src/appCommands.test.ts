import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detachTerminalTab,
  runAppCommand,
  shouldAskBeforeClosingBusyTerminal,
} from "./appCommands";
import { registerTerm, unregisterTerm, type TermApi } from "./termRegistry";
import { useStore, withPresetGroups } from "./state/store";

/**
 * The dedup matrix is the whole point: one physical key press can be
 * delivered twice by different routes (page + menu), while two real presses
 * arrive fast on the same route. Only the former is an echo.
 */
// Each test starts a minute apart so no dedup window leaks across tests —
// the last-run map is module state and survives between them.
let base = Date.parse("2026-01-01T00:00:00Z");

describe("runAppCommand deduplication", () => {
  beforeEach(() => {
    // Only Date is faked: the dedup logic reads Date.now(), and faking the
    // task queues would stall the test runner's own scheduling.
    vi.useFakeTimers({ toFake: ["Date"] });
    base += 60_000;
    vi.setSystemTime(base);
    useStore.setState({ tabs: [], groups: [], activeTabId: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("same-route rapid repeats all run — mashing ⌘T opens that many terminals", () => {
    runAppCommand("new-terminal", "key");
    runAppCommand("new-terminal", "key");
    runAppCommand("new-terminal", "key");
    expect(useStore.getState().tabs).toHaveLength(3);
  });

  it("a cross-route repeat inside 300ms is dropped as a double delivery", () => {
    runAppCommand("new-terminal", "page");
    vi.setSystemTime(Date.now() + 100);
    runAppCommand("new-terminal", "menu");
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it("a cross-route repeat after 300ms is a real second press", () => {
    runAppCommand("new-terminal", "page");
    vi.setSystemTime(Date.now() + 301);
    runAppCommand("new-terminal", "menu");
    expect(useStore.getState().tabs).toHaveLength(2);
  });

  it("close-tab is exempt: closing moves focus, so routes legitimately differ", () => {
    runAppCommand("new-terminal", "key");
    vi.setSystemTime(Date.now() + 400);
    runAppCommand("new-terminal", "key");
    vi.setSystemTime(Date.now() + 400);
    runAppCommand("close-tab", "page");
    vi.setSystemTime(Date.now() + 100);
    runAppCommand("close-tab", "menu");
    expect(useStore.getState().tabs).toHaveLength(0);
  });

 it("toggle-pin files the active tab into its preset folder and back", () => {
    // The key kept ⌘⇧G and changed meaning: Pin to the type's preset
    // root / Unpin to today — never the old make-a-group-named-after-me.
    useStore.setState({
      tabs: [],
      groups: withPresetGroups([]),
      activeTabId: null,
    });
    runAppCommand("new-terminal", "key");
    const id = useStore.getState().activeTabId!;
    const preset = useStore.getState().groups.find((g) => g.preset === "terminal")!;
    vi.setSystemTime(Date.now() + 400);
    runAppCommand("toggle-pin", "key");
    expect(useStore.getState().tabs.find((t) => t.id === id)?.groupId).toBe(
      preset.id
    );
    // No group was invented along the way.
    expect(useStore.getState().groups.filter((g) => !g.preset)).toHaveLength(0);
    vi.setSystemTime(Date.now() + 400);
    runAppCommand("toggle-pin", "key");
    expect(
      useStore.getState().tabs.find((t) => t.id === id)?.groupId
    ).toBeNull();
  });

  it("jump-N activates the n-th visible tab", () => {
    runAppCommand("new-terminal", "key");
    vi.setSystemTime(Date.now() + 400);
    runAppCommand("new-terminal", "key");
    vi.setSystemTime(Date.now() + 400);
    runAppCommand("new-terminal", "key");
    const second = useStore.getState().tabs[1].id;
    runAppCommand("jump-2", "key");
    expect(useStore.getState().activeTabId).toBe(second);
  });
});


function fakeTerm(detach: () => Promise<void>): TermApi {
  return {
    size: () => ({ cols: 80, rows: 24 }), serialize: () => "", focus: () => {},
    runCommand: () => {}, write: () => {}, detach, openSearch: () => {}, cwd: () => null,
    setViewerCap: () => {},
  };
}

describe("busy terminal close policy", () => {
  it("asks only for a busy terminal when the opt-in is on in Tauri", () => {
    const id = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().setTabBusy(id, true);
    const tab = useStore.getState().tabs.find((item) => item.id === id)!;
    expect(shouldAskBeforeClosingBusyTerminal(tab, true, true)).toBe(true);
    expect(shouldAskBeforeClosingBusyTerminal(tab, false, true)).toBe(false);
    expect(shouldAskBeforeClosingBusyTerminal(tab, true, false)).toBe(false);
    expect(shouldAskBeforeClosingBusyTerminal({ ...tab, busy: false }, true, true)).toBe(false);
  });

  it("detaches every pane before the tab may close", async () => {
    const id = "tab-background", second = "pane-background";
    const firstDetach = vi.fn(async () => {}), secondDetach = vi.fn(async () => {});
    registerTerm(id, fakeTerm(firstDetach)); registerTerm(id, fakeTerm(secondDetach), second);
    const tab = { id, type: "terminal" as const, title: "Build", groupId: null,
      panes: { kind: "split" as const, id: "root", vertical: false, ratios: [1, 1],
        children: [{ kind: "leaf" as const, id }, { kind: "leaf" as const, id: second }] } };
    expect(await detachTerminalTab(tab)).toBe(true);
    expect(firstDetach).toHaveBeenCalledOnce(); expect(secondDetach).toHaveBeenCalledOnce();
    unregisterTerm(id); unregisterTerm(id, second);
  });

  it("keeps the tab when any pane is missing or detach fails", async () => {
    const id = "tab-partial", second = "pane-partial"; const detach = vi.fn(async () => {});
    registerTerm(id, fakeTerm(detach));
    const split = { id, type: "terminal" as const, title: "Build", groupId: null,
      panes: { kind: "split" as const, id: "root", vertical: false, ratios: [1, 1],
        children: [{ kind: "leaf" as const, id }, { kind: "leaf" as const, id: second }] } };
    expect(await detachTerminalTab(split)).toBe(false); expect(detach).not.toHaveBeenCalled();
    unregisterTerm(id);
    const rejected = vi.fn(async () => { throw new Error("helper unavailable"); });
    registerTerm(id, fakeTerm(rejected));
    expect(await detachTerminalTab({ ...split, panes: undefined })).toBe(false);
    expect(rejected).toHaveBeenCalledOnce(); unregisterTerm(id);
  });
});
