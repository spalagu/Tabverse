import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesPanelHeader, FilesTreeToolbar } from "./FilesSidebarControls";

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
    true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe("files panel header", () => {
  it("exposes history, parent, and mode actions", async () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    const onParent = vi.fn();
    const onPanelModeChange = vi.fn();
    await act(async () => {
      root?.render(
        <FilesPanelHeader
          root="/repo/src"
          panelMode="tree"
          canGoBack
          canGoForward={false}
          parentLabel="up"
          onBack={onBack}
          onForward={onForward}
          onParent={onParent}
          onPanelModeChange={onPanelModeChange}
        />
      );
    });
    const buttons = Array.from(host!.querySelectorAll<HTMLButtonElement>("button"));
    expect(host!.querySelector(".panel-root")?.textContent).toBe("src");
    expect(buttons.find((button) => button.textContent === "›")?.disabled).toBe(true);
    await act(async () => {
      buttons.find((button) => button.textContent === "‹")?.click();
      buttons.find((button) => button.textContent === "up")?.click();
      buttons.find((button) => button.textContent === "Find")?.click();
    });
    expect(onBack).toHaveBeenCalledOnce();
    expect(onParent).toHaveBeenCalledOnce();
    expect(onPanelModeChange).toHaveBeenCalledWith("search");
  });
});

describe("files tree toolbar", () => {
  it("changes view, panes, layout, and sort settings", async () => {
    const onSortChange = vi.fn();
    const onTreeModeChange = vi.fn();
    const onDualChange = vi.fn();
    const onLayoutChange = vi.fn();
    await act(async () => {
      root?.render(
        <FilesTreeToolbar
          sort={{ key: "name", asc: true, dirsFirst: true }}
          treeMode="tree"
          dual
          layout="row"
          ascendingLabel="up"
          descendingLabel="down"
          onSortChange={onSortChange}
          onTreeModeChange={onTreeModeChange}
          onDualChange={onDualChange}
          onLayoutChange={onLayoutChange}
        />
      );
    });
    const button = (text: string) =>
      Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.textContent?.trim() === text
      )!;
    await act(async () => {
      button("Columns").click();
      button("Dual").click();
      button("Side by side").click();
      button("Nameup").click();
    });
    await act(async () => {
      button("Size").click();
      button("Ascending").click();
      button("✓ Folders first").click();
    });
    expect(onTreeModeChange).toHaveBeenCalledWith("miller");
    expect(onDualChange).toHaveBeenCalledWith(false);
    expect(onLayoutChange).toHaveBeenCalledWith("column");
    expect(onSortChange).toHaveBeenCalledWith({
      key: "size",
      asc: true,
      dirsFirst: true,
    });
    expect(onSortChange).toHaveBeenCalledWith({
      key: "name",
      asc: false,
      dirsFirst: true,
    });
    expect(onSortChange).toHaveBeenCalledWith({
      key: "name",
      asc: true,
      dirsFirst: false,
    });
  });
});
