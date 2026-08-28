import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
  /** The per-path model cache, as the CodeEditor standin keeps it: the
   * path whose model exists. B's entry must never appear here from a
   * comparison — only from being opened as a normal tab. */
  modelCache: new Set<string>(),
  /** Every editor mount, newest last. */
  mounts: [] as {
    path: string;
    original: string | null;
    value: string;
  }[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));

vi.mock("./CodeEditor", () => ({
  CodeEditor: (props: {
    path: string;
    value: string;
    original?: string | null;
    onChange?: (v: string) => void;
    onSave?: () => void;
  }) => {
    // Mirrors the real cache rule: the owning side's model is registered
    // per path; an `original` string is built and disposed per mount and
    // never registered.
    mocks.modelCache.add(props.path);
    mocks.mounts.push({
      path: props.path,
      original: props.original ?? null,
      value: props.value,
    });
    return createElement("textarea", {
      className: "editor-standin",
      value: props.value,
      onChange: (e: { target: { value: string } }) =>
        props.onChange?.(e.target.value),
    });
  },
  disposeEditorState: () => {},
  openEditorFind: () => false,
}));

vi.mock("./TerminalPanel", () => ({
  TerminalPanel: () => createElement("div", { className: "term-standin" }),
}));

type FsView = typeof import("./FilesView");
type Strings = typeof import("../../strings");

/** /w1 holds a.txt, b.txt, c.txt — all text. */
function serve() {
  const contents = new Map<string, string>([
    ["/w1/a.txt", "alpha one\n"],
    ["/w1/b.txt", "beta two\n"],
    ["/w1/c.txt", "gamma three\n"],
  ]);
  mocks.invoke.mockImplementation(async (cmd, args) => {
    const a = args ?? {};
    switch (cmd) {
      case "fs_list": {
        const dir = a.dir as string;
        if (dir !== "/w1") throw new Error(`no such directory: ${dir}`);
        return {
          dir,
          parent: "/",
          entries: ["a.txt", "b.txt", "c.txt"].map((name) => ({
            name,
            path: `/w1/${name}`,
            isDir: false,
            isSymlink: false,
            size: 10,
            modified: 1000,
            git: null,
            gitFromChildren: false,
          })),
          repoRoot: null,
          branch: null,
        };
      }
      case "fs_read": {
        const path = a.path as string;
        const text = contents.get(path);
        if (text === undefined) throw new Error(`no such file: ${path}`);
        return {
          path,
          name: path.split("/").pop(),
          size: text.length,
          kind: "text",
          mime: "text/plain",
          text,
          truncated: false,
          readOnlyReason: null,
          headText: null,
          git: null,
          modified: 1000,
        };
      }
      case "fs_walk":
        return { paths: ["a.txt", "b.txt", "c.txt"], truncated: false };
      default:
        return undefined;
    }
  });
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const mounted: Array<() => void> = [];

async function fresh(): Promise<{
  FilesView: FsView["FilesView"];
  STR: Strings["STR"];
}> {
  vi.resetModules();
  mocks.modelCache.clear();
  mocks.mounts.length = 0;
  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) =>
      mocks.invoke(cmd, args),
  };
  const mod = await import("./FilesView");
  const strings = await import("../../strings");
  return { FilesView: mod.FilesView, STR: strings.STR };
}

type TabLike = Parameters<FsView["FilesView"]>[0]["tab"];

const tab = (id: string): TabLike =>
  ({
    id,
    type: "files",
    title: "w1",
    groupId: null,
    cwd: "/w1",
  }) as TabLike;

function render(View: FsView["FilesView"]): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  flushSync(() => root.render(createElement(View, { tab: tab("t"), active: true })));
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return host;
}

const row = (host: HTMLElement, name: string) =>
  Array.from(host.querySelectorAll<HTMLElement>(".tree-row")).find(
    (r) => r.querySelector(".tree-name")?.textContent === name
  )!;

const lastMountOf = (path: string) =>
  [...mocks.mounts].reverse().find((m) => m.path === path);

function mouse(el: Element, type: string, over: MouseEventInit = {}) {
  // Each interaction is flushed to its render before the next one — a
  // handler reads what earlier handlers committed, and a real hand is
  // always slower than React's commit.
  flushSync(() =>
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, ...over })
    )
  );
}

beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset();
  serve();
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("two-file comparison", () => {
  it("exactly two picked files open a compare tab; A is the cached side, B is the original", async () => {
    const { FilesView: View, STR } = await fresh();
    const host = render(View);
    await settle();

    // One picked row: no Compare item — "exactly two" is the rule.
    mouse(row(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(row(host, "a.txt"), "contextmenu", { button: 2 });
    await settle();
    expect(
      Array.from(host.querySelectorAll(".ctx-item")).some(
        (b) => b.textContent === STR.files.tree.compare
      )
    ).toBe(false);
    // Dismiss the menu.
    window.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );

    // Two picked rows: Compare appears and opens the tab.
    mouse(row(host, "b.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(row(host, "a.txt"), "contextmenu", { button: 2 });
    await settle();
    const compareBtn = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".ctx-item")
    ).find((b) => b.textContent === STR.files.tree.compare)!;
    expect(compareBtn).toBeTruthy();
    flushSync(() => compareBtn.click());
    await settle();

    // The strip holds A's ordinary tab plus the comparison tab, and the
    // comparison is the one in front.
    const tabs = Array.from(
      host.querySelectorAll(".editor-tab-name")
    ).map((t) => t.textContent);
    expect(tabs).toContain("a.txt");
    expect(tabs).toContain("a.txt ↔ b.txt");
    expect(
      host.querySelector(".editor-tab.compare-tab")?.classList.contains("active")
    ).toBe(true);

    // The editor mount is the comparison: A's path (the cached, editable
    // side) with B's text as the original string.
    const cmpMount = lastMountOf("/w1/a.txt")!;
    expect(cmpMount.original).toBe("beta two\n");
    expect(cmpMount.value).toBe("alpha one\n");
    // B's model was never registered — only A's cached model exists.
    expect(mocks.modelCache.has("/w1/b.txt")).toBe(false);
    expect(mocks.modelCache.has("/w1/a.txt")).toBe(true);
  });

  it("switching A's plain tab and back shows no cross-contamination", async () => {
    const { FilesView: View } = await fresh();
    const host = render(View);
    await settle();

    mouse(row(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(row(host, "b.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(row(host, "a.txt"), "contextmenu", { button: 2 });
    await settle();
    flushSync(() =>
      Array.from(host.querySelectorAll<HTMLButtonElement>(".ctx-item"))
        .find((b) => b.textContent === "Compare")!
        .click()
    );
    await settle();

    // To A's plain tab: an ordinary editor mount, no original.
    const plainTab = Array.from(
      host.querySelectorAll<HTMLElement>(".editor-tab")
    ).find((t) => t.querySelector(".editor-tab-name")?.textContent === "a.txt")!;
    flushSync(() => mouse(plainTab, "mousedown", { button: 0 }));
    await settle();
    const plainMount = lastMountOf("/w1/a.txt")!;
    expect(plainMount.original).toBeNull();
    expect(plainMount.value).toBe("alpha one\n");

    // Back to the comparison: the original is B again — the plain model
    // never picked the comparison's B up, and B stayed out of the cache.
    const cmpTab = host.querySelector<HTMLElement>(".editor-tab.compare-tab")!;
    flushSync(() => mouse(cmpTab, "mousedown", { button: 0 }));
    await settle();
    expect(lastMountOf("/w1/a.txt")!.original).toBe("beta two\n");
    expect(mocks.modelCache.has("/w1/b.txt")).toBe(false);

    // Opening B as a normal tab afterwards is an ordinary editor with its
    // own text — the comparison left no residue in B.
    flushSync(() => mouse(row(host, "b.txt"), "click"));
    await settle();
    const bMount = lastMountOf("/w1/b.txt")!;
    expect(bMount.original).toBeNull();
    expect(bMount.value).toBe("beta two\n");
  });

  it("an edit inside the comparison dirties A through the ordinary draft channel", async () => {
    const { FilesView: View } = await fresh();
    const host = render(View);
    await settle();

    mouse(row(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(row(host, "b.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(row(host, "a.txt"), "contextmenu", { button: 2 });
    await settle();
    flushSync(() =>
      Array.from(host.querySelectorAll<HTMLButtonElement>(".ctx-item"))
        .find((b) => b.textContent === "Compare")!
        .click()
    );
    await settle();

    const standin = host.querySelector<HTMLTextAreaElement>(".editor-standin")!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )!.set!;
    setter.call(standin, "alpha edited\n");
    standin.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    // The comparison's mount now carries the draft, and the dirty dot is
    // on the tab — the same channel a plain edit rides.
    expect(lastMountOf("/w1/a.txt")!.value).toBe("alpha edited\n");
    expect(host.querySelector(".editor-tab-dot")).toBeTruthy();
  });

  it('"Compare with…" from the editor tab menu opens the picker and lands the same view', async () => {
    const { FilesView: View, STR } = await fresh();
    const host = render(View);
    await settle();

    // Open A, then right-click its editor tab.
    flushSync(() => mouse(row(host, "a.txt"), "click"));
    await settle();
    const aTab = Array.from(
      host.querySelectorAll<HTMLElement>(".editor-tab")
    ).find((t) => t.querySelector(".editor-tab-name")?.textContent === "a.txt")!;
    mouse(aTab, "contextmenu", { button: 2 });
    await settle();
    const compareWith = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".ctx-item")
    ).find((b) => b.textContent === STR.files.editorTabMenu.compareWith)!;
    expect(compareWith).toBeTruthy();
    flushSync(() => compareWith.click());
    await settle();

    // The picker is QuickOpen-shaped and asks for the second file.
    const input = host.querySelector<HTMLInputElement>(".switcher-input")!;
    expect(input.placeholder).toBe(STR.files.view.comparePickerPlaceholder);

    // Pick c.txt: the comparison opens with c as the original.
    const pickRow = Array.from(
      host.querySelectorAll<HTMLElement>(".switcher-row")
    ).find((r) => r.querySelector(".switcher-title")?.textContent === "c.txt")!;
    flushSync(() => pickRow.click());
    await settle();
    expect(lastMountOf("/w1/a.txt")!.original).toBe("gamma three\n");
    expect(mocks.modelCache.has("/w1/c.txt")).toBe(false);
  });
});
