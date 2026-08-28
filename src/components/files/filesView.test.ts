import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
  events: new Map<string, Array<(e: { payload: unknown }) => void>>(),
  confirm: vi.fn<(msg: string, choices: unknown[]) => Promise<string | null>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("../Confirm", () => ({
  confirmChoose: (msg: string, choices: unknown[]) => mocks.confirm(msg, choices),
  confirmAsk: async () => false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    handler: (e: { payload: unknown }) => void
  ) => {
    const list = mocks.events.get(name) ?? [];
    list.push(handler);
    mocks.events.set(name, list);
    return () => {
      const cur = mocks.events.get(name) ?? [];
      const at = cur.indexOf(handler);
      if (at >= 0) cur.splice(at, 1);
    };
  },
}));

vi.mock("./CodeEditor", () => ({
  CodeEditor: (props: {
    value: string;
    onChange?: (v: string) => void;
    onSave?: () => void;
  }) =>
    createElement("textarea", {
      className: "editor-standin",
      value: props.value,
      onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) props.onSave?.();
      },
    }),
  disposeEditorState: () => {},
  openEditorFind: () => false,
}));

vi.mock("./TerminalPanel", () => ({
  TerminalPanel: () => createElement("div", { className: "term-standin" }),
}));

type FsView = typeof import("./FilesView");
type Persist = typeof import("../../persist");
type Strings = typeof import("../../strings");

/** The fake filesystem the mocked invoke serves. */
function fakeFs() {
  const dirs = new Map<string, { name: string; isDir: boolean }[]>([
    [
      "/w1",
      [
        // In the backend's own order: folders first, names case-blind.
        { name: "sdk", isDir: true },
        { name: "sub", isDir: true },
        { name: "a.txt", isDir: false },
        { name: "c.txt", isDir: false },
      ],
    ],
    [
      "/w1/sub",
      [
        { name: "inner.txt", isDir: false },
      ],
    ],
    ["/w2", [{ name: "z.txt", isDir: false }]],
    ["/work", [{ name: "restored.txt", isDir: false }]],
    ["/right", [{ name: "right.txt", isDir: false }]],
  ]);
  const contents = new Map<string, string>([
    ["/w1/a.txt", "alpha"],
    ["/w1/c.txt", "gamma"],
    ["/w1/sub/inner.txt", "inner"],
    ["/w2/z.txt", "zulu"],
    ["/work/restored.txt", "restored"],
    ["/right/right.txt", "right"],
  ]);
  const writes: string[] = [];
  const disk = new Map<string, string>();
  const transfers: Record<string, unknown>[] = [];
  /** Every fs_trash the view asked for. */
  const trashCalls: string[] = [];
  const mtimes = new Map<string, number>();
  mocks.invoke.mockImplementation(async (cmd, args) => {
    const a = args ?? {};
    switch (cmd) {
      case "fs_list": {
        const dir = a.dir as string;
        if (!dirs.has(dir)) throw new Error(`no such directory: ${dir}`);
        return {
          dir,
          parent: dir === "/" ? null : dir.slice(0, dir.lastIndexOf("/")) || "/",
          entries: (dirs.get(dir) ?? []).map((e) => ({
            name: e.name,
            path: `${dir === "/" ? "" : dir}/${e.name}`,
            isDir: e.isDir,
            isSymlink: false,
            size: e.isDir ? 0 : 10,
            modified: mtimes.get(`${dir === "/" ? "" : dir}/${e.name}`) ?? 1000,
            git: null,
            gitFromChildren: false,
          })),
          repoRoot: null,
          branch: null,
        };
      }
      case "fs_transfer": {
        // The shape fs_transfer answers with, free_name included: the
        // carried name, or the numbered yield when the destination
        // already holds it.
        const from = a.from as string;
        const into = a.intoDir as string;
        const cut = a.cut as boolean;
        const overwrite = (a.overwrite ?? false) as boolean;
        transfers.push({ from, into, cut, overwrite });
        const name = from.split("/").pop()!;
        const srcDir = from.slice(0, from.length - name.length - 1) || "/";
        const srcList = dirs.get(srcDir);
        const dstList = dirs.get(into);
        if (!srcList || !dstList) throw new Error(`no such directory: ${into}`);
        const srcAt = srcList.findIndex((e) => e.name === name);
        if (srcAt < 0) throw new Error(`no such file: ${from}`);
        const isDir = srcList[srcAt].isDir;
        let landed = name;
        if (dstList.some((e) => e.name === landed) && !overwrite) {
          const dot = name.lastIndexOf(".");
          landed =
            dot > 0
              ? `${name.slice(0, dot)} 2${name.slice(dot)}`
              : `${name} 2`;
        }
        if (overwrite) {
          const gone = dstList.findIndex((e) => e.name === landed);
          if (gone >= 0) dstList.splice(gone, 1);
        }
        dstList.push({ name: landed, isDir });
        if (cut) srcList.splice(srcAt, 1);
        const text = contents.get(from);
        if (text !== undefined) contents.set(`${into}/${landed}`, text);
        return `${into}/${landed}`;
      }
      case "fs_trash": {
        const path = a.path as string;
        trashCalls.push(path);
        const name = path.split("/").pop()!;
        const dir = path.slice(0, path.length - name.length - 1) || "/";
        const list = dirs.get(dir);
        if (list) {
          const at = list.findIndex((e) => e.name === name);
          if (at >= 0) list.splice(at, 1);
        }
        return;
      }
      case "fs_read": {
        const path = a.path as string;
        const text = contents.get(path) ?? disk.get(path);
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
          modified: mtimes.get(path) ?? 1000,
        };
      }
      case "fs_write": {
        const path = a.path as string;
        writes.push(path);
        disk.set(path, a.content as string);
        return;
      }
      case "fs_walk":
        return { paths: [], truncated: false };
      case "state_save": {
        disk.set(`state:${a.scope as string}`, a.json as string);
        (globalThis as Record<string, unknown>).__lastsave = a.json as string;
        return;
      }
      case "state_load": {
        const key = `state:${a.scope as string}`;
        return disk.has(key) ? disk.get(key) : null;
      }
      case "home_dir":
        return "/w1";
      default:
        return undefined;
    }
  });
  return { writes, dirs, contents, mtimes, transfers, trashCalls };
}

