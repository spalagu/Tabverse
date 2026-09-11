import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../appCommands", () => ({ closeTabAsking: vi.fn(), runAppCommand: vi.fn() }));
vi.mock("../favicons", () => ({ useFavicon: () => null }));
import { closeTabAsking, runAppCommand } from "../appCommands";
import { useStore, withPresetGroups, type Tab } from "../state/store";
import { SidebarTabRow } from "./SidebarTabRow";
import { SPLIT_DWELL_MS } from "./sidebarInteraction";

let host: HTMLDivElement;
let root: Root;
const a: Tab = { id: "a", type: "browser", title: "Saved page", groupId: "preset-browser", url: "https://example.com/current", pinnedUrl: "https://example.com/" };
const b: Tab = { id: "b", type: "files", title: "Project files", groupId: null };
const c: Tab = { id: "c", type: "files", title: "Other files", groupId: null };
const click = (element: Element, options: MouseEventInit = {}) => act(() => {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, ...options }));
});
const key = (element: Element, value: string, options: KeyboardEventInit = {}) => act(() => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }));
});
const row = () => host.querySelector<HTMLElement>('[data-tab-id="a"]')!;
const main = () => host.querySelector<HTMLButtonElement>(".tab-main")!;
const render = () => act(() => root.render(<SidebarTabRow tab={useStore.getState().tabs[0]} active={useStore.getState().activeTabId === "a"} />));

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ tabs: [a, b, c], groups: withPresetGroups([]), activeTabId: "a", split: null,
    selectedTabIds: [], selectionAnchor: null, draggingTabIds: [], contentDrag: null,
    renamingTabId: null, peekTabId: null, menu: null, folderPreviewGroupId: null });
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  render();
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.useRealTimers();
});

function drag(type: string, y: number, x = 20) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: x }, clientY: { value: y },
    dataTransfer: { value: { types: ["text/tabverse-tab"], getData: () => "", dropEffect: "move" } },
  });
  act(() => row().dispatchEvent(event));
}

describe("sidebar tab interactions", () => {
  it("does not reset a pinned page when activated repeatedly or renamed", () => {
    click(main()); click(main());
    act(() => main().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(host.querySelector("input")).not.toBeNull();
    expect(runAppCommand).not.toHaveBeenCalled();
    expect(useStore.getState().tabs[0].url).toBe(a.url);
  });
  it("resets only through the explicit action, after activating its own tab", () => {
    act(() => useStore.setState({ activeTabId: "b" }));
    click(host.querySelector(".tab-reset")!);
    expect(useStore.getState().activeTabId).toBe("a");
    expect(runAppCommand).toHaveBeenCalledExactlyOnceWith("go-pinned", "menu");
  });
  it("supports synthetic/assistive activation and establishes a range anchor", () => {
    act(() => useStore.setState({ activeTabId: "b" }));
    click(main());
    expect(useStore.getState().activeTabId).toBe("a");
    expect(useStore.getState().selectionAnchor).toBe("a");
    act(() => useStore.getState().extendSelectionTo("c"));
    expect(useStore.getState().selectedTabIds).toEqual(["a", "b", "c"]);
  });
  it("extends from the active tab even without a previous multi-selection", () => {
    act(() => useStore.setState({ activeTabId: "c", selectionAnchor: null }));
    click(main(), { shiftKey: true });
    expect(useStore.getState().activeTabId).toBe("c");
    expect(useStore.getState().selectedTabIds).toEqual(["a", "b", "c"]);
  });
  it("keeps modifier selection separate from activation", () => {
    act(() => useStore.setState({ activeTabId: "b" }));
    click(main(), { metaKey: true });
    expect(useStore.getState().selectedTabIds).toEqual(["a"]);
    expect(useStore.getState().activeTabId).toBe("b");
  });
  it("cancels a rename on Escape without committing on blur", () => {
    key(main(), "F2");
    const input = host.querySelector("input")!;
    input.value = "Must not save";
    key(input, "Escape");
    act(() => input.dispatchEvent(new FocusEvent("blur", { bubbles: true })));
    expect(useStore.getState().tabs[0].title).toBe(a.title);
    expect(host.querySelector("input")).toBeNull();
  });
  it("does not submit or cancel a Chinese IME composition", () => {
    key(main(), "F2");
    const input = host.querySelector("input")!;
    input.value = "项目文档";
    key(input, "Enter", { isComposing: true });
    key(input, "Escape", { isComposing: true });
    expect(host.querySelector("input")).toBe(input);
    expect(useStore.getState().tabs[0].title).toBe(a.title);
    key(input, "Enter");
    expect(useStore.getState().tabs[0].title).toBe("项目文档");
  });
  it("does not navigate or rename when close is clicked twice", () => {
    act(() => useStore.setState({ activeTabId: "b" }));
    const close = host.querySelector(".tab-close")!;
    click(close);
    act(() => close.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(closeTabAsking).toHaveBeenCalledWith("a");
    expect(useStore.getState().activeTabId).toBe("b");
    expect(host.querySelector("input")).toBeNull();
  });
  it("opens the tab context menu from the keyboard", () => {
    key(main(), "F10", { shiftKey: true });
    expect(useStore.getState().menu?.tabId).toBe("a");
  });
  it("requires a dwell before split and cleans feedback on cancelled drag", () => {
    vi.useFakeTimers();
    vi.spyOn(row(), "getBoundingClientRect").mockReturnValue({ top: 0, left: 0, width: 200, height: 40 } as DOMRect);
    act(() => useStore.setState({ draggingTabIds: ["b"] }));
    drag("dragover", 24);
    expect(row().dataset.dropIntent).toBe("after");
    act(() => vi.advanceTimersByTime(SPLIT_DWELL_MS));
    expect(row().dataset.dropIntent).toBe("split-left");
    act(() => window.dispatchEvent(new Event("dragend")));
    expect(row().dataset.dropIntent).toBeUndefined();
  });
  it("uses the actual lower-edge drop, not a stale split preview", () => {
    vi.useFakeTimers();
    vi.spyOn(row(), "getBoundingClientRect").mockReturnValue({ top: 0, left: 0, width: 200, height: 40 } as DOMRect);
    act(() => useStore.setState({ draggingTabIds: ["b"] }));
    drag("dragover", 20);
    act(() => vi.advanceTimersByTime(SPLIT_DWELL_MS));
    drag("drop", 38);
    expect(useStore.getState().split).toBeNull();
    expect(useStore.getState().tabs.filter((tab) => tab.groupId === a.groupId).map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(useStore.getState().draggingTabIds).toEqual([]);
  });
  it("does not reorder a selection dropped on itself", () => {
    act(() => useStore.setState({ draggingTabIds: ["a", "b"] }));
    drag("drop", 38);
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(["a", "b", "c"]);
  });
});
