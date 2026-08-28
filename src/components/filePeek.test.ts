import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileMeta } from "../backend/fs";


// backend/fs.ts chooses its branch at MODULE LOAD by reading the Tauri
// marker off the window; the hoisted block runs before the import graph
// does (the load-time trick of searchExcludes.test.ts).
vi.hoisted(() => {
  (globalThis as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
});

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(
    async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => null
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

// Monaco cannot load in the test environment (filesView.test.ts's mock,
// same reason): TabContent imports the whole view family, and the editor is
// the one member of it that needs standing in. Nothing under test touches
// it — the files peek deliberately renders none of FilesView.
vi.mock("./files/CodeEditor", () => ({
  CodeEditor: () => null,
  disposeEditorState: () => {},
  languageFor: (p: string) => p,
  openEditorFind: () => false,
  currentEditorThemeName: () => "",
}));

const { FilePeek } = await import("./TabContent");

/** A binary-kind meta: the preview matrix's own row (the criterion's
 * shape), with no heavyweight viewer needed beyond it. */
const imageMeta = (path: string): FileMeta => ({
  path,
  name: path.split("/").pop() ?? path,
  size: 4096,
  kind: "image",
  mime: "image/png",
  text: null,
  truncated: false,
  readOnlyReason: null,
  headText: null,
  git: null,
  modified: null,
});

const pngMeta = imageMeta("/work/shot.png");

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.invoke.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const mount = (openPath: string) => {
  flushSync(() => {
    root!.render(
      createElement(FilePeek, {
        tab: { id: "peek-1", type: "files", title: "shot.png", groupId: null, peek: true, openPath },
      })
    );
  });
};

describe("the file peek pane", () => {
  it("holds the loading state until FileMeta arrives, then mounts the preview", async () => {
    let release: (m: FileMeta) => void = () => {};
    mocks.invoke.mockImplementation(
      (_cmd: string) => new Promise((res) => (release = res as (m: FileMeta) => void))
    );
    mount("/work/shot.png");

    // The async window: the read is out, the meta is not back — the pane
    // says so instead of showing nothing.
    await vi.waitFor(() => {
      expect(host!.textContent).toContain("Loading shot.png");
    });
    expect(mocks.invoke).toHaveBeenCalledWith("fs_read", { path: "/work/shot.png" });
    // The image has NOT been mounted on a promise.
    expect(host!.querySelector("img")).toBeNull();

    release(pngMeta);
    await vi.waitFor(() => {
      expect(host!.querySelector("img.preview-img")).not.toBeNull();
    });
    expect(host!.querySelector(".loading-state")).toBeNull();
  });

  it("a file the read cannot deliver is the error state, not a crash", async () => {
    mocks.invoke.mockRejectedValue(new Error("no such file"));
    mount("/work/gone.png");
    await vi.waitFor(() => {
      expect(host!.querySelector(".error-state")).not.toBeNull();
    });
    expect(host!.querySelector("img")).toBeNull();
  });
});
