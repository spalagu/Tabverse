import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileQuickOpen,
  rankFileQuickOpen,
  scoreFileQuickOpen,
} from "./FileQuickOpen";

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

describe("file quick-open ranking", () => {
  it("rewards consecutive basename matches and rejects missing sequences", () => {
    expect(scoreFileQuickOpen("read", "docs/README.md")).toBeGreaterThan(
      scoreFileQuickOpen("read", "src/react/editor.tsx") ?? -Infinity
    );
    expect(scoreFileQuickOpen("xyz", "docs/README.md")).toBeNull();
  });

  it("sorts matches and enforces the result limit", () => {
    const ranked = rankFileQuickOpen(
      ["src/read.ts", "docs/README.md", "notes/red.md"],
      "read",
      2
    );
    expect(ranked).toHaveLength(2);
    expect(ranked[0].path).toBe("docs/README.md");
  });
});

async function renderPicker(
  walk: () => Promise<readonly string[]>,
  onPick = vi.fn(),
  onClose = vi.fn()
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <FileQuickOpen
        root="/repo"
        showHidden={false}
        walk={walk}
        onPick={onPick}
        onClose={onClose}
      />
    );
    await Promise.resolve();
  });
  return { onPick, onClose };
}

describe("file quick-open presentation", () => {
  it("walks, filters, and picks the selected result with Enter", async () => {
    const state = await renderPicker(async () => [
      "src/main.ts",
      "docs/guide.md",
    ]);
    const input = host!.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "guide");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host!.querySelector(".switcher-title")?.textContent).toBe("guide.md");
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(state.onPick).toHaveBeenCalledWith("docs/guide.md");
  });

  it("distinguishes a failed walk from an empty result", async () => {
    await renderPicker(async () => {
      throw new Error("walk failed");
    });
    expect(host!.querySelector(".switcher-empty")?.textContent).toBe(
      "Couldn't index this folder."
    );
  });
});
