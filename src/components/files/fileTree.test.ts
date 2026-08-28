import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
  confirm: vi.fn<(msg: string, choices: unknown[]) => Promise<string | null>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("../Confirm", () => ({
  confirmChoose: (msg: string, choices: unknown[]) => mocks.confirm(msg, choices),
  confirmAsk: async () => false,
}));

type Tree = typeof import("./FileTree");
type Filter = typeof import("./treeFilter");
type Strings = typeof import("../../strings");

/** /w1: sdk/, sub/, a.txt, c.txt; sdk/ holds inner-dir/; sub/ holds inner.txt. */
function serve() {
  mocks.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "fs_list") {
      const dir = args?.dir as string;
      const table: Record<string, { name: string; isDir: boolean }[]> = {
        "/w1": [
          { name: "sdk", isDir: true },
          { name: "sub", isDir: true },
          { name: "a.txt", isDir: false },
          { name: "c.txt", isDir: false },
        ],
        "/w1/sdk": [{ name: "inner-dir", isDir: true }],
        "/w1/sdk/inner-dir": [{ name: "z.txt", isDir: false }],
        "/w1/sub": [{ name: "inner.txt", isDir: false }],
      };
      const entries = table[dir];
      if (!entries) throw new Error(`no such directory: ${dir}`);
      return {
        dir,
        parent: "/",
        entries: entries.map((e) => ({
          name: e.name,
          path: `${dir}/${e.name}`,
          isDir: e.isDir,
          isSymlink: false,
          size: 0,
          modified: 1,
          git: null,
          gitFromChildren: false,
        })),
        repoRoot: null,
        branch: null,
      };
    }
    if (cmd === "fs_transfer") {
      // The landing path: the directory plus the carried name, which is
      // the shape fs_transfer answers with (30.2's yield aside — a test
      // that needs a yielded name overrides this).
      const from = args?.from as string;
      const into = args?.intoDir as string;
      return `${into}/${from.split("/").pop()}`;
    }
    if (cmd === "fs_trash") return undefined;
    return undefined;
  });
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const mounted: Array<() => void> = [];

async function fresh(): Promise<{
  FileTree: Tree["FileTree"];
  filterRows: Filter["filterRows"];
  STR: Strings["STR"];
  useStore: typeof import("../../state/store").useStore;
}> {
  vi.resetModules();
  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) =>
      mocks.invoke(cmd, args),
  };
  const tree = await import("./FileTree");
  const filter = await import("./treeFilter");
  const strings = await import("../../strings");
  // Same module graph as FileTree, so the store writes the tree makes are
  // the store this test reads.
  const store = await import("../../state/store");
  // The label lookup below reads whatever graph the last render used.
  (globalThis as Record<string, unknown>).__str = strings.STR;
  return {
    FileTree: tree.FileTree,
    filterRows: filter.filterRows,
    STR: strings.STR,
    useStore: store.useStore,
  };
}

/**
 * The tree plus everything its controlled props hold: the expansion set
 * and the picking, with a live read on each. Both are controlled, the way
 * FilesView drives them, so the harness owns the state and re-renders on
 * every update.
 */
function mountTree(FileTree: Tree["FileTree"]): {
  host: HTMLElement;
  expanded: () => Set<string>;
  picked: () => { selectedPaths: string[]; selectionAnchor: string | null };
  recorded: () => unknown[];
  compressCalls: () => [string[], string, "zip" | "tgz"][];
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const recorded: unknown[] = [];
  const compress: [string[], string, "zip" | "tgz"][] = [];
  // A working expansion holder: the tree is controlled, so the harness
  // owns the set and re-renders on every update, the way FilesView does.
  let expanded = new Set<string>();
  let sel = {
    selectedPaths: [] as string[],
    selectionAnchor: null as string | null,
  };
  const draw = () =>
    flushSync(() =>
      root.render(
        createElement(FileTree, {
          root: "/w1",
          selected: null,
          onSelect: () => {},
          onRootChange: () => {},
          refreshToken: 0,
          onBranch: () => {},
          showHidden: false,
          onMutate: () => {},
          expanded,
          setExpanded: (updater) => {
            expanded =
              typeof updater === "function"
                ? updater(expanded)
                : (updater as Set<string>);
            draw();
          },
          sort: { key: "name", asc: true, dirsFirst: true },
          selectedPaths: sel.selectedPaths,
          recordUndo: (e) => recorded.push(e),
          onCompress: (paths, destDir, format) =>
            compress.push([paths, destDir, format]),
          applySelection: (fn) => {
            const next = fn(sel as never);
            sel = {
              selectedPaths: next.selectedPaths,
              selectionAnchor: next.selectionAnchor,
            };
            draw();
          },
        })
      )
    );
  draw();
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return {
    host,
    expanded: () => expanded,
    picked: () => sel,
    recorded: () => recorded,
    compressCalls: () => compress,
  };
}

