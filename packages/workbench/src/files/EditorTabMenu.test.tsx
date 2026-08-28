import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR } from "../strings";
import {
  EditorTabMenu,
  type EditorTabMenuRuntime,
} from "./EditorTabMenu";

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

const open = [
  { path: "/work/a.ts" },
  { path: "/work/b.ts" },
  { path: "/work/c.ts" },
];

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

function button(label: string): HTMLButtonElement {
  const match = Array.from(host?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.startsWith(label)
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${label}`);
  }
  return match;
}

function makeRuntime(): EditorTabMenuRuntime {
  return {
    copyText: vi.fn(async () => {}),
    reveal: vi.fn(async () => {}),
    reportError: vi.fn(),
  };
}

async function renderMenu(
  runtime: EditorTabMenuRuntime,
  onCloseTabs = vi.fn(),
  onDismiss = vi.fn()
) {
  await act(async () => {
    root?.render(
      <EditorTabMenu
        at={{ path: "/work/b.ts", x: 40, y: 50 }}
        open={open}
        root="/work"
        onCloseTabs={onCloseTabs}
        onCompareWith={vi.fn()}
        onDismiss={onDismiss}
        runtime={runtime}
      />
    );
  });
  return { onCloseTabs, onDismiss };
}

describe("shared editor tab menu", () => {
  it("derives close scopes from the rendered strip order", async () => {
    const runtime = makeRuntime();
    const { onCloseTabs, onDismiss } = await renderMenu(runtime);

    await act(async () => button(STR.files.editorTabMenu.closeRight).click());

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onCloseTabs).toHaveBeenCalledWith(["/work/c.ts"]);
  });

  it("routes relative copy and reveal through host runtime ports", async () => {
    const runtime = makeRuntime();
    const callbacks = await renderMenu(runtime);

    await act(async () => {
      button(STR.files.editorTabMenu.copyRelativePath).click();
      await Promise.resolve();
    });
    expect(runtime.copyText).toHaveBeenCalledWith("b.ts");

    await renderMenu(runtime, callbacks.onCloseTabs, callbacks.onDismiss);
    await act(async () => {
      button(STR.files.tree.revealInFinder).click();
      await Promise.resolve();
    });
    expect(runtime.reveal).toHaveBeenCalledWith("/work/b.ts");
  });
});
