import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { flushAll } from "../persist";
import {
  CONFIG_KEYS,
  CONFIG_NOT_READ,
  configSlice,
  flushConfigWrites,
  type ConfigSnapshot,
  type ConfigValues,
  type Setting,
} from "../state/config";
import { useStore } from "../state/store";
import { STR } from "../strings";
import { SettingsView } from "./SettingsView";

/**
 * The registry as `config_schema` answers it, defaults and all.
 *
 * Every default here is one the real registry does not carry (the theme is
 * "system" there, the threshold "24h", the width 248). Nothing in the
 * interface could have supplied these, so a row this view calls "changed"
 * was judged against a value that travelled over the command.
 */
const SCHEMA: Setting[] = [
  {
    key: CONFIG_KEYS.theme,
    kind: { choice: { options: ["system", "light", "dark"] } },
    section: "appearance",
    str_key: "settings.appearance.theme",
    default: "dark",
  },
  {
    key: CONFIG_KEYS.sidebarWidth,
    kind: { number: { min: 180, max: 520 } },
    section: "appearance",
    str_key: "settings.appearance.sidebarWidth",
    default: 317,
  },
  {
    key: CONFIG_KEYS.sidebarPinned,
    kind: "toggle",
    section: "appearance",
    str_key: "settings.appearance.sidebarPinned",
    default: false,
  },
  {
    key: CONFIG_KEYS.searchEngine,
    kind: { choice: { options: ["duckduckgo", "google", "bing", "custom"] } },
    section: "search-engine",
    str_key: "settings.searchEngine.engine",
    default: "bing",
  },
  {
    key: CONFIG_KEYS.customSearchTemplate,
    // A rule that constrains nothing: what a template may contain is not
    // what this file is about, and a copy of the registry's real rule here
    // would be one more thing to go stale.
    kind: { text: { allow_empty: true, must_contain: null, schemes: null } },
    section: "search-engine",
    str_key: "settings.searchEngine.customTemplate",
    default: "https://from-the-registry.test/?q=%s",
  },
  {
    key: CONFIG_KEYS.archiveAfter,
    kind: { choice: { options: ["12h", "24h", "7d", "off"] } },
    section: "auto-archive",
    str_key: "settings.autoArchive.after",
    default: "7d",
  },
];

/** The same six as a configuration file that sets none of them would load. */
const AT_THE_DEFAULTS: ConfigValues = {
  appearance: { theme: "dark", sidebar_width: 317, sidebar_pinned: false },
  browser: {
    search_engine: "bing",
    custom_search_template: "https://from-the-registry.test/?q=%s",
    archive_after: "7d",
  },
};

/** The one setting these tests move, and what they move it to. */
const CHANGED_KEY = CONFIG_KEYS.archiveAfter;
const CHANGED_TO = "12h";

/**
 * What `config_get` answers with while the file is at its defaults. Sources
 * is non-empty on purpose: a file that exists is what the migration step
 * checks for, and an empty list would send it looking for old settings to
 * move in the middle of these tests.
 */
function snapshot(values: ConfigValues = AT_THE_DEFAULTS): ConfigSnapshot {
  return {
    values,
    warnings: [],
    sources: ["/home/u/.config/tabverse/config.toml"],
  };
}

/** Answer every command the settings page asks on the way up. */
function serve(schema: readonly Setting[], snap: ConfigSnapshot = snapshot()) {
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "config_schema") return schema;
    if (cmd === "config_get") return snap;
    if (cmd === "app_health") {
      return { shellIntegration: false, homeDir: "/home/u", version: "0.0.0" };
    }
    if (cmd === "list_trusted_hosts") return [];
    if (cmd === "default_apps_status") return [];
    return undefined;
  });
}

/**
 * Let the promises this page starts on mount finish.
 *
 * Turns of the macrotask queue as well as the microtask one: the schema
 * travels over a dynamic `import()` of the core's module before the command
 * is even issued, and that resolution is not a microtask.
 */
async function settle() {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const mounted: Array<() => void> = [];

function render(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(SettingsView)));
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return host;
}

/** Mount the page and turn the filter on, the way a reader would. */
async function pageWithFilterOn(): Promise<HTMLElement> {
  const host = render();
  await settle();
  flushSync(() => {});
  const toggle = host.querySelector<HTMLInputElement>(
    ".settings-changed-toggle input"
  );
  expect(toggle, "the changed-only switch").not.toBeNull();
  flushSync(() => toggle!.click());
  return host;
}

/** The dotted keys the changed list is showing, in the order it shows them. */
function listed(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll(".settings-changed-row")).map(
    (row) => row.getAttribute("data-setting") ?? ""
  );
}

/** Every command the page issued, in call order. */
function calls(): Array<[string, Record<string, unknown> | undefined]> {
  return mocks.invoke.mock.calls.map(([cmd, args]) => [cmd, args]);
}

const w = () => window as unknown as Record<string, unknown>;