function renderTree(FileTree: Tree["FileTree"]): HTMLElement {
  return mountTree(FileTree).host;
}

const rowNames = (host: HTMLElement) =>
  Array.from(host.querySelectorAll(".tree-row .tree-name")).map(
    (n) => n.textContent
  );

/** The fake listing, as the tree's cache holds it. */
function listing(dir: string): import("../../backend/fs").FsEntry[] {
  const table: Record<string, string[]> = {
    "/w1": ["sdk/", "sub/", "a.txt", "c.txt"],
    "/w1/sub": ["inner.txt"],
  };
  return (table[dir] ?? []).map((name) => ({
    name: name.replace("/", ""),
    path: `${dir}/${name.replace("/", "")}`,
    isDir: name.endsWith("/"),
    isSymlink: false,
    size: 0,
    modified: 1,
    git: null,
    gitFromChildren: false,
  }));
}

function key(el: Element | Window, k: string, over: KeyboardEventInit = {}) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: k,
      bubbles: true,
      cancelable: true,
      ...over,
    })
  );
}

function mouse(
  el: Element,
  type: "mousedown" | "mouseup" | "click" | "contextmenu",
  over: MouseEventInit = {}
) {
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, ...over })
  );
}

/**
 * A drag event with a real DataTransfer riding on it — happy-dom has the
 * data store but no DragEvent constructor, so a MouseEvent of the drag
 * type carries the store as a defined property, which is all React's
 * synthetic handler reads.
 */
function drag(
  el: Element,
  type: "dragstart" | "dragover" | "dragleave" | "drop" | "dragend",
  dt?: DataTransfer,
  over: MouseEventInit = {}
) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...over });
  if (dt) Object.defineProperty(ev, "dataTransfer", { value: dt });
  el.dispatchEvent(ev);
  return ev;
}

// happy-dom's setDragImage is a declared-but-unimplemented stub that
// throws; the ghost it positions only exists under a real cursor.
DataTransfer.prototype.setDragImage = function () {};

const rowBy = (host: HTMLElement, name: string) =>
  Array.from(host.querySelectorAll<HTMLElement>(".tree-row")).find(
    (r) => r.querySelector(".tree-name")?.textContent === name
  )!;

async function waitForRow(host: HTMLElement, name: string): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = Array.from(host.querySelectorAll<HTMLElement>(".tree-row")).find(
      (candidate) => candidate.querySelector(".tree-name")?.textContent === name
    );
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`tree row did not render: ${name}`);
}

const pickedNames = (host: HTMLElement) =>
  Array.from(host.querySelectorAll(".tree-row.picked .tree-name")).map(
    (n) => n.textContent
  );

const transfers = () =>
  mocks.invoke.mock.calls.filter((c) => c[0] === "fs_transfer");

beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.confirm.mockReset();
  serve();
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("type-to-filter in the tree", () => {
  it("typing with the tree focused filters, counts, and restores on Escape", async () => {
    const { FileTree, filterRows, STR } = await fresh();
    const host = renderTree(FileTree);
    await settle();
    expect(rowNames(host)).toEqual(["sdk", "sub", "a.txt", "c.txt"]);

    const rows = host.querySelector<HTMLElement>(".tree-rows")!;
    rows.focus();
    key(rows, "t");
    await settle();

    // The strip echoes the query and the count of what survives.
    expect(host.querySelector(".tree-filter")).not.toBeNull();
    expect(host.querySelector(".tree-filter-text")?.textContent).toBe("t");
    expect(host.querySelector(".tree-filter-count")?.textContent).toBe(
      STR.files.filter.count({ shown: 2, total: 4 })
    );

    // What is drawn is what the queryable state says — the same call over
    // the same cache the tree loaded.
    const children = new Map([
      [
        "/w1",
        [
          { name: "sdk", path: "/w1/sdk", isDir: true },
          { name: "sub", path: "/w1/sub", isDir: true },
          { name: "a.txt", path: "/w1/a.txt", isDir: false },
          { name: "c.txt", path: "/w1/c.txt", isDir: false },
        ].map((e) => ({
          ...e,
          isSymlink: false,
          size: 0,
          modified: 1,
          git: null,
          gitFromChildren: false,
        })),
      ],
    ]);
    const queryable = filterRows(children, "/w1", false, {
      text: "t",
      kind: "all",
    });
    expect(queryable.rows.map((r) => r.entry.name)).toEqual(rowNames(host));

    // Backspace edits the query; Escape clears it and the tree returns.
    // ("tq" matches nothing — note that even "tx" would, inside ".txt".)
    const rowsNow = () => host.querySelector<HTMLElement>(".tree-rows")!;
    key(rowsNow(), "q");
    await settle();
    expect(rowNames(host)).toEqual([]);
    key(rowsNow(), "Backspace");
    await settle();
    expect(rowNames(host)).toEqual(["a.txt", "c.txt"]);
    key(rowsNow(), "Escape");
    await settle();
    expect(host.querySelector(".tree-filter")).toBeNull();
    expect(rowNames(host)).toEqual(["sdk", "sub", "a.txt", "c.txt"]);
  });

  it("the kind buttons narrow to folders or files", async () => {
    const { FileTree } = await fresh();
    const host = renderTree(FileTree);
    await settle();
    const rows = host.querySelector<HTMLElement>(".tree-rows")!;
    rows.focus();
    key(rows, "s");
    await settle();

    // The kind rule combines with the text: nothing matches "s" among
    // the files. Clearing the text leaves the kind alone.
    const buttons = () =>
      Array.from(
        host.querySelectorAll<HTMLButtonElement>(".tree-filter .mini-btn")
      );
    const byLabel = (label: string) =>
      buttons().find((b) => b.textContent === label)!;
    flushSync(() => byLabel(STR_LABELS().files.filter.files).click());
    await settle();
    expect(rowNames(host)).toEqual([]);
    key(rows, "Backspace");
    await settle();
    // Kind-only, no text: the files, then the folders.
    expect(rowNames(host)).toEqual(["a.txt", "c.txt"]);
    flushSync(() => byLabel(STR_LABELS().files.filter.dirs).click());
    await settle();
    expect(rowNames(host)).toEqual(["sdk", "sub"]);
  });

  it("a match hiding in a collapsed-but-loaded folder is found, drawn, and queryable", async () => {
    const { FileTree, filterRows } = await fresh();
    const host = renderTree(FileTree);
    await settle();

    // Load sub by expanding it, then collapse it again: the cache holds
    // its children while the walk (and a render-time skip over the walk)
    // does not.
    const sub = Array.from(host.querySelectorAll<HTMLElement>(".tree-row")).find(
      (r) => r.querySelector(".tree-name")?.textContent === "sub"
    )!;
    flushSync(() => sub.click());
    await settle();
    expect(rowNames(host)).toContain("inner.txt");
    flushSync(() => sub.click());
    await settle();
    expect(rowNames(host)).not.toContain("inner.txt");

    const rows = host.querySelector<HTMLElement>(".tree-rows")!;
    rows.focus();
    for (const ch of "inner") key(rows, ch);
    await settle();
    // Found in the loaded-but-collapsed directory, drawn…
    expect(rowNames(host)).toEqual(["inner.txt"]);
    // …and the queryable state agrees with exactly what is on screen —
    // this is the line a render-time skip over the walk cannot pass.
    const cache = new Map<string, ReturnType<typeof listing>>([
      ["/w1", listing("/w1")],
      ["/w1/sub", listing("/w1/sub")],
    ]);
    const queryable = filterRows(cache, "/w1", false, {
      text: "inner",
      kind: "all",
    });
    expect(queryable.rows.map((r) => r.entry.name)).toEqual(rowNames(host));
    expect(queryable.total).toBe(5);
  });

  it("blurred, the tree does not take bare letters — they are the editor's", async () => {
    const { FileTree } = await fresh();
    const host = renderTree(FileTree);
    await settle();
    // Nothing focused into the tree; the letter goes to the window.
    key(window, "t");
    await settle();
    expect(host.querySelector(".tree-filter")).toBeNull();
    expect(rowNames(host)).toEqual(["sdk", "sub", "a.txt", "c.txt"]);
  });

  it("an input method mid-composition owns the keyboard", async () => {
    const { FileTree } = await fresh();
    const host = renderTree(FileTree);
    await settle();
    const rows = host.querySelector<HTMLElement>(".tree-rows")!;
    rows.focus();
    key(rows, "t", { isComposing: true } as KeyboardEventInit);
    await settle();
    expect(host.querySelector(".tree-filter")).toBeNull();
  });
});

