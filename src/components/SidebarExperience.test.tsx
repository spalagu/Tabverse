import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../appCommands", () => ({ closeTabAsking: vi.fn() }));
vi.mock("../favicons", () => ({ useFavicon: () => null }));
vi.mock("./sidebarActions", () => ({ resetPinnedTab: vi.fn() }));
import { closeTabAsking } from "../appCommands";
import { resetPinnedTab } from "./sidebarActions";
import { useStore, withPresetGroups, type Tab } from "../state/store";
import { SidebarTabRow } from "./SidebarTabRow";
import { STR } from "../strings";
let host: HTMLDivElement; let root: Root;
const saved: Tab = { id: "saved", type: "browser", title: "Project", url: "https://example.org/issue", pinnedUrl: "https://example.org", groupId: "preset-browser" };
const other: Tab = { id: "other", type: "files", title: "Files", groupId: null };
function Row() { const tab = useStore((s) => s.tabs.find((t) => t.id === "saved")!); const active = useStore((s) => s.activeTabId === "saved"); return <SidebarTabRow tab={tab} active={active} />; }
function click(el: Element, options: MouseEventInit = {}) { act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...options })); }); }
function key(el: Element, key: string, options: KeyboardEventInit = {}) { act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options })); }); }
const main = () => host.querySelector<HTMLButtonElement>(".tab-main")!;
const row = () => host.querySelector<HTMLElement>("[data-tab-id]")!;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); useStore.setState({ tabs: [saved, other], groups: withPresetGroups([]), activeTabId: "other", selectedTabIds: [], selectionAnchor: null, split: null, draggingTabIds: [], contentDrag: null, renamingTabId: null, menu: null }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root.render(<Row />)); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
describe("design §5/6: sidebar intent isolation", () => {
  it("title activation never resets; the icon resets precisely this tab", () => {
    click(main()); click(main()); expect(useStore.getState().activeTabId).toBe("saved"); expect(resetPinnedTab).not.toHaveBeenCalled();
    click(host.querySelector(".tab-icon-action")!); expect(resetPinnedTab).toHaveBeenCalledExactlyOnceWith("saved");
  });
  it("keeps unique Browser titles compact and shows hosts for duplicate titles", () => {
    expect(row().classList.contains("has-subtitle")).toBe(false);
    act(() => useStore.setState({ tabs: [saved, { ...other, id: "duplicate", type: "browser", title: saved.title, url: "https://other.example/" }] }));
    expect(row().classList.contains("has-subtitle")).toBe(true);
    expect(host.querySelector(".tab-subtitle")?.textContent).toBe("example.org");
  });
  it("plain click anchors Shift selection and modifier clicks do not activate", () => {
    click(main(), { metaKey: true }); expect(useStore.getState().activeTabId).toBe("other"); expect(useStore.getState().selectedTabIds).toEqual(["saved"]);
    click(main()); expect(useStore.getState().selectionAnchor).toBe("saved");
    act(() => useStore.getState().extendSelectionTo("other")); expect(useStore.getState().selectedTabIds).toEqual(["saved", "other"]);
  });
  it("F2 rename accepts text only after IME composition and restores the title", () => {
    key(main(), "F2"); const input = host.querySelector("input")!; input.value = "Project documentation";
    key(input, "Enter", { isComposing: true }); key(input, "Escape", { isComposing: true });
    expect(host.querySelector("input")).toBe(input); expect(useStore.getState().tabs[0].title).toBe("Project");
    key(input, "Enter"); expect(useStore.getState().tabs[0].title).toBe("Project documentation"); expect(main().getAttribute("aria-label")).toBe("Project documentation");
  });
  it("Escape cancels rename and does not navigate through the earlier double click", () => {
    act(() => main().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const input = host.querySelector("input")!; input.value = "discard"; key(input, "Escape");
    expect(useStore.getState().tabs[0].title).toBe("Project"); expect(resetPinnedTab).not.toHaveBeenCalled();
  });
  it("close captures presentation state; a double click is not a second destructive intent", () => {
    const close = host.querySelector(".tab-close")!; click(close, { detail: 1 }); click(close, { detail: 2 });
    expect(closeTabAsking).toHaveBeenCalledExactlyOnceWith("saved", false); expect(useStore.getState().activeTabId).toBe("other");
    act(() => useStore.setState({ tabs: [{ ...saved, dormant: true }, other] }));
    expect(close.getAttribute("aria-label")).toBe(STR.common.sidebar.removeSaved);
    click(close, { detail: 1 }); expect(closeTabAsking).toHaveBeenLastCalledWith("saved", true);
  });
  it("Shift+F10 targets this row and has no activation side effect", () => {
    key(main(), "F10", { shiftKey: true }); expect(useStore.getState().menu?.tabId).toBe("saved"); expect(useStore.getState().activeTabId).toBe("other");
  });
  it("a middle hover remains sorting even after time passes, and lower drop inserts after", () => {
    vi.useFakeTimers(); vi.spyOn(row(), "getBoundingClientRect").mockReturnValue({ top: 0, height: 40 } as DOMRect);
    act(() => useStore.setState({ draggingTabIds: ["other"] }));
    const transfer = { types: ["text/tabverse-tab"], getData: () => "", dropEffect: "move" };
    const send = (type: string, y: number) => { const ev = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(ev, { dataTransfer: { value: transfer }, clientY: { value: y } }); act(() => row().dispatchEvent(ev)); };
    send("dragover", 24); act(() => vi.advanceTimersByTime(1000)); expect(row().dataset.dropIntent).toBe("after");
    send("drop", 38); const s = useStore.getState(); expect(s.split).toBeNull(); expect(s.tabs.map((t) => t.id)).toEqual(["saved", "other"]); expect(s.tabs[1].groupId).toBe(saved.groupId); expect(s.draggingTabIds).toEqual([]); expect(row().dataset.dropIntent).toBeUndefined();
  });
});
