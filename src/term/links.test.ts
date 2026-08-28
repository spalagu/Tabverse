import { beforeEach, describe, expect, it } from "vitest";
import { useStore, withPresetGroups } from "../state/store";
import {
  openDirectoryInFilesPane,
  openTerminalLink,
  parseTerminalLink,
} from "./links";


const reset = () => {
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    split: null,
    peekTabId: null,
    pageFreeze: null,
    saveTemplateFor: null,
    broadcastTabs: {},
  });
};

describe("what counts as a link", () => {
  it("takes full http(s) addresses and real path shapes", () => {
    expect(parseTerminalLink("https://example.com/x?y=1")).toEqual({
      kind: "url",
      url: "https://example.com/x?y=1",
    });
    expect(parseTerminalLink("HTTP://example.com")).toEqual({
      kind: "url",
      url: "HTTP://example.com",
    });
    expect(parseTerminalLink("/src/main.rs")).toEqual({
      kind: "path",
      path: "/src/main.rs",
    });
    expect(parseTerminalLink("/src/main.rs:42")).toEqual({
      kind: "path",
      path: "/src/main.rs",
      line: 42,
    });
    expect(parseTerminalLink("./lib/util.ts:12:8")).toEqual({
      kind: "path",
      path: "./lib/util.ts",
      line: 12,
      column: 8,
    });
  });

  it("refuses words that merely look like paths or fragments", () => {
    expect(parseTerminalLink("main.rs")).toBeNull();
    expect(parseTerminalLink("src/main.rs")).toBeNull(); // no ./ or /
    expect(parseTerminalLink("a/b:c/d")).toBeNull();
    expect(parseTerminalLink(":42")).toBeNull();
    expect(parseTerminalLink("example.com")).toBeNull();
  });
});

describe("where a link lands", () => {
  beforeEach(reset);

  it("⌘ is the escape hatch: an ordinary tab, no split", () => {
    const termId = useStore.getState().addTab({ type: "terminal" });
    useStore.setState({ activeTabId: termId });
    openTerminalLink({ kind: "url", url: "https://example.com" }, true, false);
    const st = useStore.getState();
    const made = st.tabs.find(
      (t) => t.type === "browser" && t.url === "https://example.com"
    );
    expect(made, "a browser tab was created").toBeDefined();
    expect(st.split, "no arrangement happened").toBeNull();
  });

  it("navigates a same-kind pane already beside this one", () => {
    const termId = useStore.getState().addTab({ type: "terminal" });
    const webId = useStore.getState().addTab({ type: "browser", url: "https://old.example" });
    useStore.setState({
      activeTabId: termId,
      split: { ids: [termId, webId], ratios: [0.5, 0.5], vertical: false },
    });
    openTerminalLink({ kind: "url", url: "https://new.example" }, false, false);
    const st = useStore.getState();
    // Reused: still two tabs, the neighbour navigated, none created.
    expect(st.tabs).toHaveLength(2);
    expect(
      st.tabs.find((t) => t.id === webId)?.url
    ).toBe("https://new.example");
    expect(st.activeTabId).toBe(webId);
    expect(st.split?.ids).toEqual([termId, webId]);
  });

  it("creates a tab and joins the split when no neighbour exists", () => {
    const termId = useStore.getState().addTab({ type: "terminal" });
    useStore.setState({ activeTabId: termId });
    openTerminalLink({ kind: "url", url: "https://first.example" }, false, false);
    const st = useStore.getState();
    const made = st.tabs.find(
      (t) => t.type === "browser" && t.url === "https://first.example"
    );
    expect(made, "created").toBeDefined();
    expect(st.split?.ids).toEqual([termId, made!.id]);
  });

  it("reuses a files neighbour through the reveal channel", () => {
    const termId = useStore.getState().addTab({ type: "terminal" });
    const filesId = useStore
      .getState()
      .addTab({ type: "files", cwd: "/work", openPath: "/work/a.rs" });
    useStore.setState({
      activeTabId: termId,
      split: { ids: [termId, filesId], ratios: [0.5, 0.5], vertical: false },
    });
    openTerminalLink({ kind: "path", path: "/work/b.rs", line: 7 }, false, false);
    const st = useStore.getState();
    expect(st.tabs).toHaveLength(2);
    const revealed = st.tabs.find((t) => t.id === filesId)?.reveal;
    expect(revealed?.path).toBe("/work/b.rs");
    expect(revealed?.line).toBe(7);
    expect(revealed?.nonce).toBe(1);
  });

  it("the context menu's directory item lands through the same function", () => {
    const termId = useStore.getState().addTab({ type: "terminal", cwd: "/work/app" });
    useStore.setState({ activeTabId: termId });
    openDirectoryInFilesPane("/work/app");
    const st = useStore.getState();
    const made = st.tabs.find((t) => t.type === "files");
    // Rooted AT the directory: the menu item means "show me this folder",
    // not "show me what is beside it".
    expect(made?.cwd).toBe("/work/app");
    expect(st.split?.ids).toEqual([termId, made!.id]);
  });
});

