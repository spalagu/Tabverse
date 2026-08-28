import {
  act,
  createRef,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR } from "../strings";
import {
  FilesWorkspacePane,
  describeFilesWorkspacePane,
  type FilesWorkspaceFile,
  type FilesWorkspacePaneProps,
  type FilesWorkspaceRenderers,
} from "./FilesWorkspacePane";
import { newPane, type PaneState } from "./panes";

interface TestFile extends FilesWorkspaceFile {
  git?: string | null;
}

function file(overrides: Partial<TestFile> = {}): TestFile {
  return {
    path: "/work/readme.md",
    name: "readme.md",
    size: 12,
    kind: "text",
    mime: "text/markdown",
    text: "# Hello",
    truncated: false,
    readOnlyReason: null,
    headText: null,
    git: null,
    ...overrides,
  };
}

function paneFor(current: TestFile): PaneState<TestFile> {
  return {
    ...newPane<TestFile>("/work"),
    open: [current],
    activePath: current.path,
  };
}

const renderers: FilesWorkspaceRenderers<TestFile> = {
  CodeEditor: ({ path, value, original }) => (
    <div
      data-view="editor"
      data-path={path}
      data-value={value}
      data-original={original ?? ""}
    />
  ),
  Preview: ({ meta }) => <div data-view="preview">{meta.name}</div>,
  PreviewFind: ({ isolated, onSearchSource }) => (
    <button
      data-view="find"
      data-isolated={String(isolated)}
      onClick={() => onSearchSource("needle")}
    />
  ),
  InspectView: ({ meta }) => <div data-view="inspect">{meta.name}</div>,
  MarkdownView: ({ text }) => <div data-view="markdown">{text}</div>,
  CsvView: ({ delimiter }) => <div data-view="csv">{delimiter}</div>,
  HtmlView: ({ onOpenInBrowser }) => (
    <button data-view="html" onClick={onOpenInBrowser} />
  ),
  NotebookView: () => <div data-view="notebook" />,
  LogView: ({ meta }) => <div data-view="log">{meta.name}</div>,
  EditorTabMenu: ({ at, onCompareWith }) => (
    <button data-view="tab-menu" onClick={() => onCompareWith?.(at.path)}>
      {at.path}
    </button>
  ),
};

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

function propsFor(
  pane: PaneState<TestFile>,
  overrides: Partial<FilesWorkspacePaneProps<TestFile>> = {}
): FilesWorkspacePaneProps<TestFile> {
  return {
    pane,
    active: true,
    missing: new Set(),
    comparison: null,
    restored: true,
    error: null,
    saving: false,
    showDiff: true,
    findOpen: false,
    revealLine: null,
    terminalOpen: false,
    containerRef: createRef<HTMLDivElement>(),
    keyHints: {
      save: "⌘S",
      quickOpen: "⌘P",
      locationBar: "⌘L",
      terminalPanel: "⌘J",
    },
    formatSize: (bytes) => `${bytes} B`,
    badgeFor: () => null,
    renderers,
    onActivate: vi.fn(),
    onPaneChange: vi.fn(),
    onCloseFile: vi.fn(),
    onCloseTabs: vi.fn(),
    onCompareWith: vi.fn(),
    onCloseCompare: vi.fn(),
    onSave: vi.fn(),
    onResolveConflict: vi.fn(),
    onModeChange: vi.fn(),
    onShowDiffChange: vi.fn(),
    onTerminalOpenChange: vi.fn(),
    onErrorChange: vi.fn(),
    onFindOpenChange: vi.fn(),
    onReveal: vi.fn(),
    onOpenHtmlInBrowser: vi.fn(),
    ...overrides,
  };
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent === label
  );
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