/** Let chained promises and the persist debounce settle. */
async function settle(ms = 0) {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const mounted: Array<() => void> = [];

async function fresh(): Promise<{ FilesView: FsView["FilesView"]; flushAll: Persist["flushAll"]; STR: Strings["STR"] }> {
  vi.resetModules();
  const w = window as unknown as Record<string, unknown>;
  // The marker routes backend/fs to the Tauri API; the invoke bridge makes
  // the REAL core module (should any module graph reach it instead of the
  // vi.mock above — resetModules makes that possible) delegate to the same
  // mock, so no call escapes the fake filesystem.
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) =>
      mocks.invoke(cmd, args),
  };
  const mod = await import("./FilesView");
  const persist = await import("../../persist");
  const strings = await import("../../strings");
  return { FilesView: mod.FilesView, flushAll: persist.flushAll, STR: strings.STR };
}

type TabLike = Parameters<FsView["FilesView"]>[0]["tab"];

const tab = (id: string, over: Partial<TabLike> = {}): TabLike => ({
  id,
  type: "files",
  title: "w1",
  groupId: null,
  ...over,
} as TabLike);

function render(View: FsView["FilesView"], t: TabLike): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  flushSync(() => root.render(createElement(View, { tab: t, active: true })));
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return host;
}

const paneColumns = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLElement>(".files-main"));

const treeRow = (host: HTMLElement, name: string): HTMLElement | null =>
  Array.from(host.querySelectorAll<HTMLElement>(".tree-row")).find(
    (r) => r.querySelector(".tree-name")?.textContent === name
  ) ?? null;

const stripNames = (col: HTMLElement): (string | null)[] =>
  Array.from(col.querySelectorAll(".editor-tab-name")).map((n) => n.textContent);

/** Bare keydown on the window, the way the app-level listeners see one. */
function press(key: string, over: KeyboardEventInit = {}) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...over,
    })
  );
}

beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.events.clear();
  mocks.confirm.mockReset();
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the column view", () => {
  it("the column view pushes columns without expanding the tree, and remembers the choice per root", async () => {
    const { writes } = fakeFs();
    const saved: string[] = [];
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "state_save") {
        saved.push(args?.json as string);
        return;
      }
      return base(cmd, args);
    });
    const { FilesView, STR } = await fresh();
    const host = render(FilesView, tab("44444444-4444-4444-8444-444444444444", { cwd: "/w1" }));
    await settle();

    // Switch the pane's view to columns.
    const colsBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === STR.files.viewSwitch.columns
    )!;
    flushSync(() => colsBtn.click());
    await settle();
    expect(host.querySelector(".miller-cols")).not.toBeNull();
    // One column to begin with.
    expect(host.querySelectorAll(".miller-col")).toHaveLength(1);

    // Single click on a folder pushes its column…
    const subRow = Array.from(host.querySelectorAll<HTMLElement>(".miller-row")).find(
      (r) => r.textContent === "sub"
    )!;
    flushSync(() => subRow.click());
    await settle();
    expect(host.querySelectorAll(".miller-col")).toHaveLength(2);

    await settle(350);
    const last = saved[saved.length - 1];
    expect(JSON.parse(last).expanded).toEqual([]);
    // The per-root view choice, on the other hand, IS remembered.
    expect(JSON.parse(last).treeModes).toEqual({ "/w1": "miller" });

    // A file clicked in a column previews through the pane's own dispatch.
    const fileRow = Array.from(host.querySelectorAll<HTMLElement>(".miller-row")).find(
      (r) => r.textContent === "inner.txt"
    )!;
    flushSync(() => fileRow.click());
    await settle();
    expect(stripNames(paneColumns(host)[0])).toEqual(["inner.txt"]);

    // Double click anchors the column's directory as the pane's root —
    // the strip says so, which is the observable of setRoot.
    const subRowAgain = Array.from(
      host.querySelectorAll<HTMLElement>(".miller-row")
    ).find((r) => r.textContent === "sub")!;
    flushSync(() =>
      subRowAgain.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    );
    await settle();
    expect(
      Array.from(host.querySelectorAll(".path-seg")).map((b) => b.textContent)
    ).toEqual(["/", "w1", "sub"]);
    void writes;
  });
});

