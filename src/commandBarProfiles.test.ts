import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NEW_PROFILE_PREFIX,
  buildBarSections,
  flattenRows,
  type BarSections,
} from "./commandBar";
import { CommandBar } from "./components/CommandBar";
import { useStore } from "./state/store";
import {
  BOOT_CONFIG_KEY,
  DEMO_SCHEMA_KEY,
  type ConfigProfile,
  type ConfigValues,
} from "./state/config";


const PROFILES: ConfigProfile[] = [
  { name: "deploy", shell: "/bin/bash", cwd: "/srv" },
  { name: "local" },
  { name: "docs", cwd: "/notes" },
];

const deps = {
  tabs: [],
  groups: [],
  sites: [],
};

function sections(query: string, profiles = PROFILES): BarSections {
  return buildBarSections({ mode: "global", query, ...deps, profiles });
}

const names = (s: BarSections) => s.profiles.map((r) => r.profile.name);

describe("which profiles a query names", () => {
  it("offers every profile to the bare prefix", () => {
    expect(names(sections(NEW_PROFILE_PREFIX))).toEqual([
      "deploy",
      "local",
      "docs",
    ]);
  });

  it("narrows on what follows the colon", () => {
    expect(names(sections("new:dep"))).toEqual(["deploy"]);
    // Subsequence matching, the same as everywhere else in this module.
    expect(names(sections("new:dc"))).toEqual(["docs"]);
    expect(names(sections("new:nothing-by-that-name"))).toEqual([]);
  });

  it("is derived from the list it is given, not from a copy of it", () => {
    // The same query, two configurations. A hand-kept list answers both the
    // same way; this one answers what the file says.
    expect(names(sections(NEW_PROFILE_PREFIX, [{ name: "only" }]))).toEqual([
      "only",
    ]);
    expect(names(sections(NEW_PROFILE_PREFIX, []))).toEqual([]);
  });

  it("carries the profile whole, so the row can say what it opens", () => {
    const [row] = sections("new:deploy").profiles;
    expect(row.profile.cwd).toBe("/srv");
  });
});

describe("what the prefix protects", () => {
  it("offers nothing to a query that does not carry it", () => {
    // The name of a profile, typed on its own, is a search or an address as
    // far as this bar is concerned. Anything else would put three rows in
    // front of everyone who types a word starting with n.
    expect(names(sections("deploy"))).toEqual([]);
    expect(names(sections("new"))).toEqual([]);
    expect(names(sections("netflix.com"))).toEqual([]);
    expect(names(sections("a new: thing"))).toEqual([]);
  });

  it("offers nothing on an empty bar", () => {
    expect(sections("").profiles).toEqual([]);
  });

  it("offers nothing on the new-tab page, which opens addresses", () => {
    const page = buildBarSections({
      mode: "newtab",
      query: NEW_PROFILE_PREFIX,
      ...deps,
      profiles: PROFILES,
    });
    expect(page.profiles).toEqual([]);
  });

  it("treats a caller with no profiles as a caller with none", () => {
    const bare = buildBarSections({ mode: "global", query: "new:x", ...deps });
    expect(bare.profiles).toEqual([]);
  });
});

describe("where the rows sit", () => {
  it("leads the flat list, so a bare Enter opens the profile", () => {
    const rows = flattenRows(sections("new:deploy"));
    expect(rows[0].kind).toBe("profile");
    // The fallback is still there — it is simply no longer what Enter runs.
    expect(rows.some((r) => r.kind === "fallback")).toBe(true);
  });

  it("does not disturb the order when there are none", () => {
    const rows = flattenRows(sections("example.com"));
    expect(rows[0].kind).toBe("fallback");
  });
});

// ---------------------------------------------------------- the drawn bar

const w = () => window as unknown as Record<string, unknown>;

const CONFIG: ConfigValues = {
  appearance: { theme: "light", sidebar_width: 301, sidebar_pinned: false },
  browser: {
    search_engine: "duckduckgo",
    custom_search_template: "",
    archive_after: "24h",
  },
  terminal: { profiles: PROFILES },
};

const SCHEMA = [
  {
    key: "appearance.sidebar_width",
    kind: { number: { min: 180, max: 520 } },
    section: "appearance",
    str_key: "settings.appearance.sidebarWidth",
    default: 301,
  },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  w()[BOOT_CONFIG_KEY] = CONFIG;
  w()[DEMO_SCHEMA_KEY] = SCHEMA;
  useStore.setState({ tabs: [], activeTabId: null, commandBarOpen: true });
});

afterEach(() => {
  if (root && host) {
    const done = root;
    act(() => done.unmount());
    host.remove();
  }
  root = null;
  host = null;
  useStore.setState({ commandBarOpen: false });
  delete w()[BOOT_CONFIG_KEY];
  delete w()[DEMO_SCHEMA_KEY];
});

describe("the bar as it is drawn", () => {
  it("draws a row per profile and opens the one that is clicked", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const el = host;
    await act(async () => {
      root = createRoot(el);
      root.render(createElement(CommandBar));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const input = el.querySelector("input");
    expect(input, "the bar has no input").not.toBeNull();
    await act(async () => {
      // Typed, through the input's own handler — the route a person takes.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "new:deploy");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const rows = Array.from(
      el.querySelectorAll('[data-row-kind="profile"]')
    ) as HTMLElement[];
    expect(rows.length, "no profile row was drawn").toBe(1);
    expect(rows[0].textContent).toContain("deploy");

    await act(async () => {
      rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const tabs = useStore.getState().tabs;
    expect(tabs.map((t) => t.type)).toEqual(["terminal"]);
    expect(tabs[0].profile).toBe("deploy");
    // Running a row closes the bar, as running any row does.
    expect(useStore.getState().commandBarOpen).toBe(false);
  });
});
