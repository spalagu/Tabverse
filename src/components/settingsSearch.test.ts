import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { configSchema, type Setting } from "../state/config";
import { STR } from "../strings";
import { SettingsView } from "./SettingsView";
import { SETTINGS_SECTIONS } from "./settingsSections";
import {
  SECTION_INDEX,
  buildSettingsIndex,
  searchSettings,
  strAt,
  stringLeaves,
} from "./settingsSearch";

/**
 * The registry as the core hands it over, standing in for the Rust table
 * (src-tauri/src/config.rs `SETTINGS`) that vitest cannot call. Written out
 * in full rather than trimmed to the rows a test reads, because the count
 * assertions below are about the whole answer.
 */
const REGISTRY_ROWS: Setting[] = [
  {
    key: "appearance.theme",
    kind: { choice: { options: ["system", "light", "dark"] } },
    section: "appearance",
    str_key: "settings.appearance.theme",
    default: "system",
  },
  {
    key: "appearance.sidebar_width",
    kind: { number: { min: 180, max: 520 } },
    section: "appearance",
    str_key: "settings.appearance.sidebarWidth",
    default: 248,
  },
  {
    key: "appearance.sidebar_pinned",
    kind: "toggle",
    section: "appearance",
    str_key: "settings.appearance.sidebarPinned",
    default: true,
  },
  {
    key: "browser.search_engine",
    kind: { choice: { options: ["duckduckgo", "google", "bing", "custom"] } },
    section: "search-engine",
    str_key: "settings.searchEngine.engine",
    default: "duckduckgo",
  },
  {
    key: "browser.custom_search_template",
    // Constrains nothing: this file indexes settings, and what a template
    // may contain has no bearing on it.
    kind: { text: { allow_empty: true, must_contain: null, schemes: null } },
    section: "search-engine",
    str_key: "settings.searchEngine.customTemplate",
    default: "",
  },
  {
    key: "browser.archive_after",
    kind: { choice: { options: ["12h", "24h", "7d", "off"] } },
    section: "auto-archive",
    str_key: "settings.autoArchive.after",
    default: "24h",
  },
];

const ROW_NOBODY_WROTE_DOWN: Setting = {
  key: "terminal.scrollback_lines",
  kind: { number: { min: 100, max: 100000 } },
  section: "session",
  str_key: "settings.session.scrollbackLines",
  default: 10000,
};

/** Answer `config_schema` with `rows`; every other command succeeds mutely. */
function serve(rows: Setting[]) {
  mocks.invoke.mockImplementation(async (cmd) =>
    cmd === "config_schema" ? rows : undefined
  );
}

/**
 * Let the fire-and-forget round trips inside the page finish — and let
 * React run the effects that start them. Draining microtasks alone is not
 * enough: passive effects are scheduled on a task, so `config_schema` would
 * never even be asked for and the page would search with an empty index.
 */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
}

const w = () => window as unknown as Record<string, unknown>;

// ------------------------------------------------------------ the page

let host: HTMLElement | null = null;
let root: Root | null = null;

/** The settings page, mounted and past its first round trips. */
async function openSettings(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(createElement(SettingsView)));
  await settle();
  return host;
}

function searchBox(): HTMLInputElement {
  const input = host!.querySelector<HTMLInputElement>(".settings-search-input");
  if (input === null) throw new Error("the settings page has no search box");
  return input;
}

/**
 * Type into the search box the way a person does — one input event on the
 * real element. The value goes in through the prototype's own setter so
 * React's value tracker sees a change; assigning `input.value` directly is
 * swallowed and the page would never re-render.
 */
async function typeSearch(text: string) {
  const input = searchBox();
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )!.set!;
  setValue.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

/** The section ids still on screen, in page order. */
function visibleSections(): string[] {
  return Array.from(host!.querySelectorAll("section"))
    .filter((s) => !s.hasAttribute("hidden") && s.closest("[hidden]") === null)
    .map((s) => s.getAttribute("id") ?? "");
}

