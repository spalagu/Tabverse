import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

type InspectView = typeof import("./InspectView");
type FileMeta = import("../../backend/fs").FileMeta;
type Inspection = import("../../backend/fs").Inspection;
type Strings = typeof import("../../strings");

const META: FileMeta = {
  path: "/w/cli-tool",
  name: "cli-tool",
  size: 900,
  kind: "binary",
  mime: "application/x-executable",
  text: null,
  truncated: false,
  readOnlyReason: null,
  headText: null,
  git: null,
  modified: 1000,
};

const SCRIPT_META: FileMeta = {
  ...META,
  path: "/w/run-task",
  name: "run-task",
  kind: "text",
  mime: "text/x-shellscript",
  text: "#!/usr/bin/env python3\n",
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

function render(
  View: InspectView["InspectView"],
  meta: FileMeta
): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  flushSync(() => root.render(createElement(View, { meta })));
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return host;
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  flushSync(() => {});
}

beforeEach(() => {
  mocks.invoke.mockReset();
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the executable card", () => {
  it("a universal Mach-O reports every architecture and the signature fact", async () => {
    const data: Inspection = {
      type: "executable",
      format: "mach-o",
      archs: [
        { arch: "x86_64", bits: 64, fileType: "executable" },
        { arch: "arm64e", bits: 64, fileType: "executable" },
      ],
      interpreter: null,
      executableBit: true,
      hasCodeSignature: true,
      hasEntryPoint: true,
      dylibCount: 9,
      dylibs: ["/usr/lib/libSystem.B.dylib"],
    };
    mocks.invoke.mockResolvedValue(data);
    const { InspectView: View, STR } = await fresh();
    const host = render(View, META);
    await settle();

    const text = host.textContent ?? "";
    expect(text).toContain(STR.files.inspect.exec.formatMachO);
    expect(text).toContain(STR.files.inspect.exec.universal);
    expect(text).toContain("x86_64");
    expect(text).toContain("arm64e");
    // The signature line is a header presence, never a verdict.
    expect(text).toContain(STR.files.inspect.exec.signedYes);
    expect(STR.files.inspect.exec.signedYes).toContain("not a verdict");
    expect(text).toContain("/usr/lib/libSystem.B.dylib");
    expect(text).toContain(
      STR.files.inspect.exec.dylibCountLabel({ n: 9 })
    );
  });

  it("an ELF reports its one architecture; unsigned Mach-O says so plainly", async () => {
    const data: Inspection = {
      type: "executable",
      format: "elf",
      archs: [{ arch: "x86_64", bits: 64, fileType: "shared object" }],
      interpreter: null,
      executableBit: false,
      hasCodeSignature: null,
      hasEntryPoint: null,
      dylibCount: null,
      dylibs: null,
    };
    mocks.invoke.mockResolvedValue(data);
    const { InspectView: View, STR } = await fresh();
    const host = render(View, META);
    await settle();
    const text = host.textContent ?? "";
    expect(text).toContain(STR.files.inspect.exec.formatElf);
    expect(text).toContain("shared object");
    expect(text).toContain(STR.files.inspect.exec.execBitOff);

    // Same card, unsigned Mach-O shape.
    const unsigned: Inspection = {
      ...data,
      format: "mach-o",
      hasCodeSignature: false,
      dylibCount: 0,
      dylibs: [],
    };
    mocks.invoke.mockResolvedValue(unsigned);
    const host2 = render(View, META);
    await settle();
    expect(host2.textContent).toContain(STR.files.inspect.exec.signedNo);
  });

  it("a script's card carries the interpreter line", async () => {
    const data: Inspection = {
      type: "executable",
      format: "script",
      archs: [],
      interpreter: "/usr/bin/env python3 -u",
      executableBit: true,
      hasCodeSignature: null,
      hasEntryPoint: null,
      dylibCount: null,
      dylibs: null,
    };
    mocks.invoke.mockResolvedValue(data);
    const { InspectView: View, STR } = await fresh();
    const host = render(View, SCRIPT_META);
    await settle();
    const text = host.textContent ?? "";
    expect(text).toContain(STR.files.inspect.exec.formatScript);
    expect(text).toContain("/usr/bin/env python3 -u");
    expect(text).toContain(STR.files.inspect.exec.execBitOn);
  });
});
