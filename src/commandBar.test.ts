import { describe, expect, it } from "vitest";
import {
  barCommands,
  buildBarSections,
  flattenRows,
  inlineCompletion,
  subsequenceScore,
  tabHaystack,
} from "./commandBar";
import type { VisitEntry } from "./history";
import type { Group, Tab } from "./state/store";


const tab = (partial: Partial<Tab> & { id: string; type: Tab["type"] }): Tab => ({
  title: partial.id,
  groupId: null,
  ...partial,
});

const group = (id: string, name: string): Group => ({
  id,
  name,
  colorIndex: 0,
  collapsed: false,
});

const site = (host: string, url = `https://${host}/`, title = ""): VisitEntry => ({
  url,
  title,
  host,
  visits: 3,
  lastVisit: Date.now(),
});

describe("resolution priority: the fallback, then tabs, then history, then commands", () => {
  it("orders the flattened rows by section, the open/search fallback on top and always present", () => {
    const sections = buildBarSections({
      mode: "global",
      query: "new",
      // "new" matches this tab's title, several command labels, and a site.
      tabs: [tab({ id: "t1", type: "terminal", title: "new-experiment" })],
      groups: [],
      sites: [site("news.example.org")],
    });
    const rows = flattenRows(sections);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows[0].kind).toBe("fallback");
    const kinds = rows.map((r) => r.kind);
    // No later section may jump an earlier one: fallback → tabs → sites →
    // commands.
    expect(kinds.indexOf("tab")).toBeGreaterThan(kinds.indexOf("fallback"));
    expect(kinds.indexOf("site")).toBeGreaterThan(kinds.lastIndexOf("tab"));
    expect(kinds.indexOf("command")).toBeGreaterThan(kinds.lastIndexOf("site"));
    expect(rows[rows.length - 1].kind).toBe("command");
    expect(kinds.filter((k) => k === "fallback")).toHaveLength(1);
  });

  it("judges the fallback with the shared address test", () => {
    const deps = { mode: "global" as const, tabs: [], groups: [], sites: [] };
    expect(buildBarSections({ ...deps, query: "github.com" }).fallback).toEqual({
      kind: "fallback",
      input: "github.com",
      url: "https://github.com",
    });
    expect(
      buildBarSections({ ...deps, query: "how to cook rice" }).fallback
    ).toEqual({ kind: "fallback", input: "how to cook rice", url: null });
  });

  it("an empty query is a start page: top sites plus common commands, no fallback", () => {
    const sections = buildBarSections({
      mode: "global",
      query: "",
      tabs: [tab({ id: "t1", type: "terminal" })],
      groups: [],
      sites: [site("daily.example.org")],
    });
    expect(sections.tabs).toEqual([]);
    expect(sections.commands.length).toBeGreaterThan(0);
    expect(sections.sites.map((r) => r.site.host)).toEqual(["daily.example.org"]);
    expect(sections.fallback).toBeNull();
  });

  it("the new-tab context has no tab and no command sections — history and fallback only", () => {
    const sections = buildBarSections({
      mode: "newtab",
      query: "new",
      tabs: [tab({ id: "t1", type: "terminal", title: "new-experiment" })],
      groups: [],
      sites: [site("news.example.org")],
    });
    expect(sections.tabs).toEqual([]);
    expect(sections.commands).toEqual([]);
    expect(sections.sites).toHaveLength(1);
    expect(sections.fallback).not.toBeNull();
    const kinds = flattenRows(sections).map((r) => r.kind);
    expect(kinds).toEqual(["fallback", "site"]);
  });
});

describe("the tab matching surface: title, kind, folder, url, subtitle", () => {
  it("finds a browser tab by its address when the title says nothing", () => {
    const t = tab({
      id: "b1",
      type: "browser",
      title: "Untitled",
      url: "https://github.com/tabverse/tabverse",
    });
    expect(subsequenceScore("github", tabHaystack(t, null))).not.toBeNull();
    const sections = buildBarSections({
      mode: "global",
      query: "github",
      tabs: [t],
      groups: [],
      sites: [],
    });
    expect(sections.tabs.map((r) => r.tab.id)).toEqual(["b1"]);
  });

  it("finds a terminal by its directory and a filed tab by its folder name", () => {
    const term = tab({
      id: "t1",
      type: "terminal",
      title: "Terminal 1",
      cwd: "/Users/me/proj/api-server",
    });
    expect(subsequenceScore("api-server", tabHaystack(term, null))).not.toBeNull();
    const filed = tab({ id: "t2", type: "terminal", title: "Terminal 2", groupId: "g1" });
    expect(
      subsequenceScore("ops", tabHaystack(filed, group("g1", "ops-work")))
    ).not.toBeNull();
  });

  it("a dormant pinned item is offered like any open tab (picking it wakes it)", () => {
    const asleep = tab({
      id: "d1",
      type: "browser",
      title: "Dashboard",
      groupId: "g1",
      pinnedUrl: "https://grafana.example.org/d/1",
      url: "https://grafana.example.org/d/1",
      dormant: true,
    });
    const sections = buildBarSections({
      mode: "global",
      query: "grafana",
      tabs: [asleep],
      groups: [group("g1", "Ops")],
      sites: [],
    });
    expect(sections.tabs.map((r) => r.tab.id)).toEqual(["d1"]);
  });
});

describe("the command inventory is the shortcut table, filtered — never a second list", () => {
  it("offers window-level commands, including the key-less new-browser", () => {
    const commands = barCommands().map((s) => String(s.command));
    expect(commands).toContain("new-browser");
    expect(commands).toContain("new-terminal");
    expect(commands).toContain("switcher");
  });

  it("offers neither view-owned keys, nor view-local ones, nor itself", () => {
    const commands = barCommands().map((s) => String(s.command));
    expect(commands).not.toContain("reload"); // means nothing off a page
    expect(commands).not.toContain("save-file"); // local to the editor
    expect(commands).not.toContain("command-bar"); // already open
  });
});

describe("inline completion: the rest of a domain this machine visits", () => {
  const ranked = [site("github.com"), site("gitlab.example.org"), site("www.example.org")];

  it("completes a prefix from the highest-ranked matching host", () => {
    expect(inlineCompletion("gi", ranked)).toEqual({
      host: "github.com",
      rest: "thub.com",
    });
    // Deeper prefixes keep narrowing to the same host.
    expect(inlineCompletion("gitl", ranked)).toEqual({
      host: "gitlab.example.org",
      rest: "ab.example.org",
    });
  });

  it("matches case-insensitively and through a www. prefix", () => {
    expect(inlineCompletion("GI", ranked)?.rest).toBe("thub.com");
    expect(inlineCompletion("exa", ranked)).toEqual({
      host: "example.org",
      rest: "mple.org",
    });
  });

  it("offers nothing when there is nothing honest to offer", () => {
    expect(inlineCompletion("", ranked)).toBeNull(); // nothing typed
    expect(inlineCompletion("github.com", ranked)).toBeNull(); // already whole
    expect(inlineCompletion("zzz", ranked)).toBeNull(); // no such habit
    expect(inlineCompletion("gi hub", ranked)).toBeNull(); // a sentence is a search
    expect(inlineCompletion("gi ", ranked)).toBeNull(); // trailing space says done
  });
});
