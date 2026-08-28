import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesWorkspaceLayout } from "./FilesWorkspaceLayout";

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

describe("shared files workspace layout", () => {
  it("assembles two panes, progress, terminal, and the active path bar", async () => {
    const onActivePaneChange = vi.fn();
    await render(
      <FilesWorkspaceLayout
        paneViews={[
          <div key="left" data-pane="left" />,
          <div key="right" data-pane="right" />,
        ]}
        layout="column"
        packing="Packing two files…"
        terminalPanel={<div data-terminal="persistent" />}
        pathBar={{
          paneCount: 2,
          activePane: 1,
          root: "/work/project",
          branch: "main",
          showHidden: false,
          onActivePaneChange,
          onRootChange: vi.fn(),
          onShowHiddenChange: vi.fn(),
        }}
      />
    );

    const panes = host?.querySelector(".panes-row");
    expect(panes?.classList.contains("dual")).toBe(true);
    expect(panes?.classList.contains("column")).toBe(true);
    expect(panes?.querySelectorAll("[data-pane]")).toHaveLength(2);
    expect(host?.querySelector(".files-note")?.textContent).toBe(
      "Packing two files…"
    );
    expect(host?.querySelector("[data-terminal]")).not.toBeNull();
    expect(host?.querySelector(".branch")?.textContent).toContain("main");

    const paneButtons = host?.querySelectorAll<HTMLButtonElement>(".pane-chip");
    await act(async () => paneButtons?.[0]?.click());
    expect(onActivePaneChange).toHaveBeenCalledWith(0);
  });

  it("keeps a single pane out of dual layout", async () => {
    await render(
      <FilesWorkspaceLayout
        paneViews={[<div key="only" data-pane="only" />]}
        layout="row"
        packing={null}
        terminalPanel={null}
        pathBar={{
          paneCount: 1,
          activePane: 0,
          root: "/",
          branch: null,
          showHidden: true,
          onActivePaneChange: vi.fn(),
          onRootChange: vi.fn(),
          onShowHiddenChange: vi.fn(),
        }}
      />
    );

    expect(host?.querySelector(".panes-row")?.classList.contains("dual")).toBe(
      false
    );
    expect(host?.querySelectorAll(".pane-chip")).toHaveLength(0);
  });
});