describe("the location bar", () => {
  it("Tab completes one folder, offers many, and Enter submits the RESOLVED path", async () => {
    fakeFs();
    const submitted: string[] = [];
    const { LocBar } = await (async () => {
      vi.resetModules();
      const w = window as unknown as Record<string, unknown>;
      w.__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args?: Record<string, unknown>) =>
          mocks.invoke(cmd, args),
      };
      const { LocBar: L } = await import("./LocBar");
      return { LocBar: L };
    })();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    flushSync(() =>
      root.render(
        createElement(LocBar, {
          root: "/w1",
          onSubmit: (r: string) => submitted.push(r),
          onClose: () => {},
        })
      )
    );
    mounted.push(() => {
      flushSync(() => root.unmount());
      host.remove();
    });
    await settle();
    const input = host.querySelector<HTMLInputElement>(".loc-input")!;
    const type = (val: string) => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!;
      set.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const key = (k: string) => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
      );
    };

    // One continuing folder: Tab completes it, slash and all.
    type("/w1/su");
    key("Tab");
    await settle();
    expect(input.value).toBe("/w1/sub/");

    // Many continuing folders: Tab offers them; the arrows walk the list.
    type("/w1/s");
    key("Tab");
    await settle();
    const rows = Array.from(host.querySelectorAll(".loc-completion"));
    expect(
      rows.map((r) => r.querySelector(".tree-name")?.textContent)
    ).toEqual(["sdk", "sub"]);
    expect(rows).toHaveLength(2);
    key("ArrowDown");
    await settle();

    // A RELATIVE input submits as ABSOLUTE against the root — the front-end
    // resolve the criterion exists for (the backend would join the app's
    // own process cwd instead).
    type("sub");
    key("Enter");
    await settle();
    expect(submitted).toEqual(["/w1/sub"]);
  });

  it("the arrows walk the remembered paths when no dropdown is up", async () => {
    fakeFs();
    // Pre-seed the recent-paths scope the bar loads on mount.
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "state_load" && (args?.scope as string) === "recent-paths") {
        return JSON.stringify({ version: 1, paths: ["/w2", "/w1/sub"] });
      }
      return base(cmd, args);
    });
    vi.resetModules();
    const w = window as unknown as Record<string, unknown>;
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) =>
        mocks.invoke(cmd, args),
    };
    const { LocBar } = await import("./LocBar");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    flushSync(() =>
      root.render(
        createElement(LocBar, {
          root: "/w1",
          onSubmit: () => {},
          onClose: () => {},
        })
      )
    );
    mounted.push(() => {
      flushSync(() => root.unmount());
      host.remove();
    });
    await settle();
    const input = host.querySelector<HTMLInputElement>(".loc-input")!;
    const key = (k: string) => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
      );
    };

    key("ArrowUp");
    await settle();
    expect(input.value).toBe("/w2");
    key("ArrowUp");
    await settle();
    expect(input.value).toBe("/w1/sub");
    // And back down to what was there before the walk.
    key("ArrowDown");
    await settle();
    expect(input.value).toBe("/w2");
  });
});