/** The strings of the module graph the last render used. */
function STR_LABELS(): Strings["STR"] {
  return (globalThis as unknown as { __str: Strings["STR"] }).__str;
}

describe("multi-select in the tree", () => {
  it("⌘ picks and unpicks; ⇧ ranges by drawn order, collapsed children out of the sequence", async () => {
    const { FileTree } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    expect(rowNames(host)).toEqual(["sdk", "sub", "a.txt", "c.txt"]);

    // Scatter-pick two, unpick one back out (the anchor follows the
    // toggle, on the way in and on the way out — the sidebar's rule).
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "c.txt"), "mousedown", { metaKey: true, button: 0 });
    expect(pickedNames(host)).toEqual(["a.txt", "c.txt"]);
    mouse(rowBy(host, "c.txt"), "mousedown", { metaKey: true, button: 0 });
    expect(pickedNames(host)).toEqual(["a.txt"]);

    // A range counts in drawn order from the last ⌘-picked anchor…
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "c.txt"), "mousedown", { shiftKey: true, button: 0 });
    expect(pickedNames(host)).toEqual(["a.txt", "c.txt"]);
    // …backwards too: the anchor holds below, the row lands above.
    mouse(rowBy(host, "sdk"), "mousedown", { shiftKey: true, button: 0 });
    expect(pickedNames(host)).toEqual(["sdk", "sub", "a.txt"]);

    // The contract, pinned: an unexpanded directory's row IS in the
    // sequence, its children are not — nothing here expands anything.
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "sdk"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "a.txt"), "mousedown", { shiftKey: true, button: 0 });
    expect(pickedNames(host)).toEqual(["sdk", "sub", "a.txt"]);
    expect(rowNames(host)).not.toContain("inner.txt");
  });

  it("⌘A takes what is on screen — the filter's matches, and only them", async () => {
    const { FileTree } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    const rows = host.querySelector<HTMLElement>(".tree-rows")!;
    rows.focus();
    key(rows, "t");
    await settle();
    expect(rowNames(host)).toEqual(["a.txt", "c.txt"]);

    key(rows, "a", { metaKey: true });
    await settle();
    expect(pickedNames(host)).toEqual(["a.txt", "c.txt"]);

    key(rows, "Escape");
    await settle();
    key(rows, "a", { metaKey: true });
    await settle();
    expect(pickedNames(host)).toEqual(["sdk", "sub", "a.txt", "c.txt"]);
  });

  it("release judgement: a press on a picked row keeps the set for the drag; the release without one collapses it", async () => {
    const { FileTree, useStore } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "c.txt"), "mousedown", { metaKey: true, button: 0 });
    expect(pickedNames(host)).toEqual(["a.txt", "c.txt"]);

    // The plain press that begins a drag does NOT collapse the picking —
    // clearing here is the bug that made every multi-row drag carry one
    // row (the sidebar's root-cause fix, restated where it lives now).
    mouse(rowBy(host, "a.txt"), "mousedown", { button: 0 });
    expect(pickedNames(host)).toEqual(["a.txt", "c.txt"]);

    const dt = new DataTransfer();
    drag(rowBy(host, "a.txt"), "dragstart", dt);
    expect(useStore.getState().draggingFilePaths).toEqual([
      "/w1/a.txt",
      "/w1/c.txt",
    ]);
    expect(JSON.parse(dt.getData("text/tabverse-paths"))).toEqual([
      "/w1/a.txt",
      "/w1/c.txt",
    ]);
    drag(rowBy(host, "a.txt"), "dragend", dt);
    expect(useStore.getState().draggingFilePaths).toEqual([]);
    // The dragend resets its flag a turn late (so the release that ends a
    // drag is never a plain click) — give the turn its turn.
    await settle();

    // The release half: pressed on a picked row, released with no drag,
    // the picking collapses — and the click still means click. (The drag
    // above deliberately left the picking standing; the collapse starts
    // from a fresh scatter-pick.)
    mouse(rowBy(host, "a.txt"), "mousedown", { button: 0 });
    mouse(rowBy(host, "a.txt"), "mouseup", { button: 0 });
    expect(pickedNames(host)).toEqual([]);
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "c.txt"), "mousedown", { metaKey: true, button: 0 });
    expect(pickedNames(host)).toEqual(["a.txt", "c.txt"]);
    mouse(rowBy(host, "a.txt"), "mousedown", { button: 0 });
    expect(pickedNames(host)).toEqual(["a.txt", "c.txt"]);
    mouse(rowBy(host, "a.txt"), "mouseup", { button: 0 });
    expect(pickedNames(host)).toEqual([]);
  });

  it("right-click on a picked row: the count is in the label, the action takes the set", async () => {
    const { FileTree, STR, useStore } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "c.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "a.txt"), "contextmenu", { button: 2 });
    await settle();

    const cut = Array.from(host.querySelectorAll<HTMLButtonElement>(".ctx-item")).find(
      (b) =>
        b.textContent?.includes(
          STR.files.tree.withCount({ label: STR.files.tree.cut, n: 2 })
        )
    )!;
    expect(cut).toBeTruthy();
    flushSync(() => cut.click());
    expect(useStore.getState().fileClipboard).toEqual({
      path: "/w1/a.txt",
      paths: ["/w1/a.txt", "/w1/c.txt"],
      cut: true,
    });

    // Opened on a row outside the picking, the menu answers for that row
    // alone, with no count to read.
    mouse(rowBy(host, "sdk"), "contextmenu", { button: 2 });
    await settle();
    const plain = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".ctx-item")
    ).find((b) => b.textContent?.includes(STR.files.tree.cut))!;
    expect(plain.textContent).not.toContain("2 items");
    expect(pickedNames(host)).toEqual([]);
  });

  it("⌘X then ⌘V moves the whole clipboard; the picking lands where the answers said", async () => {
    const { FileTree, useStore } = await fresh();
    // fs_transfer answers with a yielded name for this one paste, so the
    // landing has to follow the ANSWER — a picking built from the
    // requested path would point at a file that is not there.
    const baseImpl = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "fs_transfer") {
        const from = (args?.from as string).split("/").pop()!;
        return `/w1/sub/${from.replace(/(\.[^.]*)$/, " 2$1")}`;
      }
      return baseImpl(cmd, args);
    });

    const { host, picked } = mountTree(FileTree);
    await settle();
    const rows = host.querySelector<HTMLElement>(".tree-rows")!;
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "c.txt"), "mousedown", { metaKey: true, button: 0 });
    key(rows, "x", { metaKey: true });
    await settle();
    expect(useStore.getState().fileClipboard?.paths).toEqual([
      "/w1/a.txt",
      "/w1/c.txt",
    ]);

    // Aiming at sub: the paste goes into it, once per path, in order.
    mouse(rowBy(host, "sub"), "mousedown", { button: 0 });
    key(rows, "v", { metaKey: true });
    await settle();
    expect(transfers().map(([, args]) => args)).toEqual([
      { from: "/w1/a.txt", intoDir: "/w1/sub", cut: true, overwrite: false },
      { from: "/w1/c.txt", intoDir: "/w1/sub", cut: true, overwrite: false },
    ]);
    expect(useStore.getState().fileClipboard).toBeNull();
    // The picking holds the yielded names the transfers answered with —
    // sub stays collapsed here, so this is the pane state, not the DOM.
    expect(picked().selectedPaths).toEqual([
      "/w1/sub/a 2.txt",
      "/w1/sub/c 2.txt",
    ]);
  });
});

