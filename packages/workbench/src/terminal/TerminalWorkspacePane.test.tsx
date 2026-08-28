import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalWorkspacePane,
  type TerminalWorkspacePaneProps,
} from "./TerminalWorkspacePane";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function props(
  overrides: Partial<TerminalWorkspacePaneProps> = {},
): TerminalWorkspacePaneProps {
  return {
    containerRef: createRef<HTMLDivElement>(),
    broadcasting: true,
    focused: true,
    paneCount: 3,
    broadcastKeys: "Cmd+Shift+B",
    hoverLink: "/tmp/result.txt",
    badge: { text: "build-host", title: "Remote host build-host" },
    transferBusy: false,
    transferNotice: "Upload complete",
    transferError: null,
    onDismissTransferError: vi.fn(),
    contextMenu: { x: 20, y: 30 },
    onDismissContextMenu: vi.fn(),
    onToggleBroadcast: vi.fn(),
    pullAction: {
      label: "Pull from build-host",
      disabled: false,
      onRun: vi.fn(),
    },
    onOpenCwd: vi.fn(),
    blockActions: {
      copied: null,
      canRerun: true,
      onCopyCommand: vi.fn(),
      onCopyOutput: vi.fn(),
      onRerun: vi.fn(),
    },
    uploadPrompt: {
      host: "build-host",
      files: [{ name: "report.txt", size: 42 }],
      destination: "build-host:~/work",
      valid: true,
    },
    onDismissUpload: vi.fn(),
    onUploadDestinationChange: vi.fn(),
    onSubmitUpload: vi.fn(),
    pastePrompt: null,
    onDismissPaste: vi.fn(),
    onPasteChange: vi.fn(),
    onSubmitPaste: vi.fn(),
    completion: <div data-testid="completion">completion</div>,
    search: <div data-testid="search">search</div>,
    spawning: true,
    allowFileTransfer: true,
    onFilesDropped: vi.fn(),
    onOpenContextMenu: vi.fn(),
    onFocusPane: vi.fn(),
    onRulerPointerDown: vi.fn(),
    onRulerClick: vi.fn(),
    status: <div data-testid="status">status</div>,
    ...overrides,
  };
}

describe("TerminalWorkspacePane", () => {
  it("owns terminal banners, menus, transfer prompt and overlay slots", () => {
    const view = props();
    act(() => root.render(<TerminalWorkspacePane {...view} />));

    expect(host.textContent).toContain("build-host");
    expect(host.textContent).toContain("report.txt");
    expect(host.textContent).toContain("completion");
    expect(host.textContent).toContain("search");
    expect(host.querySelector(".term-loading")).not.toBeNull();

    const button = (label: string) =>
      Array.from(host.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === label,
      );
    act(() => button("Stop typing into every pane")?.click());
    expect(view.onToggleBroadcast).toHaveBeenCalledOnce();
    act(() => button("Copy output")?.click());
    expect(view.blockActions?.onCopyOutput).toHaveBeenCalledOnce();

    const destination = host.querySelector<HTMLInputElement>("#term-upload-dest");
    act(() =>
      destination?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(view.onSubmitUpload).toHaveBeenCalledOnce();
  });

  it("owns guarded-paste keyboard decisions and ruler geometry", () => {
    const view = props({
      contextMenu: null,
      uploadPrompt: null,
      pastePrompt: { text: "first\nsecond", lineCount: 2 },
    });
    act(() => root.render(<TerminalWorkspacePane {...view} />));

    const textarea = host.querySelector<HTMLTextAreaElement>(".term-paste-textarea");
    act(() =>
      textarea?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(view.onDismissPaste).toHaveBeenCalledOnce();

    const ruler = host.querySelector<HTMLElement>(".term-block-ruler-hit");
    act(() =>
      ruler?.dispatchEvent(
        new MouseEvent("click", { clientY: 18, bubbles: true }),
      ),
    );
    expect(view.onRulerClick).toHaveBeenCalledWith(18, 0, 0);
  });
});