describe("root history", () => {
  const segLabels = (host: HTMLElement) =>
    Array.from(host.querySelectorAll(".path-seg")).map((b) => b.textContent);

  it("funnel jumps push, the commands walk, a restore pushes nothing", async () => {
    fakeFs();
    const { FilesView, STR } = await fresh();
    const { runAppCommand } = await import("../../appCommands");
    const host = render(
      FilesView,
      tab("77777777-7777-4777-8777-777777777777", { cwd: "/w1/sub" })
    );
    await settle();

    const back = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.getAttribute("aria-label") === STR.files.nav.backHint
      )!;
    const forward = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.getAttribute("aria-label") === STR.files.nav.forwardHint
      )!;
    const up = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.getAttribute("aria-label") === STR.files.view.parentDirHint
      )!;

    // The place a restore comes back from is where the tab started — it is
    // not something there is to go "back" to.
    expect(back().disabled).toBe(true);
    expect(forward().disabled).toBe(true);

    // A funnel jump (crumb-up) leaves the old root behind.
    flushSync(() => up().click());
    await settle();
    expect(segLabels(host)).toEqual(["/", "w1"]);
    expect(back().disabled).toBe(false);

    // ⌘[ walks back, ⌘] walks forward again.
    flushSync(() => runAppCommand("back"));
    await settle();
    expect(segLabels(host)).toEqual(["/", "w1", "sub"]);
    expect(forward().disabled).toBe(false);
    flushSync(() => runAppCommand("forward"));
    await settle();
    expect(segLabels(host)).toEqual(["/", "w1"]);
  });

  it("a restart comes back with an empty history, wherever it comes back to", async () => {
    fakeFs();
    const { FilesView, flushAll, STR } = await fresh();
    const host = render(
      FilesView,
      tab("88888888-8888-4888-8888-888888888888", { cwd: "/w1/sub" })
    );
    await settle();
    const up = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.getAttribute("aria-label") === STR.files.view.parentDirHint
      )!;
    flushSync(() => up().click());
    await settle(350);
    await flushAll();
    const payload = (globalThis as Record<string, unknown>).__lastsave;
    expect(typeof payload).toBe("string");
    expect(JSON.parse(String(payload)).nav).toBeUndefined();

    // Restart: the same disk state, a fresh mount.
    while (mounted.length > 0) mounted.pop()?.();
    const host2 = render(
      FilesView,
      tab("88888888-8888-4888-8888-888888888888", { cwd: "/w1/sub" })
    );
    await settle(60);
    // The workspace restored to where it was left (the parent), but the
    // history did not come with it.
    expect(segLabels(host2)).toEqual(["/", "w1"]);
    const back2 = Array.from(host2.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.getAttribute("aria-label") === STR.files.nav.backHint
    )!;
    expect(back2.disabled).toBe(true);
  });

  it("two panes keep two histories; the buttons speak for the front one", async () => {
    fakeFs();
    const { FilesView, STR } = await fresh();
    const host = render(
      FilesView,
      tab("99999999-9999-4999-8999-999999999999", { cwd: "/w1/sub" })
    );
    await settle();
    const dualBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === STR.files.panes.dual
    )!;
    flushSync(() => dualBtn.click());
    await settle();

    const back = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.getAttribute("aria-label") === STR.files.nav.backHint
      )!;
    const up = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.getAttribute("aria-label") === STR.files.view.parentDirHint
      )!;

    // Navigate the FRONT pane only.
    flushSync(() => up().click());
    await settle();
    expect(back().disabled).toBe(false);

    // The other pane's history is untouched: switching panes flips the
    // button back to disabled.
    const chip2 = Array.from(host.querySelectorAll<HTMLButtonElement>(".pane-chip"))[1];
    flushSync(() => chip2.click());
    await settle();
    expect(back().disabled).toBe(true);
  });
});

describe("the bottom path bar", () => {
  it("every segment jumps, through the root funnel", async () => {
    const listed: string[] = [];
    fakeFs();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "fs_list") listed.push(args?.dir as string);
      return base(cmd, args);
    });
    const { FilesView } = await fresh();
    const host = render(FilesView, tab("55555555-5555-4555-8555-555555555555", { cwd: "/w1/sub" }));
    await settle();

    // The strip names the pane's root, segment by segment.
    const labels = Array.from(host.querySelectorAll(".path-seg")).map(
      (b) => b.textContent
    );
    expect(labels).toEqual(["/", "w1", "sub"]);

    // Clicking a segment jumps the pane's root there — observable where the
    // tree reloads from.
    const w1 = Array.from(host.querySelectorAll<HTMLButtonElement>(".path-seg")).find(
      (b) => b.textContent === "w1"
    )!;
    flushSync(() => w1.click());
    await settle();
    expect(listed).toContain("/w1");
    // And the strip now speaks for the new root.
    expect(
      Array.from(host.querySelectorAll(".path-seg")).map((b) => b.textContent)
    ).toEqual(["/", "w1"]);
  });

  it("with two panes the strip follows the front one", async () => {
    fakeFs();
    const { FilesView, STR } = await fresh();
    const host = render(FilesView, tab("66666666-6666-4666-8666-666666666666", { cwd: "/w1" }));
    await settle();
    const dualBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === STR.files.panes.dual
    )!;
    flushSync(() => dualBtn.click());
    await settle();

    // Two windows, two chips, the strip on the front pane's root.
    expect(
      Array.from(host.querySelectorAll(".pane-chip")).map((c) => c.textContent)
    ).toEqual(["1", "2"]);

    // Walk the front pane to /w1/sub, then switch panes: the strip follows
    // the pointer, not the navigation.
    const subRow = treeRow(host, "sub")!;
    flushSync(() =>
      subRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    );
    await settle();
    expect(
      Array.from(host.querySelectorAll(".path-seg")).map((b) => b.textContent)
    ).toEqual(["/", "w1", "sub"]);

    const chip2 = Array.from(host.querySelectorAll<HTMLButtonElement>(".pane-chip"))[1];
    flushSync(() => chip2.click());
    await settle();
    expect(
      Array.from(host.querySelectorAll(".path-seg")).map((b) => b.textContent)
    ).toEqual(["/", "w1"]);
  });
});