describe("copying files out to other apps", () => {
  it("the menu writes the picked set to the system pasteboard, and nothing moves", async () => {
    const { FileTree, STR, useStore } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "c.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "a.txt"), "contextmenu", { button: 2 });
    await settle();

    // The item says how many it will take, like every batch action.
    const item = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".ctx-item")
    ).find((b) => b.textContent?.includes(STR.files.tree.copyToClipboard))!;
    expect(item.textContent).toBe(
      STR.files.tree.withCount({ label: STR.files.tree.copyToClipboard, n: 2 })
    );
    flushSync(() => item.click());
    await settle();

    // The command shape: the picked paths, whole, as one write. The TYPE
    // the pasteboard ends up carrying (file URL, not text — the
    // false-success shape) is pinned on the Rust side, where the
    // pasteboard is.
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === "clipboard_write_files")
    ).toEqual([["clipboard_write_files", { paths: ["/w1/a.txt", "/w1/c.txt"] }]]);

    // Copy semantics: the sources stay — no transfer, no trash, no cut.
    expect(transfers()).toEqual([]);
    expect(mocks.invoke.mock.calls.some((c) => c[0] === "fs_trash")).toBe(false);
    expect(useStore.getState().fileClipboard).toBeNull();
  });
});

describe("batch conflicts ask once", () => {
  /** /w1/sub already holds a.txt — the name a batch paste would clash on. */
  function subHoldsA() {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "fs_list" && (args?.dir as string) === "/w1/sub") {
        return {
          dir: "/w1/sub",
          parent: "/w1",
          entries: ["a.txt", "inner.txt"].map((name) => ({
            name,
            path: `/w1/sub/${name}`,
            isDir: false,
            isSymlink: false,
            size: 0,
            modified: 1,
            git: null,
            gitFromChildren: false,
          })),
          repoRoot: null,
          branch: null,
        };
      }
      return base(cmd, args);
    });
  }

  /** The picked pair a.txt + c.txt, cut, aimed at sub, pasted. */
  async function pastePair(host: HTMLElement) {
    const rows = host.querySelector<HTMLElement>(".tree-rows")!;
    mouse(await waitForRow(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(await waitForRow(host, "c.txt"), "mousedown", { metaKey: true, button: 0 });
    key(rows, "x", { metaKey: true });
    await settle();
    mouse(await waitForRow(host, "sub"), "mousedown", { button: 0 });
    key(rows, "v", { metaKey: true });
    await settle();
  }

  it("a clashing batch asks once; Replace carries the flag to every item and the stack marks it undone-forever", async () => {
    subHoldsA();
    mocks.confirm.mockResolvedValue("replace");
    const { FileTree, STR } = await fresh();
    const { host, recorded } = mountTree(FileTree);
    await settle();
    await pastePair(host);

    const ask = mocks.confirm.mock.calls[0];
    expect(ask?.[0]).toBe(
      STR.files.tree.conflictAsk({ clashes: 1, total: 2, dir: "sub" })
    );
    // The three ways forward, Replace the flagged danger one.
    const choices = ask?.[1] as { label: string; value: string; danger?: boolean }[];
    expect(choices.map((c) => [c.label, !!c.danger])).toEqual([
      [STR.files.tree.conflictSkip, false],
      [STR.files.tree.conflictKeepBoth, false],
      [STR.files.tree.conflictReplace, true],
    ]);

    // Only the clashing item carries the flag; the innocent one stays an
    // ordinary transfer (and an undoable one).
    expect(transfers().map(([, a]) => a)).toEqual([
      { from: "/w1/a.txt", intoDir: "/w1/sub", cut: true, overwrite: true },
      { from: "/w1/c.txt", intoDir: "/w1/sub", cut: true, overwrite: false },
    ]);
    expect(recorded()).toContainEqual({ kind: "overwritten", path: "/w1/sub/a.txt" });
    expect(recorded()).toContainEqual({
      kind: "transfer",
      cut: true,
      src: "/w1/c.txt",
      landed: "/w1/sub/c.txt",
    });
  });

  it("Skip leaves the clashes where they are and reports all three counts", async () => {
    subHoldsA();
    mocks.confirm.mockResolvedValue("skip");
    const { FileTree, STR } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    await pastePair(host);

    expect(transfers().map(([, a]) => a)).toEqual([
      { from: "/w1/c.txt", intoDir: "/w1/sub", cut: true, overwrite: false },
    ]);
    expect(host.querySelector(".error-state-title")?.textContent).toBe(
      STR.files.tree.batchReport({ added: 1, skipped: 1, failed: 0 })
    );
  });

  it("Keep both is the ordinary yield — no flag, no report", async () => {
    subHoldsA();
    mocks.confirm.mockResolvedValue("keep-both");
    const { FileTree } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    await pastePair(host);

    expect(transfers().map(([, a]) => a)).toEqual([
      { from: "/w1/a.txt", intoDir: "/w1/sub", cut: true, overwrite: false },
      { from: "/w1/c.txt", intoDir: "/w1/sub", cut: true, overwrite: false },
    ]);
    expect(host.querySelector(".error-state")).toBeNull();
  });

  it("cancel — and a missing dialog, the same answer — moves nothing at all", async () => {
    subHoldsA();
    // No ConfirmHost mounted: confirmChoose resolves null. The scripted
    // mock stands in for exactly that.
    mocks.confirm.mockResolvedValue(null);
    const { FileTree } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    await pastePair(host);

    expect(transfers()).toEqual([]);
    expect(host.querySelector(".error-state")).toBeNull();
  });

  it("a single clashing item never asks — it yields, the 30.2 default", async () => {
    subHoldsA();
    const { FileTree } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    const rows = host.querySelector<HTMLElement>(".tree-rows")!;
    mouse(rowBy(host, "a.txt"), "mousedown", { button: 0 });
    key(rows, "x", { metaKey: true });
    await settle();
    mouse(rowBy(host, "sub"), "mousedown", { button: 0 });
    key(rows, "v", { metaKey: true });
    await settle();

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(transfers().map(([, a]) => a)).toEqual([
      { from: "/w1/a.txt", intoDir: "/w1/sub", cut: true, overwrite: false },
    ]);
  });
});