/** The section ids the rail is offering. */
function railSections(): string[] {
  return Array.from(host!.querySelectorAll(".settings-nav-item")).map(
    (b) => (b.getAttribute("data-target") ?? "").replace(/^settings:/, "")
  );
}

beforeEach(() => {
  mocks.invoke.mockReset();
  w().__TAURI_INTERNALS__ = {};
  serve(REGISTRY_ROWS);
});

afterEach(() => {
  if (root !== null) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  delete w().__TAURI_INTERNALS__;
});

// ------------------------------------------------------------ the index

describe("the search index is derived, never written down", () => {
  it("holds exactly one entry per row config_schema returned", async () => {
    const rows = await configSchema();
    const index = buildSettingsIndex(rows);

    expect(index.length, "one entry per registry row").toBe(rows.length);
    expect(index.map((e) => e.key)).toEqual(rows.map((r) => r.key));
  });

  it("grows with the registry without being edited", async () => {
    // The same assertion against a registry this file does not describe. A
    // literal index passes the case above by coincidence of length; it
    // cannot pass this one, because the seventh row's key is not in it.
    serve([...REGISTRY_ROWS, ROW_NOBODY_WROTE_DOWN]);
    const rows = await configSchema();
    const index = buildSettingsIndex(rows);

    expect(index.length, "one entry per registry row").toBe(rows.length);
    expect(index.map((e) => e.key)).toContain(ROW_NOBODY_WROTE_DOWN.key);
  });

  it("shrinks with it too", async () => {
    serve(REGISTRY_ROWS.slice(0, 2));
    const rows = await configSchema();
    expect(buildSettingsIndex(rows).length).toBe(rows.length);
  });

  it("takes each entry's words from the strings table at its str_key", () => {
    const index = buildSettingsIndex(REGISTRY_ROWS);
    for (const entry of index) {
      const row = REGISTRY_ROWS.find((r) => r.key === entry.key)!;
      // Compared against the leaf the registry points at, not against a
      // sentence typed here: this is the second source of the index, and
      // the assertion is that it is read rather than restated.
      expect(entry.title, `title of ${entry.key}`).toBe(strAt(row.str_key));
      expect(entry.text, `haystack of ${entry.key}`).toContain(
        row.key.toLowerCase()
      );
    }
    // Every one of the six registry rows has a real leaf behind it. A null
    // here is a str_key that has gone stale.
    expect(
      index.filter((e) => e.title === null).map((e) => e.key),
      "rows whose str_key leads nowhere"
    ).toEqual([]);
  });

  it("has one section entry per section the page renders", () => {
    expect(SECTION_INDEX.map((e) => e.id)).toEqual(
      SETTINGS_SECTIONS.map((s) => s.id)
    );
    for (const entry of SECTION_INDEX) {
      expect(entry.text.length, `${entry.id} has no words`).toBeGreaterThan(0);
    }
  });

  it("reads a section's words out of its own subtree", () => {
    const appearance = SECTION_INDEX.find((e) => e.id === "appearance")!;
    for (const leaf of stringLeaves(STR.settings.appearance)) {
      expect(appearance.text, `“${leaf}” is missing`).toContain(
        leaf.toLowerCase()
      );
    }
  });

  it("answers nothing for a path that leads nowhere", () => {
    expect(strAt("settings.appearance.colourScheme")).toBeNull();
    // A path landing on a subtree rather than on a string is not a string.
    expect(strAt("settings.appearance")).toBeNull();
    expect(strAt("")).toBeNull();
  });
});

// ----------------------------------------------------------- the matching

