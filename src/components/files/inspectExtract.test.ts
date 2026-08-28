import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
  openDialog: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openDialog }));

type InspectView = typeof import("./InspectView");
type FileMeta = import("../../backend/fs").FileMeta;
type Strings = typeof import("../../strings");

const META: FileMeta = {
  path: "/w/bundle.zip",
  name: "bundle.zip",
  size: 120,
  kind: "archive",
  mime: "application/zip",
  text: null,
  truncated: false,
  readOnlyReason: null,
  headText: null,
  git: null,
  modified: 1000,
};

const ARCHIVE = {
  type: "archive",
  entries: [
    { path: "docs/", size: 0, dir: true },
    { path: "docs/readme.md", size: 6, dir: false },
  ],
  total: 2,
  truncated: false,
};

const mounted: Array<() => void> = [];

async function fresh(): Promise<{
  InspectView: InspectView["InspectView"];
  STR: Strings["STR"];
}> {
  vi.resetModules();
  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) =>
      mocks.invoke(cmd, args),
  };
  const mod = await import("./InspectView");
  const strings = await import("../../strings");
  return { InspectView: mod.InspectView, STR: strings.STR };
}

function render(View: InspectView["InspectView"]): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  flushSync(() => root.render(createElement(View, { meta: META })));
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return host;
}

/** Let the inspect call and the click's async chain run, then repaint. */
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  flushSync(() => {});
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.openDialog.mockReset();
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "fs_inspect") return ARCHIVE;
    if (cmd === "fs_archive_extract")
      return { dir: "/w/bundle", files: ["/w/bundle/docs/readme.md"] };
    throw new Error(`unexpected command: ${cmd}`);
  });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const buttonByText = (host: HTMLElement, text: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === text
  );

describe("the archive preview's extraction entries", () => {
  it("Extract here hands the archive's own folder to fs_archive_extract", async () => {
    const { InspectView: View, STR } = await fresh();
    const host = render(View);
    await settle();

    const entry = Array.from(
      host.querySelectorAll(".inspect-archive-table td")
    ).map((td) => td.textContent);
    expect(entry).toContain("docs/readme.md");

    buttonByText(host, STR.files.inspect.extractHere)!.click();
    await settle();

    expect(mocks.invoke).toHaveBeenCalledWith("fs_archive_extract", {
      archive: "/w/bundle.zip",
      destDir: "/w",
    });
    const notes = Array.from(
      host.querySelectorAll(".inspect-extract-note")
    ).map((n) => n.textContent);
    expect(notes.join(" ")).toContain(STR.files.inspect.extractDone({ n: 1, dir: "/w/bundle" }));
  });

  it("Extract to… opens a directory picker and extracts into the choice", async () => {
    const { InspectView: View, STR } = await fresh();
    mocks.openDialog.mockResolvedValue("/somewhere/else");
    const host = render(View);
    await settle();

    buttonByText(host, STR.files.inspect.extractTo)!.click();
    await settle();

    expect(mocks.openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false })
    );
    expect(mocks.invoke).toHaveBeenCalledWith("fs_archive_extract", {
      archive: "/w/bundle.zip",
      destDir: "/somewhere/else",
    });
  });

  it("a cancelled picker extracts nothing; a refused extraction says so", async () => {
    const { InspectView: View, STR } = await fresh();
    mocks.openDialog.mockResolvedValue(null);
    const host = render(View);
    await settle();

    buttonByText(host, STR.files.inspect.extractTo)!.click();
    await settle();
    expect(
      mocks.invoke.mock.calls.filter(([c]) => c === "fs_archive_extract")
    ).toHaveLength(0);

    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "fs_inspect") return ARCHIVE;
      throw new Error("entry escapes the extraction folder");
    });
    buttonByText(host, STR.files.inspect.extractHere)!.click();
    await settle();
    const notes = Array.from(
      host.querySelectorAll(".inspect-extract-note")
    ).map((n) => n.textContent);
    expect(notes.join(" ")).toContain("escapes");
  });
});
