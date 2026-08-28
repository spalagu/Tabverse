import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesPathBar, pathSegments } from "./FilesPathBar";

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe("file path segments", () => {
  it("builds jumpable prefixes and collapses repeated separators", () => {
    expect(pathSegments("//Users//q/work")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "q", path: "/Users/q" },
      { label: "work", path: "/Users/q/work" },
    ]);
  });

  it("represents an empty root as the filesystem root", () => {
    expect(pathSegments("")).toEqual([{ label: "/", path: "/" }]);
  });
});

describe("file path bar presentation", () => {
  it("switches panes, jumps roots, and toggles hidden files", async () => {
    const onActivePaneChange = vi.fn();
    const onRootChange = vi.fn();
    const onShowHiddenChange = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <FilesPathBar
          paneCount={2}
          activePane={0}
          root="/repo/src"
          branch="main"
          showHidden={false}
          onActivePaneChange={onActivePaneChange}
          onRootChange={onRootChange}
          onShowHiddenChange={onShowHiddenChange}
        />
      );
    });

    const paneButtons = host.querySelectorAll<HTMLButtonElement>(".pane-chip");
    const repo = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".path-seg")
    ).find((button) => button.textContent === "repo")!;
    const hidden = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === ".*"
    )!;
    await act(async () => {
      paneButtons[1].click();
      repo.click();
      hidden.click();
    });

    expect(onActivePaneChange).toHaveBeenCalledWith(1);
    expect(onRootChange).toHaveBeenCalledWith("/repo");
    expect(onShowHiddenChange).toHaveBeenCalledWith(true);
    expect(host.querySelector(".branch")?.textContent).toContain("main");
  });
});