describe("matching", () => {
  const index = () => buildSettingsIndex(REGISTRY_ROWS);

  it("leaves only the section of the setting whose title was typed", () => {
    // A fragment of a real title, checked against the strings table so that
    // a rewording fails this loudly instead of quietly testing nothing.
    const fragment = "untouched tab";
    expect(STR.settings.autoArchive.after.toLowerCase()).toContain(fragment);

    const match = searchSettings(fragment, index());
    expect(match).not.toBeNull();
    expect(match!.sections, "sections kept").toEqual(["auto-archive"]);
    expect(match!.keys, "rows lit up").toEqual(["browser.archive_after"]);
    expect(match!.empty).toBe(false);
  });

  it("empties the page for a word no copy contains", () => {
    const match = searchSettings("zzzq", index());
    expect(match).not.toBeNull();
    expect(match!.sections).toEqual([]);
    expect(match!.keys).toEqual([]);
    expect(match!.empty).toBe(true);
  });

  it("treats an empty box as no search at all", () => {
    // Null, not a match that happens to keep everything: only null leaves
    // the page exactly as it is when nobody has searched.
    expect(searchSettings("", index())).toBeNull();
    expect(searchSettings("   ", index())).toBeNull();
  });

  it("finds a row by the key printed in the configuration file", () => {
    const match = searchSettings("browser.archive_after", index());
    expect(match!.keys).toEqual(["browser.archive_after"]);
  });

  it("takes the words in whatever order they were typed", () => {
    const inOrder = searchSettings("sidebar width", index());
    const reversed = searchSettings("width sidebar", index());
    expect(inOrder!.keys).toEqual(["appearance.sidebar_width"]);
    expect(reversed!.keys).toEqual(inOrder!.keys);
  });

  it("finds a section that has no settings of its own", () => {
    // Ten of the thirteen sections hold no registry setting this milestone.
    // Searching them is what the strings-table half of the index is for.
    const match = searchSettings("shell integration", index());
    expect(match!.sections).toEqual(["status"]);
    expect(match!.keys, "no setting matched, so no row lights up").toEqual([]);
  });

  it("lights up a row only when the row itself matched", () => {
    // A word from the section's prose, not from any setting's title: the
    // section stays, and nothing inside it is highlighted as the answer.
    const word = "device";
    expect(STR.settings.appearance.blurb.toLowerCase()).toContain(word);
    const match = searchSettings(word, index());
    expect(match!.sections).toContain("appearance");
    expect(match!.keys).toEqual([]);
  });

  it("searches sections even when the registry never arrived", () => {
    // The browser demo: no core, so no schema. Section search still works,
    // which is why the empty index is a degradation rather than a death.
    const match = searchSettings("shell integration", []);
    expect(match!.sections).toEqual(["status"]);
  });
});

// -------------------------------------------------------------- the page

describe("the settings page under a search", () => {
  it("shows every section before anything is typed", async () => {
    await openSettings();
    expect(visibleSections()).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
    expect(railSections()).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
  });

  it("keeps only the section that answered, rail included", async () => {
    await openSettings();
    await typeSearch("untouched tab");

    expect(visibleSections()).toEqual(["auto-archive"]);
    expect(railSections()).toEqual(["auto-archive"]);
  });

  it("lights up the control the search matched", async () => {
    await openSettings();
    await typeSearch("untouched tab");

    const hit = host!.querySelector('[data-setting-key="browser.archive_after"]');
    expect(hit, "the archive control").not.toBeNull();
    expect(hit!.className).toContain("settings-hit");
    // And nothing else is claiming to be the answer.
    expect(host!.querySelectorAll(".settings-hit").length).toBe(1);
  });

  it("says nothing matched, in the strings table's own words", async () => {
    await openSettings();
    await typeSearch("zzzq");

    expect(visibleSections()).toEqual([]);
    const empty = host!.querySelector(".settings-search-empty");
    expect(empty, "the empty state").not.toBeNull();
    // The STR value, not a sentence retyped here (the previous round's
    // lesson: a matrix cell comparing an inline literal proves nothing).
    expect(empty!.textContent).toBe(
      STR.settings.search.noMatches({ query: "zzzq" })
    );
  });

  it("restores the whole page when the box is cleared", async () => {
    await openSettings();
    await typeSearch("zzzq");
    expect(visibleSections()).toEqual([]);

    await typeSearch("");
    expect(visibleSections()).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
    expect(host!.querySelector(".settings-search-empty")).toBeNull();
    expect(host!.querySelectorAll(".settings-hit").length).toBe(0);
  });

  it("names the box for a screen reader out of the strings table", async () => {
    await openSettings();
    expect(searchBox().getAttribute("aria-label")).toBe(
      STR.settings.search.label
    );
  });
});
