import { describe, expect, it } from "vitest";
import {
  PANEL_DEFAULT_PX,
  PANEL_MIN_PX,
  cdCommand,
  clampPanelHeight,
  normalizeDir,
  quoteShellPath,
  syncDecision,
} from "./termSync";

describe("normalizeDir", () => {
  it("makes the two sources' spellings of one directory comparable", () => {
    expect(normalizeDir("/work/src/")).toBe("/work/src");
    expect(normalizeDir("/work//src")).toBe("/work/src");
    expect(normalizeDir("/")).toBe("/");
    expect(normalizeDir("")).toBeNull();
    expect(normalizeDir(null)).toBeNull();
  });

  it("normalizes an uncontrolled path with repeated separators in linear time", () => {
    const repeated = "/".repeat(100_000);
    expect(normalizeDir(`/work${repeated}src${repeated}`)).toBe("/work/src");
  });
});

describe("syncDecision: the tab moved", () => {
  it("sends a cd when the shell is somewhere else", () => {
    expect(syncDecision("tab", "/work", "/work/src", null)).toBe("send-cd");
  });

  it("sends a cd when the shell has never said where it is", () => {
    expect(syncDecision("tab", null, "/work/src", null)).toBe("send-cd");
  });

  it("stays quiet when the shell is already there", () => {
    expect(syncDecision("tab", "/work/src", "/work/src", null)).toBe("ignore");
  });

  it("stays quiet across a trailing slash — the same place, spelled twice", () => {
    expect(syncDecision("tab", "/work/src", "/work/src/", null)).toBe("ignore");
  });

  it("does not send the same cd twice while the first is in flight", () => {
    // The shell has not reported the new directory yet, so comparing against
    // it would say "different" and send the identical command again.
    expect(syncDecision("tab", "/work", "/work/src", "/work/src")).toBe(
      "ignore"
    );
  });

  it("sends the newer cd when the target changed while one was in flight", () => {
    expect(syncDecision("tab", "/work", "/work/docs", "/work/src")).toBe(
      "send-cd"
    );
  });

  it("has nothing to do with an empty directory", () => {
    expect(syncDecision("tab", "/work", "", null)).toBe("ignore");
  });
});

describe("syncDecision: the shell moved", () => {
  it("moves the tab when the user cd'd somewhere else", () => {
    expect(syncDecision("shell", "/work", "/work/src", null)).toBe("follow");
  });

  it("ignores the OSC 7 our own cd produced — the tab is already there", () => {
    expect(syncDecision("shell", "/work/src", "/work/src", "/work/src")).toBe(
      "ignore"
    );
  });

  it("still follows a report matching our cd when the tab is elsewhere", () => {
    // Suppressing this as an echo is what strands the two apart: the tab sits
    // at the older directory, the shell at the one we sent it to, and nothing
    // is left to bring them together.
    expect(syncDecision("shell", "/work/docs", "/work/src", "/work/src")).toBe(
      "follow"
    );
  });
});