describe("dual panes", () => {
  it("Tab switches the front pane; a tree click and a save land on the pane in front", async () => {
    const { writes } = fakeFs();
    const { FilesView, STR } = await fresh();
    const host = render(FilesView, tab("11111111-1111-4111-8111-111111111111", { cwd: "/w1" }));
    await settle();

    // One window to begin with.
    expect(paneColumns(host)).toHaveLength(1);
    flushSync(() => treeRow(host, "a.txt")!.click());
    await settle();
    expect(stripNames(paneColumns(host)[0])).toEqual(["a.txt"]);

    // Dual pane: a second window appears beside the first.
    const dualBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === STR.files.panes.dual
    )!;
    flushSync(() => dualBtn.click());
    await settle();
    expect(paneColumns(host)).toHaveLength(2);

    // Tab moves the front pane — the ACTIVE marker follows.
    expect(paneColumns(host)[0].classList.contains("active")).toBe(true);
    press("Tab");
    await settle();
    expect(paneColumns(host)[1].classList.contains("active")).toBe(true);

    // A file clicked in the (shared, active-pane) tree opens in the FRONT
    // pane's strip, not the background one.
    flushSync(() => treeRow(host, "c.txt")!.click());
    await settle();
    expect(stripNames(paneColumns(host)[0])).toEqual(["a.txt"]);
    expect(stripNames(paneColumns(host)[1])).toEqual(["c.txt"]);

    // A draft typed into the front pane's editor, saved with the local key:
    // the write is the FRONT pane's file and only it. The native setter is
    // used because React's value tracker ignores a plain value assignment
    // followed by an input event — it would swallow the keystroke as a no-op.
    const editor = paneColumns(host)[1].querySelector<HTMLTextAreaElement>(
      ".editor-standin"
    )!;
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!;
    flushSync(() => {
      setNativeValue.call(editor, "gamma, edited");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    press("s", { metaKey: true });
    await settle();
    expect(writes).toEqual(["/w1/c.txt"]);
    // And the save settled that pane's draft: the dirty dot is gone there.
    expect(
      paneColumns(host)[1].querySelector(".editor-tab-dot")
    ).toBeNull();
    expect(
      paneColumns(host)[0].querySelector(".editor-tab-dot")
    ).toBeNull();

    // The same file open in BOTH panes is where "acts on the whole view"
    // would betray itself: dirty the same file in both windows, save the
    // front one, and the background window's draft must survive untouched.
    flushSync(() => treeRow(host, "a.txt")!.click());
    await settle();
    expect(stripNames(paneColumns(host)[1])).toEqual(["c.txt", "a.txt"]);
    const pane0Editor =
      paneColumns(host)[0].querySelector<HTMLTextAreaElement>(".editor-standin")!;
    const pane1Editor =
      paneColumns(host)[1].querySelector<HTMLTextAreaElement>(".editor-standin")!;
    flushSync(() => {
      setNativeValue.call(pane0Editor, "alpha, from pane zero");
      pane0Editor.dispatchEvent(new Event("input", { bubbles: true }));
      setNativeValue.call(pane1Editor, "alpha, from pane one");
      pane1Editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    // Both strips are dirty — the dot is on the same file in both windows.
    expect(paneColumns(host)[0].querySelector(".editor-tab-dot")).not.toBeNull();
    expect(paneColumns(host)[1].querySelector(".editor-tab-dot")).not.toBeNull();
    press("s", { metaKey: true });
    await settle();
    // One write, of the FRONT pane's draft.
    expect(writes).toEqual(["/w1/c.txt", "/w1/a.txt"]);
    // The front window's draft is settled; the background window's is not.
    expect(paneColumns(host)[1].querySelector(".editor-tab-dot")).toBeNull();
    expect(paneColumns(host)[0].querySelector(".editor-tab-dot")).not.toBeNull();
  });

  it("a session saved before dual panes existed restores as one pane, field for field", async () => {
    const legacy = {
      v: 1,
      root: "/work",
      expanded: [],
      open: ["/work/restored.txt"],
      active: "/work/restored.txt",
      viewModes: {},
      showDiff: true,
      drafts: {},
      term: { open: false, height: 220, cwd: "/work" },
    };
    const { FilesView } = await fresh();
    const disk = new Map<string, string>([
      ["state:files:22222222-2222-4222-8222-222222222222", JSON.stringify(legacy)],
    ]);
    mocks.invoke.mockImplementation(async (cmd, args) => {
      const a = args ?? {};
      if (cmd === "state_load") {
        const key = `state:${a.scope as string}`;
        return disk.has(key) ? disk.get(key) : null;
      }
      if (cmd === "fs_list") {
        const dir = a.dir as string;
        if (dir === "/work") {
          return {
            dir,
            parent: "/",
            entries: [
              {
                name: "restored.txt",
                path: "/work/restored.txt",
                isDir: false,
                isSymlink: false,
                size: 8,
                modified: 1000,
                git: null,
                gitFromChildren: false,
              },
            ],
            repoRoot: null,
            branch: null,
          };
        }
        if (dir === "/w1") {
          return {
            dir,
            parent: "/",
            entries: [],
            repoRoot: null,
            branch: null,
          };
        }
        throw new Error(`no such directory: ${dir}`);
      }
      if (cmd === "fs_read" && a.path === "/work/restored.txt") {
        return {
          path: "/work/restored.txt",
          name: "restored.txt",
          size: 8,
          kind: "text",
          mime: "text/plain",
          text: "restored",
          truncated: false,
          readOnlyReason: null,
          headText: null,
          git: null,
          modified: 1000,
        };
      }
      if (cmd === "fs_walk")
        return { paths: [], truncated: false };
      return undefined;
    });
    const host = render(
      FilesView,
      tab("22222222-2222-4222-8222-222222222222", { cwd: "/w1" })
    );
    await settle(60);

    // One pane — the legacy shape is a single window, not a pair.
    expect(paneColumns(host)).toHaveLength(1);
    // Root, open file, active file: each restored where the old code put it.
    expect(stripNames(paneColumns(host)[0])).toEqual(["restored.txt"]);
    expect(treeRow(host, "restored.txt")).not.toBeNull();
  });

  it("a stored pair comes back as two windows with the remembered roots", async () => {
    const dual = {
      v: 1,
      root: "/work",
      expanded: [],
      open: [],
      active: null,
      viewModes: {},
      showDiff: true,
      drafts: {},
      term: { open: false, height: 220, cwd: "/work" },
      panes: [
        {
          root: "/work",
          expanded: [],
          open: [],
          active: null,
          viewModes: {},
          drafts: {},
          treeModes: {},
        },
        {
          root: "/right",
          expanded: [],
          open: ["/right/right.txt"],
          active: "/right/right.txt",
          viewModes: {},
          drafts: {},
          treeModes: {},
        },
      ],
      layout: "column",
      activePane: 1,
    };
    const { FilesView } = await fresh();
    const disk = new Map<string, string>([
      ["state:files:33333333-3333-4333-8333-333333333333", JSON.stringify(dual)],
    ]);
    mocks.invoke.mockImplementation(async (cmd, args) => {
      const a = args ?? {};
      if (cmd === "state_load") {
        const key = `state:${a.scope as string}`;
        return disk.has(key) ? disk.get(key) : null;
      }
      if (cmd === "fs_list") {
        const dir = a.dir as string;
        if (dir === "/work" || dir === "/right") {
          return {
            dir,
            parent: "/",
            entries:
              dir === "/work"
                ? []
                : [
                    {
                      name: "right.txt",
                      path: "/right/right.txt",
                      isDir: false,
                      isSymlink: false,
                      size: 5,
                      modified: 1000,
                      git: null,
                      gitFromChildren: false,
                    },
                  ],
            repoRoot: null,
            branch: null,
          };
        }
        throw new Error(`no such directory: ${dir}`);
      }
      if (cmd === "fs_read" && a.path === "/right/right.txt") {
        return {
          path: "/right/right.txt",
          name: "right.txt",
          size: 5,
          kind: "text",
          mime: "text/plain",
          text: "right",
          truncated: false,
          readOnlyReason: null,
          headText: null,
          git: null,
          modified: 1000,
        };
      }
      if (cmd === "fs_walk")
        return { paths: [], truncated: false };
      return undefined;
    });
    const host = render(
      FilesView,
      tab("33333333-3333-4333-8333-333333333333", { cwd: "/w1" })
    );
    await settle(60);

    expect(paneColumns(host)).toHaveLength(2);
    // The remembered front pane is the second one, and its file is there.
    expect(paneColumns(host)[1].classList.contains("active")).toBe(true);
    expect(stripNames(paneColumns(host)[1])).toEqual(["right.txt"]);
    expect(stripNames(paneColumns(host)[0])).toEqual([]);
  });
});


/** Deliver one backend "fs-changed" for a tab. */
function emitFsChanged(tabId: string): void {
  for (const h of mocks.events.get("fs-changed") ?? []) {
    h({ payload: { tabId } });
  }
}

/** How many times the root directory was listed so far. */
const listsOf = (dir: string): number =>
  mocks.invoke.mock.calls.filter(
    ([cmd, a]) => cmd === "fs_list" && (a?.dir as string) === dir
  ).length;

describe("the watcher", () => {
  const TAB = "66666666-6666-4666-8666-666666666666";

  it("a burst inside one window costs one re-list, and the tree shows what changed", async () => {
    const { dirs } = fakeFs();
    const { FilesView } = await fresh();
    const host = render(FilesView, tab(TAB, { cwd: "/w1" }));
    await settle();

    // The window's observability: five events spaced inside the 300ms
    // window are one token bump, and a token bump re-lists the root.
    const before = listsOf("/w1");
    for (let i = 0; i < 5; i++) {
      emitFsChanged(TAB);
      await settle(40);
    }
    // Something really did change on disk; the refresh must show it.
    dirs.get("/w1")!.push({ name: "arrived.txt", isDir: false });
    await settle(420);
    expect(listsOf("/w1")).toBe(before + 1);
    expect(treeRow(host, "arrived.txt")).not.toBeNull();

    // And an event after the window closed is a second bump — the window
    // merges bursts, it does not swallow the next one.
    const afterFirst = listsOf("/w1");
    emitFsChanged(TAB);
    await settle(420);
    expect(listsOf("/w1")).toBe(afterFirst + 1);
  });

  it("a disk change under a draft lands in the conflicts banner, not over the draft", async () => {
    const { contents, mtimes } = fakeFs();
    const { FilesView } = await fresh();
    const host = render(FilesView, tab(TAB, { cwd: "/w1" }));
    await settle();

    // Open a.txt the way a person does, then hold an unsaved draft of it.
    flushSync(() => treeRow(host, "a.txt")!.click());
    await settle();
    const editor = host.querySelector<HTMLTextAreaElement>(
      "textarea.editor-standin"
    )!;
    const set = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!;
    set.call(editor, "the draft I am still typing");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    // The outside world rewrites the file while the draft is unsaved.
    contents.set("/w1/a.txt", "rewritten behind my back");
    mtimes.set("/w1/a.txt", 2000);
    emitFsChanged(TAB);
    await settle(450);

    // The dispute is surfaced, the draft is untouched, and the diff the
    // banner promises is against what disk says NOW.
    expect(host.querySelector(".files-conflict")).not.toBeNull();
    const after = host.querySelector<HTMLTextAreaElement>(
      "textarea.editor-standin"
    )!;
    expect(after.value).toBe("the draft I am still typing");
    expect(after.className).toContain("editor-standin");

    // An unchanged mtime under a draft is not a dispute: no banner for a
    // file nobody touched. (c.txt is open-able and untouched.)
    flushSync(() => treeRow(host, "c.txt")!.click());
    await settle();
    expect(host.querySelector(".files-conflict")).toBeNull();
  });

  it("the selected file deleted on disk keeps its place, with the missing mark", async () => {
    const { dirs, contents } = fakeFs();
    const { FilesView, STR } = await fresh();
    const host = render(FilesView, tab(TAB, { cwd: "/w1" }));
    await settle();

    flushSync(() => treeRow(host, "c.txt")!.click());
    await settle();
    expect(stripNames(paneColumns(host)[0])).toEqual(["c.txt"]);

    // Deleted outside: the row leaves the tree, but the open file stays —
    // with its state named, not silently closed and not silently kept
    // looking healthy.
    dirs.set(
      "/w1",
      (dirs.get("/w1") ?? []).filter((e) => e.name !== "c.txt")
    );
    contents.delete("/w1/c.txt");
    emitFsChanged(TAB);
    await settle(450);

    expect(stripNames(paneColumns(host)[0])).toEqual(["c.txt"]);
    expect(treeRow(host, "c.txt")).toBeNull();
    const stripTab = host.querySelector<HTMLElement>(".editor-tab.missing");
    expect(stripTab).not.toBeNull();
    expect(stripTab!.getAttribute("title")).toBe(
      `/w1/c.txt — ${STR.files.view.missingFileHint}`
    );
    expect(host.querySelector(".file-missing")?.textContent).toBe(
      STR.files.view.missingChip
    );

    // Closing it clears the mark — the set is not a ledger of past paths.
    flushSync(() => stripTab!.querySelector(".editor-tab-close")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true })
    ));
    await settle();
    expect(host.querySelector(".editor-tab.missing")).toBeNull();
    expect(stripNames(paneColumns(host)[0])).toEqual([]);
  });
});