describe("tree drag moves files", () => {
  it("a synthetic drag: payload shape, fs_transfer shape, and the landing picked", async () => {
    const { FileTree } = await fresh();
    const { host, picked } = mountTree(FileTree);
    await settle();
    const dt = new DataTransfer();
    mouse(rowBy(host, "a.txt"), "mousedown", { button: 0 });
    drag(rowBy(host, "a.txt"), "dragstart", dt);
    expect(JSON.parse(dt.getData("text/tabverse-paths"))).toEqual(["/w1/a.txt"]);

    const over = drag(rowBy(host, "sub"), "dragover", dt);
    expect(over.defaultPrevented).toBe(true);

    drag(rowBy(host, "sub"), "drop", dt);
    await settle();
    expect(transfers().map(([, args]) => args)).toEqual([
      { from: "/w1/a.txt", intoDir: "/w1/sub", cut: true, overwrite: false },
    ]);
    // The drop's own answer is where the picking lands (the return value
    // two paste call sites used to drop on the floor).
    expect(picked().selectedPaths).toEqual(["/w1/sub/a.txt"]);
  });

  it("⌥ held at the drop copies instead of moving", async () => {
    const { FileTree } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    const dt = new DataTransfer();
    drag(rowBy(host, "a.txt"), "dragstart", dt);
    drag(rowBy(host, "sub"), "dragover", dt, { altKey: true });
    drag(rowBy(host, "sub"), "drop", dt, { altKey: true });
    await settle();
    expect(transfers().map(([, args]) => args)).toEqual([
      { from: "/w1/a.txt", intoDir: "/w1/sub", cut: false, overwrite: false },
    ]);
  });

  it("a picked group drags as one: every path on the payload, every transfer in picking order", async () => {
    const { FileTree } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    mouse(rowBy(host, "sdk"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "c.txt"), "mousedown", { metaKey: true, button: 0 });

    const dt = new DataTransfer();
    mouse(rowBy(host, "a.txt"), "mousedown", { button: 0 });
    drag(rowBy(host, "a.txt"), "dragstart", dt);
    expect(JSON.parse(dt.getData("text/tabverse-paths"))).toEqual([
      "/w1/sdk",
      "/w1/a.txt",
      "/w1/c.txt",
    ]);
    drag(rowBy(host, "sub"), "dragover", dt);
    drag(rowBy(host, "sub"), "drop", dt);
    await settle();
    expect(transfers().map(([, args]) => (args as { from: string }).from)).toEqual([
      "/w1/sdk",
      "/w1/a.txt",
      "/w1/c.txt",
    ]);
  });

  it("spring-loaded: 600ms over a closed folder expands it; a drag that ended does not", async () => {
    const { FileTree } = await fresh();
    const { host, expanded } = mountTree(FileTree);
    await settle();
    // Load sdk's listing first (expand, settle, collapse) so the spring's
    // fire has children to draw from — the fake clock never gates the
    // listing that way, and expansion is what this test is about.
    mouse(rowBy(host, "sdk"), "click");
    await settle();
    mouse(rowBy(host, "sdk"), "click");
    await settle();
    expect(rowNames(host)).not.toContain("inner-dir");

    const dt = new DataTransfer();
    drag(rowBy(host, "a.txt"), "dragstart", dt);

    vi.useFakeTimers();
    try {
      drag(rowBy(host, "sdk"), "dragover", dt);
      vi.advanceTimersByTime(599);
      expect(expanded().has("/w1/sdk")).toBe(false);
      vi.advanceTimersByTime(1);
      expect(expanded().has("/w1/sdk")).toBe(true);
      // The harness re-renders inside setExpanded, so the opened folder's
      // row is on screen the moment the timer fired.
      expect(rowNames(host)).toContain("inner-dir");
    } finally {
      vi.useRealTimers();
    }
    drag(rowBy(host, "a.txt"), "dragend", dt);

    // The fire-time re-check: the payload still says its type, but the
    // drag is over (memory cleared) — the timer must not open anything.
    const dt2 = new DataTransfer();
    drag(rowBy(host, "c.txt"), "dragstart", dt2);
    drag(rowBy(host, "a.txt"), "dragend", dt2);
    vi.useFakeTimers();
    try {
      drag(rowBy(host, "sub"), "dragover", dt2);
      vi.advanceTimersByTime(700);
      expect(expanded().has("/w1/sub")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("into itself or its own subtree: dragover says no-drop, and the drop transfers nothing", async () => {
    const { FileTree } = await fresh();
    const { host } = mountTree(FileTree);
    await settle();
    // Load the subtree so a child of the dragged folder is on screen.
    mouse(rowBy(host, "sdk"), "click");
    await settle();
    expect(rowNames(host)).toContain("inner-dir");

    // Onto itself.
    const dt = new DataTransfer();
    drag(rowBy(host, "sub"), "dragstart", dt);
    const overSelf = drag(rowBy(host, "sub"), "dragover", dt);
    expect(overSelf.defaultPrevented).toBe(false);
    // dragover is a continuous event — React flushes it a beat later, so
    // the class is read after the beat, not inside the dispatch.
    await settle();
    expect(rowBy(host, "sub").className).toContain("no-drop");
    drag(rowBy(host, "sub"), "drop", dt);
    await settle();
    expect(transfers()).toEqual([]);

    // Onto its own child — the guard the backend already holds
    // (dir.starts_with), said at dragover instead of failed at the drop.
    const dt2 = new DataTransfer();
    drag(rowBy(host, "sdk"), "dragstart", dt2);
    const overChild = drag(rowBy(host, "inner-dir"), "dragover", dt2);
    expect(overChild.defaultPrevented).toBe(false);
    await settle();
    expect(rowBy(host, "inner-dir").className).toContain("no-drop");
    drag(rowBy(host, "inner-dir"), "drop", dt2);
    await settle();
    expect(transfers()).toEqual([]);
  });
});

describe("compress in the tree menu", () => {
  it("both formats are offered on the picking and land in the clicked file's folder", async () => {
    const { FileTree, STR } = await fresh();
    const { host, compressCalls } = mountTree(FileTree);
    await settle();
    mouse(rowBy(host, "a.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "c.txt"), "mousedown", { metaKey: true, button: 0 });
    mouse(rowBy(host, "a.txt"), "contextmenu", { button: 2 });
    await settle();

    // The menu names both formats and says how many rows they take.
    const zip = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".ctx-item")
    ).find((b) =>
      b.textContent?.includes(
        STR.files.tree.withCount({ label: STR.files.tree.compressZip, n: 2 })
      )
    )!;
    expect(zip).toBeTruthy();
    const tgz = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".ctx-item")
    ).find((b) =>
      b.textContent?.includes(
        STR.files.tree.withCount({ label: STR.files.tree.compressTgz, n: 2 })
      )
    )!;
    expect(tgz).toBeTruthy();

    flushSync(() => zip.click());
    expect(compressCalls()).toEqual([[["/w1/a.txt", "/w1/c.txt"], "/w1", "zip"]]);

    // The first click dismisses the menu, so the second format starts from
    // a fresh right-click — same picking, same landing folder.
    mouse(rowBy(host, "c.txt"), "contextmenu", { button: 2 });
    await settle();
    const tgz2 = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".ctx-item")
    ).find((b) =>
      b.textContent?.includes(
        STR.files.tree.withCount({ label: STR.files.tree.compressTgz, n: 2 })
      )
    )!;
    flushSync(() => tgz2.click());
    expect(compressCalls()).toEqual([
      [["/w1/a.txt", "/w1/c.txt"], "/w1", "zip"],
      [["/w1/a.txt", "/w1/c.txt"], "/w1", "tgz"],
    ]);
  });

  it("a folder's menu lands the archive in that folder", async () => {
    const { FileTree } = await fresh();
    const { host, compressCalls } = mountTree(FileTree);
    await settle();
    mouse(rowBy(host, "sdk"), "contextmenu", { button: 2 });
    await settle();
    const zip = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".ctx-item")
    ).find((b) => b.textContent?.includes("Compress to Zip"))!;
    flushSync(() => zip.click());
    expect(compressCalls()).toEqual([[["/w1/sdk"], "/w1/sdk", "zip"]]);
  });
});