describe("syncDecision: the echo cases end", () => {
  /** One decision applied to a running pair of directories. */
  const step = (
    state: { tab: string; shell: string | null; sent: string | null },
    source: "tab" | "shell",
    incoming: string
  ) => {
    const current = source === "tab" ? state.shell : state.tab;
    const action = syncDecision(source, current, incoming, state.sent);
    if (source === "tab") {
      if (action === "send-cd") return { ...state, tab: incoming, sent: incoming };
      return { ...state, tab: incoming };
    }
    // A report answers whatever cd was outstanding, landed or not.
    const settled = { ...state, shell: incoming, sent: null };
    return action === "follow" ? { ...settled, tab: incoming } : settled;
  };

  it("a tree click cds once and the confirming report changes nothing", () => {
    let s = { tab: "/work", shell: "/work" as string | null, sent: null as string | null };
    s = step(s, "tab", "/work/src");
    expect(s.sent).toBe("/work/src");
    // The shell reports where it landed; the tab must not read that as a new
    // place to go, and must not answer it with another cd.
    s = step(s, "shell", "/work/src");
    expect(s).toEqual({ tab: "/work/src", shell: "/work/src", sent: null });
    expect(syncDecision("tab", s.shell, s.tab, s.sent)).toBe("ignore");
  });

  it("a cd typed in the shell moves the tree and is not sent back", () => {
    let s = { tab: "/work", shell: "/work" as string | null, sent: null as string | null };
    s = step(s, "shell", "/work/docs");
    expect(s.tab).toBe("/work/docs");
    expect(s.sent).toBeNull();
    // The tab's own change handler now sees the new directory: it is where
    // the shell already is, so nothing goes back down the pipe.
    expect(syncDecision("tab", s.shell, s.tab, s.sent)).toBe("ignore");
  });

  it("converges when the tab moves twice before the first cd lands", () => {
    let s = { tab: "/work", shell: "/work" as string | null, sent: null as string | null };
    s = step(s, "tab", "/a");
    s = step(s, "tab", "/b");
    expect(s.sent).toBe("/b");
    // The report for the first cd arrives late; whatever the tab does with it,
    // the report for the second one has the last word.
    s = step(s, "shell", "/a");
    s = step(s, "shell", "/b");
    expect(s.tab).toBe("/b");
    expect(s.shell).toBe("/b");
    expect(syncDecision("tab", s.shell, s.tab, s.sent)).toBe("ignore");
  });
});

describe("quoteShellPath", () => {
  it("leaves an ordinary path as the user would have typed it", () => {
    expect(quoteShellPath("/Users/me/project-1/src")).toBe(
      "/Users/me/project-1/src"
    );
  });

  it("quotes what the shell would otherwise read as syntax", () => {
    // A tilde expands, a star globs, a bang is history: all of them would
    // send the shell somewhere other than the directory named here.
    expect(quoteShellPath("/work/~backup")).toBe("'/work/~backup'");
    expect(quoteShellPath("/work/v*")).toBe("'/work/v*'");
    expect(quoteShellPath("/work/hi!")).toBe("'/work/hi!'");
  });

  it("survives the characters a directory name is allowed to contain", () => {
    expect(quoteShellPath("/work/my project")).toBe("'/work/my project'");
    expect(quoteShellPath("/work/$HOME `x`")).toBe("'/work/$HOME `x`'");
    expect(quoteShellPath('/work/say "hi"')).toBe(`'/work/say "hi"'`);
    expect(quoteShellPath("/work/back\\slash")).toBe("'/work/back\\slash'");
  });

  it("closes, escapes and reopens the one character quotes cannot hold", () => {
    expect(quoteShellPath("/work/Don't Panic")).toBe(
      `'/work/Don'\\''t Panic'`
    );
  });

  it("is a command, newline included", () => {
    expect(cdCommand("/work/src")).toBe("cd /work/src\n");
    expect(cdCommand("/work/my project")).toBe("cd '/work/my project'\n");
  });
});

describe("clampPanelHeight", () => {
  it("keeps a height that is already reasonable", () => {
    expect(clampPanelHeight(240, 900)).toBe(240);
  });

  it("lifts a height too small to show anything", () => {
    expect(clampPanelHeight(12, 900)).toBe(PANEL_MIN_PX);
  });

  it("caps a height that would swallow the files it belongs to", () => {
    expect(clampPanelHeight(880, 900)).toBe(630);
  });

  it("lets the cap win when the pane is too short to honour the minimum", () => {
    // 70% of 100 is below the floor: better a cramped panel than a file view
    // with no room left at all.
    expect(clampPanelHeight(300, 100)).toBe(70);
  });

  it("applies only the floor before anything has been measured", () => {
    expect(clampPanelHeight(4000)).toBe(4000);
    expect(clampPanelHeight(10)).toBe(PANEL_MIN_PX);
  });

  it("falls back to the default height when the stored value is junk", () => {
    expect(clampPanelHeight(Number.NaN)).toBe(PANEL_DEFAULT_PX);
    expect(clampPanelHeight(Number.POSITIVE_INFINITY, 900)).toBe(
      PANEL_DEFAULT_PX
    );
  });

  it("returns whole pixels", () => {
    expect(clampPanelHeight(200.6, 900)).toBe(201);
  });
});
