import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TERMINAL_UPLOAD_BYTES,
  splitTerminalTransferDestination,
  useTerminalFileTransfer,
  type TerminalFileTransferController,
  type TerminalFileTransferPorts,
  type TerminalUploadFile,
} from "./useTerminalFileTransfer";

let root: Root | null = null;
afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  root = null;
});

function file(name: string, text: string, size = text.length): TerminalUploadFile {
  return {
    name,
    size,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

function renderTransfer(overrides: Partial<TerminalFileTransferPorts> = {}) {
  const pull = vi.fn<TerminalFileTransferPorts["pull"]>(
    async () => "/local/report.txt"
  );
  const push = vi.fn<TerminalFileTransferPorts["push"]>(async () => {});
  const openLocalPath = vi.fn();
  const ports: TerminalFileTransferPorts = {
    remoteHost: "build.example",
    remoteCwd: "/srv/app",
    pullTarget: "/var/log/report.txt",
    pull,
    push,
    openLocalPath,
    pullError: () => ({ title: "Pull failed", detail: "offline" }),
    pushError: () => ({ title: "Push failed", detail: "denied" }),
    uploadTooLarge: (item) => ({
      title: `Too large: ${item.name}`,
      detail: item.name,
    }),
    uploadDone: (count, host) => `${count} uploaded to ${host}`,
    ...overrides,
  };
  let current!: TerminalFileTransferController;
  function Harness() {
    current = useTerminalFileTransfer(ports);
    return null;
  }
  const host = document.createElement("div");
  root = createRoot(host);
  act(() => root?.render(<Harness />));
  return { current: () => current, pull, push, openLocalPath };
}

describe("terminal file transfer", () => {
  it("parses a host and remote directory without losing nested colons", () => {
    expect(splitTerminalTransferDestination("host:/srv/a:b")).toEqual({
      host: "host",
      dir: "/srv/a:b",
    });
    expect(splitTerminalTransferDestination(":/srv")).toBeNull();
    expect(splitTerminalTransferDestination("host:")).toBeNull();
  });

  it("pulls the selected remote path and opens its local landing", async () => {
    const state = renderTransfer();
    await act(() => state.current().pullFromRemote());
    expect(state.pull).toHaveBeenCalledWith(
      "build.example",
      "/var/log/report.txt"
    );
    expect(state.openLocalPath).toHaveBeenCalledWith("/local/report.txt");
    expect(state.current().busy).toBe(false);
  });

  it("prefills the remote cwd and uploads files sequentially", async () => {
    const state = renderTransfer();
    act(() => state.current().startUpload([file("a.txt", "a"), file("b.txt", "b")]));
    expect(state.current().uploadPrompt?.destination).toBe(
      "build.example:/srv/app"
    );
    act(() => state.current().setUploadDestination("edge.example:/tmp"));
    await act(() => state.current().submitUpload());

    expect(state.push.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["edge.example", "/tmp", "a.txt"],
      ["edge.example", "/tmp", "b.txt"],
    ]);
    expect(Array.from(state.push.mock.calls[0]![3])).toEqual([97]);
    expect(state.current().uploadPrompt).toBeNull();
    expect(state.current().notice).toBe("2 uploaded to edge.example");
  });

  it("rejects an oversized upload before opening the prompt", () => {
    const state = renderTransfer();
    act(() =>
      state.current().startUpload([
        file("large.bin", "", MAX_TERMINAL_UPLOAD_BYTES + 1),
      ])
    );
    expect(state.current().error?.title).toBe("Too large: large.bin");
    expect(state.current().uploadPrompt).toBeNull();
  });

  it("surfaces pull and push errors through host-provided descriptions", async () => {
    const pullState = renderTransfer({
      pull: async () => {
        throw new Error("offline");
      },
    });
    await act(() => pullState.current().pullFromRemote());
    expect(pullState.current().error?.title).toBe("Pull failed");
    act(() => root?.unmount());
    root = null;

    const pushState = renderTransfer({
      push: async () => {
        throw new Error("denied");
      },
    });
    act(() => pushState.current().startUpload([file("a.txt", "a")]));
    await act(() => pushState.current().submitUpload());
    expect(pushState.current().error?.title).toBe("Push failed");
    expect(pushState.current().uploadPrompt).not.toBeNull();
  });
});