beforeEach(async () => {
  await flushAll();
  await flushConfigWrites();
  localStorage.clear();
  mocks.invoke.mockReset();
  w().__TAURI_INTERNALS__ = {};
  useStore.setState({
    ...CONFIG_NOT_READ,
    // The file at its defaults, as the store would hold it after a load.
    ...configSlice(AT_THE_DEFAULTS),
    sidebarWidthRange: null,
    configError: null,
    configWarnings: [],
    configWarningsDismissed: false,
    configPath: null,
    tabs: [],
    activeTabId: null,
  });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  delete w().__TAURI_INTERNALS__;
});

describe("the changed-only view", () => {
  it("lists exactly the one setting that stands away from its default", async () => {
    serve(SCHEMA);
    useStore.setState({ archiveThreshold: CHANGED_TO });

    const host = await pageWithFilterOn();

    expect(listed(host)).toEqual([CHANGED_KEY]);
  });

  it("says so plainly when nothing has been changed", async () => {
    serve(SCHEMA);

    const host = await pageWithFilterOn();

    expect(listed(host)).toEqual([]);
    expect(host.querySelector(".settings-changed-empty")?.textContent).toBe(
      STR.settings.changed.none
    );
  });

  it("hides the sections and their rail while it is on", async () => {
    serve(SCHEMA);
    useStore.setState({ archiveThreshold: CHANGED_TO });

    const host = await pageWithFilterOn();

    // The class the stylesheet takes both columns out of the layout by —
    // asserted rather than the computed style, which no stylesheet is
    // loaded to produce here.
    expect(
      host.querySelector(".settings-layout")?.className,
      "the filtered layout"
    ).toContain("only-changed");
  });

  it("judges against the default the core sent, not one of its own", async () => {
    // The store holds what the *real* registry calls the default for these
    // two. The schema this run answers with says otherwise, and the schema
    // is what decides: both rows are changed here.
    serve(SCHEMA);
    useStore.setState({ themePreference: "system", archiveThreshold: "24h" });

    const host = await pageWithFilterOn();

    expect(listed(host)).toEqual([CONFIG_KEYS.theme, CHANGED_KEY]);
  });

  it("leaves out a row whose default the core did not send", async () => {
    // The defensive path: an older core, or a registry row this build does
    // not understand. Undecidable is not "unchanged by guess" — the row is
    // left out and offered no reset, and nothing here invents a default.
    const withoutDefault = SCHEMA.map((s) =>
      s.key === CHANGED_KEY
        ? ({ ...s, default: undefined } as unknown as Setting)
        : s
    );
    serve(withoutDefault);
    useStore.setState({ archiveThreshold: CHANGED_TO });

    const host = await pageWithFilterOn();

    expect(listed(host)).toEqual([]);
  });
});

describe("resetting one setting", () => {
  /** Turn the filter on with one setting changed, then press its Reset. */
  async function resetTheChangedOne(): Promise<HTMLElement> {
    const host = await pageWithFilterOn();
    expect(listed(host), "the row to reset").toEqual([CHANGED_KEY]);

    const row = host.querySelector(`[data-setting="${CHANGED_KEY}"]`);
    const button = row?.querySelector("button");
    expect(button?.textContent, "the row's Reset button").toBe(
      STR.settings.changed.reset
    );
    flushSync(() => button!.click());
    await settle();
    flushSync(() => {});
    return host;
  }

  it("puts the setting back and takes its row off the list", async () => {
    // config_get answers as the file does *after* the line is deleted: the
    // setting falls back to the registry's value.
    serve(SCHEMA);
    useStore.setState({ archiveThreshold: CHANGED_TO });

    const host = await resetTheChangedOne();

    expect(useStore.getState().archiveThreshold, "back to the default").toBe(
      "7d"
    );
    expect(listed(host)).toEqual([]);
    expect(host.querySelector(".settings-changed-empty")?.textContent).toBe(
      STR.settings.changed.none
    );
  });

  it("deletes the line rather than writing the default into the file", async () => {
    serve(SCHEMA);
    useStore.setState({ archiveThreshold: CHANGED_TO });

    await resetTheChangedOne();
    await flushConfigWrites();

    expect(calls()).toContainEqual(["config_reset", { key: CHANGED_KEY }]);
    // The whole point of the requirement: a default spelled out in the
    // user's file is frozen there, so no config_set may carry it — not for
    // this key, not for any other.
    const writes = calls().filter(([cmd]) => cmd === "config_set");
    expect(writes, "no setting was written back").toEqual([]);
  });

  it("re-reads the file rather than assuming what the reset left", async () => {
    serve(SCHEMA);
    useStore.setState({ archiveThreshold: CHANGED_TO });

    await resetTheChangedOne();

    const order = calls().map(([cmd]) => cmd);
    const reset = order.indexOf("config_reset");
    expect(reset, "config_reset was issued").toBeGreaterThanOrEqual(0);
    expect(
      order.slice(reset).includes("config_get"),
      "the file was read back afterwards"
    ).toBe(true);
  });
});
