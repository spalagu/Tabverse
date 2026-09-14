import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./components/Confirm", () => ({ confirmChoose: vi.fn() }));
import { confirmChoose } from "./components/Confirm";
import { closeTabAsking, closeTabsAsking, deleteGroupAsking } from "./appCommands";
import { useStore, withPresetGroups, type Tab } from "./state/store";
const a: Tab = { id: "protected-a", type: "files", title: "Dirty files", dirty: true, groupId: "preset-files" };
const b: Tab = { id: "protected-b", type: "terminal", title: "Busy shell", busy: true, groupId: null };
beforeEach(() => { vi.clearAllMocks(); useStore.setState({ tabs: [a,b], groups: withPresetGroups([]), activeTabId: a.id, split: null, selectedTabIds: [], menu: null, peekTabId: null }); });
describe("design §10: common close protection", () => {
  it("cancel protects both dirty files and busy terminals even without native background opt-in", async () => {
    vi.mocked(confirmChoose).mockResolvedValue(null); await closeTabsAsking([a.id, b.id]);
    expect(useStore.getState().tabs).toHaveLength(2); expect(confirmChoose).toHaveBeenCalledTimes(2);
  });
  it("serializes confirmations and deduplicates concurrent requests for one tab", async () => {
    let first!: (value: string | null) => void;
    vi.mocked(confirmChoose).mockImplementationOnce(() => new Promise((resolve) => { first = resolve; })).mockResolvedValueOnce("close");
    const pa = closeTabAsking(a.id, false); const duplicate = closeTabAsking(a.id, false); const pb = closeTabAsking(b.id, false);
    await Promise.resolve(); expect(confirmChoose).toHaveBeenCalledTimes(1); expect(duplicate).toBe(pa);
    first("close"); await Promise.all([pa, pb]); expect(confirmChoose).toHaveBeenCalledTimes(2);
    expect(useStore.getState().tabs).toHaveLength(1); expect(useStore.getState().tabs[0].dormant).toBe(true);
  });
  it("a response cannot close a different generation of a tab that was closed and restored", async () => {
    let answer!: (value: string | null) => void;
    vi.mocked(confirmChoose).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const pending = closeTabAsking(b.id); await Promise.resolve();
    useStore.getState().closeTab(b.id); useStore.getState().reopenClosedTab(); answer("close"); await pending;
    expect(useStore.getState().tabs.some((t) => t.id === b.id)).toBe(true);
  });
  it("batch freezes its intent and removes duplicates instead of escalating sleep to remove", async () => {
    vi.mocked(confirmChoose).mockResolvedValue("close"); await closeTabsAsking([a.id, a.id]);
    expect(confirmChoose).toHaveBeenCalledTimes(1); expect(useStore.getState().tabs.find((t) => t.id === a.id)?.dormant).toBe(true);
    await closeTabAsking(a.id, false); expect(useStore.getState().tabs.find((t) => t.id === a.id)?.dormant).toBe(true);
  });
  it("deletes a group only after every protected member agrees to close", async () => {
    useStore.setState({
      groups: withPresetGroups([{ id: "work", name: "Work", colorIndex: 0, collapsed: false }]),
      tabs: [{ ...a, groupId: "work" }, { ...b, groupId: "work" }],
    });
    vi.mocked(confirmChoose).mockResolvedValue("close");
    await expect(deleteGroupAsking("work")).resolves.toBe(true);
    expect(useStore.getState().tabs).toHaveLength(0);
    expect(useStore.getState().groups.some((group) => group.id === "work")).toBe(false);
  });
  it("keeps a group intact when a protected member cancels", async () => {
    useStore.setState({
      groups: withPresetGroups([{ id: "work", name: "Work", colorIndex: 0, collapsed: false }]),
      tabs: [{ ...a, groupId: "work" }, { ...b, groupId: "work" }],
    });
    vi.mocked(confirmChoose).mockResolvedValue(null);
    await expect(deleteGroupAsking("work")).resolves.toBe(false);
    expect(useStore.getState().tabs).toHaveLength(2);
    expect(useStore.getState().groups.some((group) => group.id === "work")).toBe(true);
  });
});
