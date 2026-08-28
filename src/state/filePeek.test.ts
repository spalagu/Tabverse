import { beforeEach, describe, expect, it } from "vitest";
import {
  archivableByState,
  sessionSnapshot,
  useStore,
  visibleOrdered,
  withPresetGroups,
} from "./store";
import { flushAll } from "../persist";


const reset = async () => {
  await flushAll();
  localStorage.clear();
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    archive: [],
    split: null,
    peekTabId: null,
    pageFreeze: null,
    saveTemplateFor: null,
    broadcastTabs: {},
  });
};

const st = () => useStore.getState();

beforeEach(reset);

describe("the tab a file peek becomes", () => {
  it("is a files tab marked peek carrying the open path, over the terminal", () => {
    const term = st().addTab({ type: "terminal" });
    st().activateTab(term);
    const id = st().openPeek({ type: "files", openPath: "/work/src/main.rs" });
    const peek = st().tabs.find((t) => t.id === id);
    expect(peek).toMatchObject({
      type: "files",
      peek: true,
      openPath: "/work/src/main.rs",
      peekOver: term,
    });
    // The overlay is a look, not a move: the terminal keeps activation.
    expect(st().activeTabId).toBe(term);
    expect(st().peekTabId).toBe(id);
    // The title is the file's own name — the shortest name for the window.
    expect(peek?.title).toBe("main.rs");
  });

  it("does not wake, reveal, or create a files tab (that is revealPath's job)", () => {
    const term = st().addTab({ type: "terminal" });
    // A files tab already rooted ABOVE the peeked file: revealPath would
    // wake this tab and hand it a reveal. The peek must leave it alone.
    const host = st().addTab({ type: "files", cwd: "/work", openPath: "/work/old.rs" });
    st().activateTab(term);
    const filesTabsBefore = st().tabs.filter((t) => t.type === "files").length;
    st().openPeek({ type: "files", openPath: "/work/src/main.rs" });
    const stAfter = st();
    expect(stAfter.tabs.filter((t) => t.type === "files" && t.peek !== true)).toHaveLength(
      filesTabsBefore
    );
    expect(stAfter.tabs.find((t) => t.id === host)?.reveal).toBeUndefined();
    // No arrangement happened either — a peek is not a split member.
    expect(stAfter.split).toBeNull();
  });

  it("is excluded from the surfaces a user's tab reaches", () => {
    const term = st().addTab({ type: "terminal" });
    st().activateTab(term);
    const id = st().openPeek({ type: "files", openPath: "/work/a.png" });
    const peek = st().tabs.find((t) => t.id === id)!;
    expect(archivableByState(peek)).toBe(false);
    expect(visibleOrdered(st().tabs, st().groups)).not.toContain(peek);
    expect(sessionSnapshot(st()).tabs.map((t) => t.id)).not.toContain(id);
  });

  it("discards without a reopen-queue or archive entry, and promotes whole", async () => {
    const term = st().addTab({ type: "terminal" });
    st().activateTab(term);
    const id = st().openPeek({ type: "files", openPath: "/work/a.png" });
    st().discardPeek();
    await flushAll();
    expect(st().tabs.find((t) => t.id === id)).toBeUndefined();
    expect(st().peekTabId).toBeNull();
    expect(st().archive).toHaveLength(0);

    // "Open as tab" on the same peek hands the user an ordinary files tab
    // with the file still in hand — the payload survives promotion.
    const id2 = st().openPeek({ type: "files", openPath: "/work/a.png" });
    const promoted = st().promotePeek();
    expect(promoted).toBe(id2);
    expect(st().tabs.find((t) => t.id === id2)).toMatchObject({
      type: "files",
      openPath: "/work/a.png",
    });
    expect(st().tabs.find((t) => t.id === id2)?.peek).toBeUndefined();
  });

  it("one overlay at a time: a file peek replaces a browser peek and vice versa", () => {
    const term = st().addTab({ type: "terminal" });
    st().activateTab(term);
    const first = st().openPeek({ type: "browser", url: "https://one.example/" });
    const second = st().openPeek({ type: "files", openPath: "/work/a.png" });
    expect(st().tabs.find((t) => t.id === first)).toBeUndefined();
    expect(st().peekTabId).toBe(second);
    const third = st().openPeek({ type: "browser", url: "https://two.example/" });
    expect(st().tabs.find((t) => t.id === second)).toBeUndefined();
    expect(st().peekTabId).toBe(third);
    // Exactly one peek tab exists at a time.
    expect(st().tabs.filter((t) => t.peek === true)).toHaveLength(1);
  });
});

describe("the browser peek after parameterization", () => {
  it("keeps its own shape and title", () => {
    const term = st().addTab({ type: "terminal" });
    st().activateTab(term);
    const id = st().openPeek({ type: "browser", url: "https://elsewhere.example/page" });
    expect(st().tabs.find((t) => t.id === id)).toMatchObject({
      type: "browser",
      url: "https://elsewhere.example/page",
      title: "elsewhere.example",
      peek: true,
      peekOver: term,
    });
  });
});
