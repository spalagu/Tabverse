import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR } from "../strings";
import {
  InspectView,
  type InspectViewRuntime,
  type Inspection,
} from "./InspectView";

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

async function renderView(node: ReactNode) {
  await act(async () => {
    root?.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickButton(label: string) {
  const button = Array.from(host?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent === label
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function runtimeFor(inspection: Inspection): InspectViewRuntime {
  return {
    inspect: vi.fn(async () => inspection),
    reveal: vi.fn(async () => {}),
    extract: vi.fn(async (_archive, destDir) => ({
      dir: `${destDir}/bundle`,
      files: [`${destDir}/bundle/readme.md`],
    })),
    chooseDirectory: vi.fn(async () => "/target"),
    formatSize: (bytes) => `${bytes} B`,
  };
}

describe("shared inspect viewer", () => {
  it("renders executable metadata through the injected inspection port", async () => {
    const runtime = runtimeFor({
      type: "executable",
      format: "mach-o",
      archs: [
        { arch: "x86_64", bits: 64, fileType: "executable" },
        { arch: "arm64", bits: 64, fileType: "executable" },
      ],
      interpreter: null,
      executableBit: true,
      hasCodeSignature: true,
      hasEntryPoint: true,
      dylibCount: 1,
      dylibs: ["/usr/lib/libSystem.B.dylib"],
    });

    await renderView(
      <InspectView
        meta={{ path: "/bin/tool", name: "tool", size: 900, mime: "application/x-executable" }}
        runtime={runtime}
      />
    );

    expect(runtime.inspect).toHaveBeenCalledWith("/bin/tool");
    expect(host?.textContent).toContain(STR.files.inspect.exec.formatMachO);
    expect(host?.textContent).toContain(STR.files.inspect.exec.universal);
    expect(host?.textContent).toContain("/usr/lib/libSystem.B.dylib");
  });

  it("routes both archive extraction destinations through runtime ports", async () => {
    const runtime = runtimeFor({
      type: "archive",
      entries: [{ path: "readme.md", size: 6, dir: false }],
      total: 1,
      truncated: false,
    });

    await renderView(
      <InspectView
        meta={{ path: "/work/bundle.zip", name: "bundle.zip", size: 120, mime: "application/zip" }}
        runtime={runtime}
      />
    );

    await clickButton(STR.files.inspect.extractHere);
    expect(runtime.extract).toHaveBeenCalledWith("/work/bundle.zip", "/work");

    await clickButton(STR.files.inspect.extractTo);
    expect(runtime.chooseDirectory).toHaveBeenCalledWith(
      STR.files.inspect.extractPickHint
    );
    expect(runtime.extract).toHaveBeenCalledWith("/work/bundle.zip", "/target");
  });
});