describe("the Shift gesture", () => {
  beforeEach(reset);


  it("Shift+click a URL: the browser peek, not an arrangement", () => {
    const termId = useStore.getState().addTab({ type: "terminal" });
    useStore.setState({ activeTabId: termId });
    openTerminalLink({ kind: "url", url: "https://peek.example/" }, false, true);
    const st = useStore.getState();
    // The peek opened over the terminal...
    expect(st.peekTabId).not.toBeNull();
    expect(st.tabs.find((t) => t.id === st.peekTabId)).toMatchObject({
      type: "browser",
      url: "https://peek.example/",
      peek: true,
      peekOver: termId,
    });
    // ...and nothing was arranged or created: no split, no ordinary new
    // tab, and the terminal the click came from still holds activation.
    expect(st.split).toBeNull();
    expect(st.tabs).toHaveLength(1 + 1); // the terminal + the peek alone
    expect(st.activeTabId).toBe(termId);
  });

  it("Shift+click a path: the file peek, and the files world untouched", () => {
    const termId = useStore.getState().addTab({ type: "terminal" });
    const filesId = useStore
      .getState()
      .addTab({ type: "files", cwd: "/work", openPath: "/work/old.rs" });
    useStore.setState({ activeTabId: termId });
    openTerminalLink({ kind: "path", path: "/work/src/main.rs", line: 3 }, false, true);
    const st = useStore.getState();
    // The peek carries the path...
    expect(st.tabs.find((t) => t.id === st.peekTabId)).toMatchObject({
      type: "files",
      peek: true,
      openPath: "/work/src/main.rs",
      peekOver: termId,
    });
    // ...and revealPath's world stayed asleep: no reveal handed to the
    // existing files tab, no files tab created, no split joined.
    expect(st.tabs.find((t) => t.id === filesId)?.reveal).toBeUndefined();
    expect(
      st.tabs.filter((t) => t.type === "files" && t.peek !== true)
    ).toHaveLength(1);
    expect(st.split).toBeNull();
    expect(st.activeTabId).toBe(termId);
  });

  it("an ordinary click of the same link still splits — the gestures differ", () => {
    // The counter-case the criterion names: same link, no Shift, and the
    // OLD behaviour must stand. If Shift ever fell through to the split
    // chain, the two peek tests above go red on peekTabId; this test is
    // the other wall of the channel.
    const termId = useStore.getState().addTab({ type: "terminal" });
    useStore.setState({ activeTabId: termId });
    openTerminalLink({ kind: "url", url: "https://plain.example/" }, false, false);
    const st = useStore.getState();
    expect(st.peekTabId).toBeNull();
    expect(st.tabs.find((t) => t.type === "browser" && t.peek !== true)?.url).toBe(
      "https://plain.example/"
    );
    expect(st.split?.ids).toEqual([
      termId,
      st.tabs.find((t) => t.type === "browser")!.id,
    ]);
  });

  it("⌘ stays the escape hatch even with Shift held", () => {
    const termId = useStore.getState().addTab({ type: "terminal" });
    useStore.setState({ activeTabId: termId });
    openTerminalLink({ kind: "url", url: "https://fresh.example/" }, true, true);
    const st = useStore.getState();
    // A separate ordinary tab, no peek, no arrangement.
    expect(st.peekTabId).toBeNull();
    expect(
      st.tabs.find((t) => t.type === "browser" && t.url === "https://fresh.example/")
        ?.peek
    ).toBeUndefined();
    expect(st.split).toBeNull();
  });

  it("a directory link keeps its menu meaning under Shift: no peek", () => {
    // The context menu is the only source of dir links and passes no
    // modifiers; if a future gesture ever arrives here with Shift, the
    // ordinary chain — not a peek — is the defined answer.
    const termId = useStore.getState().addTab({ type: "terminal", cwd: "/work" });
    useStore.setState({ activeTabId: termId });
    openTerminalLink({ kind: "dir", path: "/work" }, false, true);
    const st = useStore.getState();
    expect(st.peekTabId).toBeNull();
    expect(st.tabs.find((t) => t.type === "files")?.cwd).toBe("/work");
  });
});
