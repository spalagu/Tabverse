import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GroupHeadPresentation,
  SidebarTreePresentation,
  TabRowPresentation,
  rootGroups,
  subtreeTabs,
} from "./sidebarPresentation";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const TabIcon = ({ className }: { className?: string }) => <svg className={className} />;
const FolderIcon = ({ open }: { open: boolean }) => <svg data-open={open} />;

describe("shared sidebar presentation", () => {
  it("renders browser deviation and host-supplied state badges without a runtime import", () => {
    act(() => {
      root.render(
        <TabRowPresentation
          tab={{ id: "browser-1", type: "browser", title: "Docs", groupId: "folder", url: "https://new.example", pinnedUrl: "https://old.example", attention: true }}
          Icon={TabIcon}
          favicon={null}
          deviationHint="Moved"
          attentionHint="Attention"
          broadcastHint="Broadcasting"
          broadcasting={false}
          viewersHint="Viewers"
        />,
      );
    });
    expect(host.querySelector(".tab-icon")).not.toBeNull();
    expect(host.querySelector(".tab-deviation")?.getAttribute("title")).toBe("Moved");
    expect(host.querySelector(".attention-dot")?.getAttribute("title")).toBe("Attention");
  });

  it("renders the group frame from supplied color and slots", () => {
    act(() => {
      root.render(
        <GroupHeadPresentation
          group={{ name: "Work", collapsed: false }}
          count={2}
          color="rgb(1, 2, 3)"
          FolderIcon={FolderIcon}
          titleSlot={<input aria-label="Rename folder" />}
          afterTitleSlot={<span>Loading</span>}
        />,
      );
    });
    expect(host.querySelector<HTMLElement>(".group-folder")?.style.color).toBe("rgb(1, 2, 3)");
    expect(host.querySelector("svg")?.getAttribute("data-open")).toBe("true");
    expect(host.querySelector("input")?.getAttribute("aria-label")).toBe("Rename folder");
    expect(host.textContent).toContain("Loading");
    expect(host.querySelector(".group-count")?.textContent).toBe("2");
  });

  it("keeps collapsed subtree order and expanded member order in one shared walk", () => {
    const groups = [
      { id: "parent", name: "Parent", collapsed: false },
      { id: "child", parentId: "parent", name: "Child", collapsed: true },
    ];
    const tabs = [
      { id: "parent-tab", groupId: "parent" },
      { id: "child-one", groupId: "child" },
      { id: "child-two", groupId: "child" },
    ];
    act(() => {
      root.render(
        <SidebarTreePresentation
          group={groups[0]}
          groups={groups}
          tabs={tabs}
          className="host-tree-group"
          subtreeTabs={subtreeTabs}
          renderGroupHead={({ group, count, depth }) => (
            <span data-head={group.id}>{`${group.name}:${count}:${depth}`}</span>
          )}
          renderTab={({ tab, depth, peek }) => (
            <span data-tab={tab.id}>{`${depth}:${peek}`}</span>
          )}
        />,
      );
    });

    expect(host.querySelectorAll(".workbench-sidebar-tree-group")).toHaveLength(2);
    expect(host.textContent).toContain("Parent:3:0");
    expect(host.textContent).toContain("Child:2:1");
    expect(host.querySelector('[data-tab="child-one"]')?.textContent).toBe("1:true");
    expect(host.querySelector('[data-tab="child-two"]')?.textContent).toBe("1:true");
    expect(host.querySelector('[data-tab="parent-tab"]')?.textContent).toBe("0:false");
  });

  it("keeps dangling roots reachable and terminates corrupt group cycles", () => {
    const groups = [
      { id: "root" },
      { id: "dangling", parentId: "missing" },
      { id: "cycle-a", parentId: "cycle-b" },
      { id: "cycle-b", parentId: "cycle-a" },
    ];
    const tabs = [
      { id: "a", groupId: "cycle-a" },
      { id: "b", groupId: "cycle-b" },
    ];

    expect(rootGroups(groups).map((group) => group.id)).toEqual(["root", "dangling"]);
    expect(subtreeTabs(tabs, groups, "cycle-a").map((tab) => tab.id)).toEqual(["b", "a"]);
  });
});