describe("shared files workspace pane", () => {
  it("derives the complete preview routing matrix from pane state", () => {
    expect(describeFilesWorkspacePane(paneFor(file())).showRendered).toBe(true);
    expect(
      describeFilesWorkspacePane(
        paneFor(
          file({
            path: "/work/run.sh",
            name: "run.sh",
            mime: "text/x-shellscript",
          })
        )
      ).inSource
    ).toBe(true);
    expect(
      describeFilesWorkspacePane(
        paneFor(file({ path: "/work/key.pem", name: "key.pem" }))
      ).showInspect
    ).toBe(true);
    expect(
      describeFilesWorkspacePane(
        paneFor(
          file({
            path: "/work/app.log",
            name: "app.log",
            truncated: true,
          })
        )
      ).isBigText
    ).toBe(true);
  });

  it("keeps a binary certificate in details without a source toggle", async () => {
    const certificate = file({
      path: "/work/certificate.der",
      name: "certificate.der",
      kind: "binary",
      mime: "application/pkix-cert",
      text: null,
    });
    await render(<FilesWorkspacePane {...propsFor(paneFor(certificate))} />);

    expect(host?.querySelector('[data-view="inspect"]')?.textContent).toBe(
      certificate.name
    );
    expect(
      Array.from(host?.querySelectorAll("button") ?? []).some(
        (candidate) => candidate.textContent === STR.files.view.modeSource
      )
    ).toBe(false);
  });

  it("owns tabs, view controls, terminal toggle, and the tab menu", async () => {
    const current = paneFor(file());
    const onModeChange = vi.fn();
    const onTerminalOpenChange = vi.fn();
    const onCompareWith = vi.fn();
    await render(
      <FilesWorkspacePane
        {...propsFor(current, {
          onModeChange,
          onTerminalOpenChange,
          onCompareWith,
        })}
      />
    );

    expect(host?.querySelector('[data-view="markdown"]')?.textContent).toBe(
      "# Hello"
    );
    await act(async () => button(STR.files.view.modeSource).click());
    expect(onModeChange).toHaveBeenCalledWith("source");
    await act(async () => button(STR.files.view.terminalToggle).click());
    expect(onTerminalOpenChange).toHaveBeenCalledWith(true);

    const tab = host?.querySelector<HTMLElement>(".editor-tab");
    await act(async () => {
      tab?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 20,
          clientY: 30,
        })
      );
    });
    const menu = host?.querySelector<HTMLButtonElement>('[data-view="tab-menu"]');
    expect(menu?.textContent).toBe("/work/readme.md");
    await act(async () => menu?.click());
    expect(onCompareWith).toHaveBeenCalledWith("/work/readme.md");
  });

  it("renders the conflict diff and routes both explicit decisions", async () => {
    const current = file();
    const pane = {
      ...paneFor(current),
      drafts: new Map([[current.path, "local draft"]]),
      conflicts: new Set([current.path]),
    };
    const onResolveConflict = vi.fn();
    await render(
      <FilesWorkspacePane
        {...propsFor(pane, { onResolveConflict })}
      />
    );

    const editor = host?.querySelector<HTMLElement>('[data-view="editor"]');
    expect(editor?.dataset.value).toBe("local draft");
    expect(editor?.dataset.original).toBe("# Hello");
    await act(async () => button(STR.files.view.keepDraft).click());
    await act(async () => button(STR.files.view.discardDraft).click());
    expect(onResolveConflict).toHaveBeenNthCalledWith(
      1,
      current.path,
      true
    );
    expect(onResolveConflict).toHaveBeenNthCalledWith(
      2,
      current.path,
      false
    );
  });

  it("renders a comparison snapshot without entering the file model cache", async () => {
    const left = file({
      path: "/work/a.txt",
      name: "a.txt",
      text: "left",
    });
    const right = file({
      path: "/work/b.txt",
      name: "b.txt",
      text: "right snapshot",
    });
    const pane = {
      ...paneFor(left),
      activePath: null,
      drafts: new Map([[left.path, "edited left"]]),
    };
    const onSave = vi.fn();
    await render(
      <FilesWorkspacePane
        {...propsFor(pane, {
          comparison: { a: left.path, b: right },
          onSave,
        })}
      />
    );

    const editor = host?.querySelector<HTMLElement>('[data-view="editor"]');
    expect(editor?.dataset.path).toBe(left.path);
    expect(editor?.dataset.value).toBe("edited left");
    expect(editor?.dataset.original).toBe("right snapshot");
    await act(async () => button(STR.files.view.save).click());
    expect(onSave).toHaveBeenCalledWith(left);
  });
});