describe("undo", () => {
  const TAB = "aaaaaaaa-1aaa-4aaa-8aaa-aaaaaaaaaaaa";

  /** Keydown at the window, the way the app-level listeners see one. */
  const pressWindow = (key: string, over: KeyboardEventInit = {}) => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...over })
    );
  };
  /** Keydown on an element, bubbling to the window. */
  const pressOn = (el: Element, key: string, over: KeyboardEventInit = {}) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...over })
    );
  };

  it("⌘Z walks a move home; ⇧⌘Z walks it back — window-level keys, like the matrix presses", async () => {
    fakeFs();
    const { FilesView } = await fresh();
    const host = render(FilesView, tab(TAB, { cwd: "/w1" }));
    await settle();

    // Cut a.txt with the tree's own chord, then paste it into sub. Each
    // press is flushed to its render first — the aim a press sets is read
    // by the NEXT keydown's closure, and a real hand is always slower
    // than React's commit.
    const aRow = treeRow(host, "a.txt")!;
    flushSync(() =>
      aRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
    );
    pressOn(aRow, "x", { metaKey: true });
    await settle();
    const subRow = treeRow(host, "sub")!;
    flushSync(() =>
      subRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
    );
    pressOn(subRow, "v", { metaKey: true });
    await settle();
    // The paste landed on sub's plain name (nothing was taken there).
    const { transfers } = fakeFsState();
    expect(transfers()).toEqual([
      expect.objectContaining({ from: "/w1/a.txt", intoDir: "/w1/sub", cut: true }),
    ]);

    // ⌘Z at the window: the move walks home.
    pressWindow("z", { metaKey: true });
    await settle();
    expect(transfers().length).toBe(2);
    expect(transfers()[1]).toEqual(
      expect.objectContaining({ from: "/w1/sub/a.txt", intoDir: "/w1", cut: true })
    );

    // ⇧⌘Z walks it forward again, into sub.
    pressWindow("z", { metaKey: true, shiftKey: true });
    await settle();
    expect(transfers().length).toBe(3);
    expect(transfers()[2]).toEqual(
      expect.objectContaining({ from: "/w1/a.txt", intoDir: "/w1/sub", cut: true })
    );
  });

  it("a ⌘Z pressed inside the editor is Monaco's — the tree does not answer it", async () => {
    fakeFs();
    const { FilesView } = await fresh();
    const host = render(FilesView, tab(TAB, { cwd: "/w1" }));
    await settle();

    // A file open, so the editor exists; a move done, so there is
    // something an over-eager tree would love to undo.
    flushSync(() => treeRow(host, "a.txt")!.click());
    await settle();
    const cRow = treeRow(host, "c.txt")!;
    flushSync(() =>
      cRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
    );
    pressOn(cRow, "x", { metaKey: true });
    await settle();
    const subRow = treeRow(host, "sub")!;
    flushSync(() =>
      subRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
    );
    pressOn(subRow, "v", { metaKey: true });
    await settle();
    const { transfers } = fakeFsState();
    const before = transfers().length;
    expect(before).toBe(1);

    // The editor's stand-in is a textarea — exactly the surface Monaco
    // holds focus in, which is what the guard has to recognize.
    const editor = host.querySelector<HTMLTextAreaElement>("textarea.editor-standin")!;
    expect(editor).not.toBeNull();
    const ev = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(ev);
    await settle();
    expect(transfers().length).toBe(before);
    expect(ev.defaultPrevented).toBe(false);

    // The same press away from any text surface IS the file domain's:
    // the stack still walks from the window.
    pressWindow("z", { metaKey: true });
    await settle();
    expect(transfers().length).toBe(before + 1);
  });

  it("trashing is recorded and honestly refused: ⌘Z names what it cannot do, and moves nothing", async () => {
    fakeFs();
    const { FilesView, STR } = await fresh();
    const host = render(FilesView, tab(TAB, { cwd: "/w1" }));
    await settle();

    // A file open, because the banner lives beside the editor; c.txt is
    // the one going to the Trash.
    flushSync(() => treeRow(host, "a.txt")!.click());
    await settle();
    const row = treeRow(host, "c.txt")!;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    await settle();
    const trashItem = Array.from(host.querySelectorAll<HTMLButtonElement>(".ctx-item")).find(
      (b) => b.textContent?.startsWith(STR.files.tree.moveToTrash)
    )!;
    expect(trashItem).toBeTruthy();
    flushSync(() => trashItem.click());
    await settle();
    const { trashCalls, transfers } = fakeFsState();
    expect(trashCalls()).toEqual(["/w1/c.txt"]);

    // ⌘Z: the honest sentence, and no fs call of any kind.
    flushSync(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      )
    );
    await settle();
    expect(transfers().length).toBe(0);
    expect(trashCalls()).toEqual(["/w1/c.txt"]);
    expect(host.querySelector(".files-error")?.textContent).toBe(
      STR.files.tree.undoTrashHonest({ path: "/w1/c.txt" })
    );
  });

 it("an overwrite is recorded as the step undo refuses: ⌘Z says so and reverses nothing", async () => {
    const { dirs } = fakeFs();
    // sub now holds a.txt — the clash a two-item paste will be asked about.
    dirs.get("/w1/sub")!.push({ name: "a.txt", isDir: false });
    mocks.confirm.mockResolvedValue("replace");
    const { FilesView, STR } = await fresh();
    const host = render(FilesView, tab(TAB, { cwd: "/w1" }));
    await settle();

    // A file open (the banner lives beside the editor), then the pair.
    flushSync(() => treeRow(host, "c.txt")!.click());
    await settle();
    const aRow = treeRow(host, "a.txt")!;
    flushSync(() =>
      aRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, metaKey: true, button: 0 }))
    );
    pressOn(aRow, "x", { metaKey: true });
    await settle();
    const cRow = treeRow(host, "c.txt")!;
    flushSync(() =>
      cRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, metaKey: true, button: 0 }))
    );
    pressOn(cRow, "x", { metaKey: true });
    await settle();
    const subRow = treeRow(host, "sub")!;
    flushSync(() =>
      subRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
    );
    pressOn(subRow, "v", { metaKey: true });
    await settle();
    const { transfers } = fakeFsState();
    // Only the clashing item was armed; c.txt is an ordinary move.
    expect(transfers().map((t) => ({ from: t.from, overwrite: t.overwrite }))).toEqual([
      { from: "/w1/a.txt", overwrite: true },
      { from: "/w1/c.txt", overwrite: false },
    ]);

    // First ⌘Z: the ordinary move walks home — that one is undoable.
    flushSync(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })
      )
    );
    await settle();
    expect(transfers().length).toBe(3);
    expect(transfers()[2]).toEqual(
      expect.objectContaining({ from: "/w1/sub/c.txt", intoDir: "/w1", cut: true })
    );

    // Second ⌘Z, over the overwritten step: the honest sentence, no fs
    // call of any kind. An implementation that recorded the overwrite as
    // an ordinary move would transfer the file back here — that is
    // exactly the reversal this test exists to bar.
    flushSync(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })
      )
    );
    await settle();
    expect(transfers().length).toBe(3);
    expect(host.querySelector(".files-error")?.textContent).toBe(
      STR.files.tree.undoReplaceHonest({ path: "/w1/sub/a.txt" })
    );
  });
});

/** Read the fake filesystem's call log the harness above installed. */
function fakeFsState() {
  const transfers = () =>
    mocks.invoke.mock.calls
      .filter(([cmd]) => cmd === "fs_transfer")
      .map(([, a]) => a as Record<string, unknown>);
  const trashCalls = () =>
    mocks.invoke.mock.calls
      .filter(([cmd]) => cmd === "fs_trash")
      .map(([, a]) => (a as { path: string }).path);
  return { transfers, trashCalls };
}
