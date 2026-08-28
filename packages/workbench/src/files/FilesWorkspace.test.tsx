import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesWorkspace, type FilesWorkspaceSidebarProps } from "./FilesWorkspace";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
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

async function render(node: ReactNode) {
  await act(async () => {
    root?.render(node);
    await Promise.resolve();
  });
}

function sidebar(
  overrides: Partial<FilesWorkspaceSidebarProps> = {}
): FilesWorkspaceSidebarProps {
  return {
    panelMode: "tree",
    treeMode: "tree",
    header: {
      root: "/work",
      canGoBack: false,
      canGoForward: false,
      parentLabel: "Up",
      onBack: vi.fn(),
      onForward: vi.fn(),
      onParent: vi.fn(),
      onPanelModeChange: vi.fn(),
    },
    toolbar: {
      sort: { key: "name", asc: true, dirsFirst: true },
      dual: false,
      layout: "row",
      ascendingLabel: "Ascending",
      descendingLabel: "Descending",
      onSortChange: vi.fn(),
      onTreeModeChange: vi.fn(),
      onDualChange: vi.fn(),
      onLayoutChange: vi.fn(),
    },
    searchPanel: <div data-panel="search" />,
    changesPanel: <div data-panel="changes" />,
    treeView: <div data-panel="tree" />,
    columnsView: <div data-panel="columns" />,
    ...overrides,
  };
}

describe("shared files workspace", () => {
  it("owns the outer shell, overlays, sidebar controls, and tree route", async () => {
    await render(
      <FilesWorkspace
        overlays={[<div key="location" data-overlay="location" />]}
        sidebar={sidebar()}
        main={<div className="files-mains" data-main="workspace" />}
      />
    );

    expect(host?.querySelector(".files-view")).not.toBeNull();
    expect(host?.querySelector(".files-sidebar .panel-head")).not.toBeNull();
    expect(host?.querySelector(".files-sidebar .tree-bar")).not.toBeNull();
    expect(host?.querySelector('[data-panel="tree"]')).not.toBeNull();
    expect(host?.querySelector('[data-panel="columns"]')).toBeNull();
    expect(host?.querySelector('[data-overlay="location"]')).not.toBeNull();
    expect(host?.querySelector('[data-main="workspace"]')).not.toBeNull();
  });

  it("routes search, changes, and columns without mounting inactive panels", async () => {
    await render(
      <FilesWorkspace
        sidebar={sidebar({
          panelMode: "search",
        })}
        main={null}
      />
    );
    expect(host?.querySelector('[data-panel="search"]')).not.toBeNull();
    expect(host?.querySelector(".tree-bar")).toBeNull();

    await render(
      <FilesWorkspace
        sidebar={sidebar({
          panelMode: "changes",
        })}
        main={null}
      />
    );
    expect(host?.querySelector('[data-panel="changes"]')).not.toBeNull();
    expect(host?.querySelector('[data-panel="search"]')).toBeNull();

    await render(
      <FilesWorkspace
        sidebar={sidebar({ treeMode: "miller" })}
        main={null}
      />
    );
    expect(host?.querySelector('[data-panel="columns"]')).not.toBeNull();
    expect(host?.querySelector('[data-panel="tree"]')).toBeNull();
  });
});
