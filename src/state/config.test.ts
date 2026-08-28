import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  SESSION_SCOPE,
  THEME_SCOPE,
  deleteState,
  flushAll,
  listScopes,
  loadState,
} from "../persist";
import {
  BOOT_CONFIG_KEY,
  CONFIG_KEYS,
  CONFIG_NOT_READ,
  bootConfigSlice,
  configErrorPath,
  configSlice,
  flushConfigWrites,
  numberRange,
  type ConfigSlice,
  type ConfigSnapshot,
  type ConfigValues,
  type Setting,
} from "./config";
import { forgetSessionScopes, sessionSnapshot, useStore } from "./store";
import { SettingsView } from "../components/SettingsView";
import { ConfirmHost } from "../components/Confirm";
import { STR } from "../strings";

/**
 * Values nothing in the interface could have supplied: a width that is not
 * 248, an engine that is not duckduckgo, a threshold that is not 24h. If a
 * test reads one of these out of the store, it travelled over config_get.
 */
const FROM_THE_FILE: ConfigValues = {
  appearance: { theme: "light", sidebar_width: 317, sidebar_pinned: false },
  browser: {
    search_engine: "bing",
    custom_search_template: "https://from-the-file.test/?q=%s",
    archive_after: "7d",
  },
};

function snapshot(over: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    values: FROM_THE_FILE,
    warnings: [],
    sources: ["/home/u/.config/tabverse/config.toml"],
    ...over,
  };
}

/** Every `config_set` the code under test issued, in call order. */
function writes(): Array<[string, unknown]> {
  return mocks.invoke.mock.calls
    .filter(([cmd]) => cmd === "config_set")
    .map(([, args]) => [args?.key as string, args?.value]);
}

/**
 * The registry rows as config_schema hands them over. Only the one row this
 * milestone reads a bound from is filled in; the rest of the table is the
 * settings page's business, not this file's.
 */
let schemaRows: Setting[] = [];

/** Answer config_get with `snap`; everything else succeeds silently. */
function serve(snap: ConfigSnapshot | Error) {
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "config_get") {
      if (snap instanceof Error) throw snap.message;
      return snap;
    }
    if (cmd === "config_schema") return schemaRows;
    return undefined;
  });
}

/**
 * A schema whose sidebar width may only be between `min` and `max`.
 *
 * The default the row carries is deliberately not the registry's own — these
 * tests are about the bound, and a fixture that happened to agree with
 * `Config::default()` would let a reader take it for the real value.
 */
function widthBetween(min: number, max: number): Setting[] {
  return [
    {
      key: CONFIG_KEYS.sidebarWidth,
      kind: { number: { min, max } },
      section: "appearance",
      str_key: "settings.appearance.sidebarWidth",
      default: 301,
    },
  ];
}

const w = () => window as unknown as Record<string, unknown>;

/**
 * A second set of values as different from the first as the domains allow,
 * for the cases that need "the file said X, something else said Y".
 */
const FROM_THE_INJECTION: ConfigValues = {
  appearance: { theme: "dark", sidebar_width: 199, sidebar_pinned: true },
  browser: {
    search_engine: "google",
    custom_search_template: "https://injected.test/?q=%s",
    archive_after: "12h",
  },
};

/** Put a configuration where the core would have injected one. */
function inject(values: ConfigValues | null) {
  if (values === null) delete w()[BOOT_CONFIG_KEY];
  else w()[BOOT_CONFIG_KEY] = values;
}

/**
 * A module's own text, for the two assertions that are about code shape
 * rather than behaviour. Resolved against the working directory, which the
 * runner sets to the repository root — `import.meta.url` is not a file URL
 * under the browser-shaped environment these tests run in.
 */
function sourceOf(relative: string): string {
  return resolve(process.cwd(), relative);
}

/** A module's code with its prose removed, so a comment about a construction
 *  is never mistaken for the construction. */
function codeOf(relative: string): string {
  return readFileSync(sourceOf(relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Let fire-and-forget promise chains run to completion. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** The six, as they stand in the store right now. */
function sixNow(): ConfigSlice {
  const s = useStore.getState();
  return {
    themePreference: s.themePreference,
    sidebarWidth: s.sidebarWidth,
    sidebarPinned: s.sidebarPinned,
    searchEngine: s.searchEngine,
    customSearchTemplate: s.customSearchTemplate,
    archiveThreshold: s.archiveThreshold,
  };
}

beforeEach(async () => {
  await flushAll();
  await flushConfigWrites();
  localStorage.clear();
  mocks.invoke.mockReset();
  // Set after the modules above have been imported, so the state doorway is
  // already bound to its browser carrier (localStorage) while the config
  // module — which asks at call time — sees a desktop core to talk to.
  w().__TAURI_INTERNALS__ = {};
  inject(null);
  schemaRows = [];
  useStore.setState({
    sidebarWidthRange: null,
    ...CONFIG_NOT_READ,
    configError: null,
    configWarnings: [],
    configWarningsDismissed: false,
    configPath: null,
    tabs: [],
    activeTabId: null,
  });
});

afterEach(() => {
  delete w().__TAURI_INTERNALS__;
});

describe("the six settings come from the configuration file", () => {
  it("fills every one of them from config_get, not from a constant here", async () => {
    serve(snapshot());
    await useStore.getState().initConfig();

    const s = useStore.getState();
    // Named one by one so a failure says which setting stopped listening to
    // the file, rather than only that some object differs.
    expect(s.themePreference, "themePreference").toBe("light");
    expect(s.sidebarWidth, "sidebarWidth").toBe(317);
    expect(s.sidebarPinned, "sidebarPinned").toBe(false);
    expect(s.searchEngine, "searchEngine").toBe("bing");
    expect(s.customSearchTemplate, "customSearchTemplate").toBe(
      "https://from-the-file.test/?q=%s"
    );
    expect(s.archiveThreshold, "archiveThreshold").toBe("7d");
  });

  it("moves the theme's derived value with it", async () => {
    // The one setting with a consequence beyond itself: everything on
    // screen subscribes to resolvedTheme, so a preference that lands in the
    // store without re-resolving is a preference nothing acts on.
    useStore.setState({ systemDark: true, resolvedTheme: "dark" });
    serve(snapshot());
    await useStore.getState().initConfig();
    expect(useStore.getState().resolvedTheme).toBe("light");
  });

  it("asks for it once and takes what it is given", async () => {
    serve(snapshot());
    await useStore.getState().initConfig();
    const asked = mocks.invoke.mock.calls.filter(
      ([cmd]) => cmd === "config_get"
    );
    expect(asked.length).toBe(1);
  });

  it("says nothing at all when there is no desktop core to ask", async () => {
    // The browser demo. No file exists there, which is a normal state and
    // not something to raise a banner about.
    delete w().__TAURI_INTERNALS__;
    await useStore.getState().initConfig();
    expect(useStore.getState().configError).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("the values the core injected before the first paint", () => {
  it("takes the six from the injection, with no round trip at all", () => {
    inject(FROM_THE_INJECTION);
    expect(bootConfigSlice()).toEqual(configSlice(FROM_THE_INJECTION));
  });

  it("reads nothing rather than guessing when nothing was injected", () => {
    inject(null);
    expect(bootConfigSlice()).toEqual(CONFIG_NOT_READ);
  });

  it("treats a malformed injection as no injection", () => {
    for (const bad of [null, 42, "config", {}, { appearance: 1 }]) {
      w()[BOOT_CONFIG_KEY] = bad;
      expect(bootConfigSlice(), JSON.stringify(bad)).toEqual(CONFIG_NOT_READ);
    }
  });

  it("builds the store from it, in the tick the store is created", async () => {
    // A store module of its own, created with the injection already in
    // place — which is the real sequence: the core runs the injection script
    // before the page's first script, so the store is never built without it.
    vi.resetModules();
    inject(FROM_THE_INJECTION);
    const fresh = await import("./store");
    const s = fresh.useStore.getState();
    expect(s.sidebarWidth, "sidebarWidth").toBe(199);
    expect(s.searchEngine, "searchEngine").toBe("google");
    expect(s.archiveThreshold, "archiveThreshold").toBe("12h");
    expect(s.themePreference, "themePreference").toBe("dark");
    expect(fresh.settingsReady(s), "every setting has arrived").toBe(true);
    vi.resetModules();
  });

  it("builds it unready when nothing was injected", async () => {
    vi.resetModules();
    inject(null);
    const fresh = await import("./store");
    const s = fresh.useStore.getState();
    expect(s.sidebarWidth).toBeNull();
    expect(s.searchEngine).toBeNull();
    expect(fresh.settingsReady(s)).toBe(false);
    vi.resetModules();
  });

  it("lets config_get correct what was injected", async () => {
    inject(FROM_THE_INJECTION);
    useStore.setState({ ...configSlice(FROM_THE_INJECTION) });
    serve(snapshot());
    await useStore.getState().initConfig();
    // The injection is a head start, not a second authority: the load that
    // follows it is what the interface ends up on.
    expect(useStore.getState().sidebarWidth).toBe(317);
    expect(useStore.getState().searchEngine).toBe("bing");
  });
});

describe("the store holds no copy of a default", () => {
  it("initialises the six from one mapping rather than six literals", () => {
    // A source-text assertion, because the shape is the requirement: the
    // survey found these written out in the store's initial object AND
    // again in its restore fallbacks, which is how "improve a default, miss
    // a copy" happened. Patterns, not exact lines — a reformat must not
    // fail this, and a re-introduced literal must not slip past it.
    const source = codeOf("src/state/store.ts");
    const banned: Array<[string, RegExp]> = [
      ["themePreference", /themePreference\s*:\s*["'`]/],
      ["searchEngine", /searchEngine\s*:\s*["'`]/],
      ["customSearchTemplate", /customSearchTemplate\s*:\s*["'`]/],
      ["archiveThreshold", /archiveThreshold\s*:\s*["'`]/],
      ["sidebarWidth", /sidebarWidth\s*:\s*\d/],
      ["sidebarPinned", /sidebarPinned\s*:\s*(true|false)\b/],
    ];
    for (const [name, re] of banned) {
      const hit = re.exec(source);
      expect(
        hit,
        `store.ts assigns ${name} a literal value: ${hit?.[0] ?? ""}`
      ).toBeNull();
    }
  });

  it("keeps the search module's fallback off the default's name", () => {
    // DEFAULT_ENGINE was one of the three copies of "duckduckgo". What is
    // left is a fallback for an unusable custom template, derived from the
    // engine table — it must not be a second declaration of the setting.
    const source = codeOf("src/search.ts");
    expect(source).not.toMatch(/\bDEFAULT_ENGINE\b/);
    // Nor does anything else in the module name that engine as a value.
    // The table's `duckduckgo:` key is the engine's own identity — part of
    // the value domain, which the registry also declares — while a quoted
    // "duckduckgo" would be somebody choosing it on the user's behalf.
    expect(
      source.match(/["'`]duckduckgo["'`]/g) ?? [],
      "search.ts states duckduckgo as a value"
    ).toHaveLength(0);
  });
});

describe("moving the six out of the session scope, once", () => {
  /** A session written by a version that still carried these fields. */
  const legacySession = {
    version: 1,
    zones: 3,
    tabs: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "terminal",
        title: "Terminal 1",
        groupId: null,
      },
    ],
    groups: [],
    activeTabId: null,
    sidebarWidth: 402,
    sidebarPinned: true,
    archiveThreshold: "12h",
    searchEngine: "google",
    customSearchTemplate: "https://old.test/?q=%s",
  };

  const seedLegacySession = () =>
    localStorage.setItem(
      `tabverse.state.${SESSION_SCOPE}`,
      JSON.stringify(legacySession)
    );

  /**
   * What config_get answers when no file contributed: the built-in defaults,
   * whatever they are. The test never names them — it uses whatever comes
   * back as the thing an old value is compared against, which is the same
   * comparison the migration makes.
   */
  const noFileYet = (): ConfigSnapshot => ({
    values: FROM_THE_FILE,
    warnings: [],
    sources: [],
  });

  it("writes the old values into the file when no file has said anything", async () => {
    seedLegacySession();
    localStorage.setItem(
      `tabverse.state.${THEME_SCOPE}`,
      JSON.stringify({ preference: "dark" })
    );
    serve(noFileYet());
    await useStore.getState().initConfig();
    await flushConfigWrites();

    expect(new Map(writes())).toEqual(
      new Map<string, unknown>([
        [CONFIG_KEYS.sidebarWidth, 402],
        [CONFIG_KEYS.sidebarPinned, true],
        [CONFIG_KEYS.archiveAfter, "12h"],
        [CONFIG_KEYS.searchEngine, "google"],
        [CONFIG_KEYS.customSearchTemplate, "https://old.test/?q=%s"],
        [CONFIG_KEYS.theme, "dark"],
      ])
    );
    // And they apply to this run, not only to the next one.
    expect(useStore.getState().sidebarWidth).toBe(402);
    expect(useStore.getState().themePreference).toBe("dark");
  });

  it("never overwrites a file that already exists", async () => {
    seedLegacySession();
    // A file contributed, so what it says wins outright — the old session's
    // copies are not merged in, key by key or otherwise.
    serve(snapshot());
    await useStore.getState().initConfig();
    await flushConfigWrites();

    expect(writes()).toEqual([]);
    expect(useStore.getState().sidebarWidth).toBe(317);
    expect(useStore.getState().searchEngine).toBe("bing");
  });

  it("happens once: the second start finds nothing left to move", async () => {
    seedLegacySession();
    serve(noFileYet());
    await useStore.getState().initConfig();
    await flushConfigWrites();
    await flushAll();
    expect(writes().length).toBeGreaterThan(0);

    // The session snapshot has been stripped, which is what makes it once —
    // no marker to keep, and nothing to go wrong if one were lost.
    const pruned = await loadState<Record<string, unknown>>(SESSION_SCOPE);
    for (const field of [
      "sidebarWidth",
      "sidebarPinned",
      "archiveThreshold",
      "searchEngine",
      "customSearchTemplate",
    ]) {
      expect(Object.keys(pruned ?? {}), `${field} still in the session`)
        .not.toContain(field);
    }
    expect(pruned?.tabs, "the session itself survives").toBeDefined();

    mocks.invoke.mockClear();
    serve(noFileYet());
    await useStore.getState().initConfig();
    await flushConfigWrites();
    expect(writes()).toEqual([]);
  });

  it("creates nothing for a user whose settings were all default", async () => {
    localStorage.setItem(
      `tabverse.state.${SESSION_SCOPE}`,
      JSON.stringify({ ...legacySession, ...configSlice(FROM_THE_FILE) })
    );
    serve(noFileYet());
    await useStore.getState().initConfig();
    await flushConfigWrites();
    expect(writes()).toEqual([]);
  });

  it.each([
    "{ not json",
    JSON.stringify({ version: 2, tabs: [] }),
    JSON.stringify({ version: 1, tabs: "not-an-array" }),
    JSON.stringify({ version: 1, tabs: [] }),
  ])("does not rewrite an unrecoverable session before recovery is confirmed", async (raw) => {
    localStorage.setItem(`tabverse.state.${SESSION_SCOPE}`, raw);
    serve(noFileYet());

    await useStore.getState().initConfig();
    await flushConfigWrites();
    await flushAll();

    expect(localStorage.getItem(`tabverse.state.${SESSION_SCOPE}`)).toBe(raw);
  });
});

describe("forgetting the saved session no longer forgets the settings", () => {
  it("keeps all six across the erasure and the restart after it", async () => {
    serve(snapshot());
    await useStore.getState().initConfig();
    const before = sixNow();

    // Exactly what the settings page's Forget saved session does: sweep the
    // scopes it is given. Before the move, the session scope held five of
    // these six and this loop erased them.
    for (const scope of forgetSessionScopes(await listScopes())) {
      deleteState(scope);
    }
    await flushAll();

    // The restart. The file is untouched by any of the above, so config_get
    // answers exactly as it did before.
    useStore.setState({ ...CONFIG_NOT_READ });
    await useStore.getState().initConfig();
    const after = sixNow();
    expect(after).toEqual(before);
    expect(after).not.toEqual(CONFIG_NOT_READ);
  });

  it("is what the page's own button does, not merely what a helper offers", async () => {
    // Driven through the button, because the filter protects nothing unless
    // the action actually goes through it: a version of this test that calls
    // forgetSessionScopes directly passes against a page that ignores it.
    const carrier = (scope: string) => `tabverse.state.${scope}`;
    localStorage.setItem(carrier(SESSION_SCOPE), JSON.stringify({ tabs: [] }));
    localStorage.setItem(
      carrier(THEME_SCOPE),
      JSON.stringify({ preference: "dark" })
    );
    localStorage.setItem(carrier("browser-history"), "[]");

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    flushSync(() =>
      root.render(
        createElement(
          "div",
          null,
          createElement(SettingsView),
          createElement(ConfirmHost)
        )
      )
    );
    const button = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === STR.settings.danger.session
    );
    expect(button, "the Forget saved session button").toBeDefined();
    flushSync(() => button!.click());
    await settle();
    // And answering it is part of what pressing the button now means.
    const proceed = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".confirm-actions .btn.danger")
    ).find((b) => b.textContent === STR.settings.danger.sessionConfirm);
    expect(proceed, "the confirmation's own proceed button").toBeDefined();
    flushSync(() => proceed!.click());
    await settle();
    await flushAll();
    await settle();

    expect(
      localStorage.getItem(carrier(THEME_SCOPE)),
      "the theme snapshot survives"
    ).not.toBeNull();
    expect(
      localStorage.getItem(carrier(SESSION_SCOPE)),
      "the session itself is gone"
    ).toBeNull();
    expect(
      localStorage.getItem(carrier("browser-history")),
      "and so is every other record"
    ).toBeNull();

    flushSync(() => root.unmount());
    host.remove();
  });

  it("spares the theme snapshot and sweeps everything else", () => {
    const all = [
      SESSION_SCOPE,
      THEME_SCOPE,
      "browser-history",
      "files:11111111-1111-4111-8111-111111111111",
    ];
    // theme.json is not a record of a session; it is the copy the Rust side
    // reads before the webview exists, so that the first frame is the
    // colour the configuration file asks for.
    expect(forgetSessionScopes(all)).toEqual([
      SESSION_SCOPE,
      "browser-history",
      "files:11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("writes none of the six into the session snapshot any more", () => {
    useStore.setState({
      ...configSlice(FROM_THE_FILE),
      tabs: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "terminal",
          title: "Terminal 1",
          groupId: null,
        },
      ],
    });
    const text = JSON.stringify(sessionSnapshot(useStore.getState()));
    for (const field of [
      "sidebarWidth",
      "sidebarPinned",
      "archiveThreshold",
      "searchEngine",
      "customSearchTemplate",
      "themePreference",
    ]) {
      expect(text, `${field} is still written with the session`).not.toContain(
        field
      );
    }
  });
});

describe("the sidebar's drag bounds come from the registry too", () => {
  it("clamps to the schema's numbers, whatever they are", async () => {
    serve(snapshot());
    schemaRows = widthBetween(200, 400);
    await useStore.getState().initConfig();
    expect(useStore.getState().sidebarWidthRange).toEqual({
      min: 200,
      max: 400,
    });

    useStore.getState().setSidebarWidth(10);
    expect(useStore.getState().sidebarWidth, "below the floor").toBe(200);
    useStore.getState().setSidebarWidth(9000);
    expect(useStore.getState().sidebarWidth, "above the ceiling").toBe(400);
    useStore.getState().setSidebarWidth(301);
    expect(useStore.getState().sidebarWidth, "inside").toBe(301);
  });

  it("follows the schema when the schema moves", async () => {
    // The discriminating half: a clamp written into this file as 180 and 520
    // would pass the test above and fail here, which is the whole reason the
    // bounds are read rather than remembered.
    serve(snapshot());
    schemaRows = widthBetween(60, 90);
    await useStore.getState().initConfig();
    useStore.getState().setSidebarWidth(10);
    expect(useStore.getState().sidebarWidth).toBe(60);
    useStore.getState().setSidebarWidth(1000);
    expect(useStore.getState().sidebarWidth).toBe(90);
  });

  it("clamps to nothing while the schema has not arrived", async () => {
    serve(snapshot());
    schemaRows = [];
    await useStore.getState().initConfig();
    expect(useStore.getState().sidebarWidthRange).toBeNull();
    // Not clamped to remembered bounds — the file's own rule rejects an
    // impossible width on the way in, and that rule lives in one place.
    useStore.getState().setSidebarWidth(9000);
    expect(useStore.getState().sidebarWidth).toBe(9000);
  });

  it("reads a bound only from a row that has one", () => {
    const rows: Setting[] = [
      ...widthBetween(180, 520),
      {
        key: CONFIG_KEYS.theme,
        kind: { choice: { options: ["system"] } },
        section: "appearance",
        str_key: "settings.appearance.theme",
        default: "system",
      },
      {
        key: CONFIG_KEYS.sidebarPinned,
        kind: "toggle",
        section: "appearance",
        str_key: "settings.appearance.sidebarPinned",
        default: false,
      },
    ];
    expect(numberRange(rows, CONFIG_KEYS.sidebarWidth)).toEqual({
      min: 180,
      max: 520,
    });
    expect(numberRange(rows, CONFIG_KEYS.theme)).toBeNull();
    expect(numberRange(rows, CONFIG_KEYS.sidebarPinned)).toBeNull();
    expect(numberRange(rows, "nothing.at.all")).toBeNull();
  });
});

describe("a change goes to the file", () => {
  it("sends each setter's value under the key the file spells it with", async () => {
    serve(snapshot());
    await useStore.getState().initConfig();
    mocks.invoke.mockClear();

    useStore.getState().setThemePreference("dark");
    useStore.getState().setArchiveThreshold("off");
    useStore.getState().setSearchEngine("custom", "https://mine.test/?q=%s");
    useStore.getState().setSidebarWidth(300);
    useStore.getState().toggleSidebar();
    await flushConfigWrites();

    expect(new Map(writes())).toEqual(
      new Map<string, unknown>([
        [CONFIG_KEYS.theme, "dark"],
        [CONFIG_KEYS.archiveAfter, "off"],
        [CONFIG_KEYS.searchEngine, "custom"],
        [CONFIG_KEYS.customSearchTemplate, "https://mine.test/?q=%s"],
        [CONFIG_KEYS.sidebarWidth, 300],
        [CONFIG_KEYS.sidebarPinned, true],
      ])
    );
  });

  it("costs one write per key however many times it is dragged", async () => {
    serve(snapshot());
    await useStore.getState().initConfig();
    mocks.invoke.mockClear();

    // One gesture on the sidebar's edge, forty pointer moves.
    for (let px = 200; px < 240; px++) useStore.getState().setSidebarWidth(px);
    await flushConfigWrites();

    expect(writes()).toEqual([[CONFIG_KEYS.sidebarWidth, 239]]);
    expect(useStore.getState().sidebarWidth).toBe(239);
  });

  it("still refreshes the theme snapshot the first frame is painted from", async () => {
    serve(snapshot());
    await useStore.getState().initConfig();
    mocks.invoke.mockClear();
    useStore.getState().setThemePreference("dark");
    await flushConfigWrites();
    await settle();
    expect(mocks.invoke).toHaveBeenCalledWith("theme_pref_save", {
      pref: "dark",
    });
  });
});

describe("a file that could not be read", () => {
  /** What config_get rejects with: the located error, whole. */
  const LOCATED =
    "/home/u/.config/tabverse/config.toml:3:17: sidebar_width must be " +
    "between 180 and 520 — 999 is not\n" +
    "  |\n3 | sidebar_width = 999\n  |                 ^^^\n";

  it("keeps the whole report, and names the file to open", async () => {
    serve(new Error(LOCATED));
    await useStore.getState().initConfig();
    const s = useStore.getState();
    expect(s.configError).toBe(LOCATED);
    expect(s.configPath).toBe("/home/u/.config/tabverse/config.toml");
    // A failed load carries no values, so the interface is on values the
    // user did not choose — which is exactly why the banner is permanent.
    expect(s.configWarnings).toEqual([]);
  });

  it("clears the error once the file loads again", async () => {
    serve(new Error(LOCATED));
    await useStore.getState().initConfig();
    expect(useStore.getState().configError).not.toBeNull();
    serve(snapshot());
    await useStore.getState().initConfig();
    expect(useStore.getState().configError).toBeNull();
  });

  it("reads the path back out of a located error, drive letters included", () => {
    expect(configErrorPath(LOCATED)).toBe(
      "/home/u/.config/tabverse/config.toml"
    );
    // The greedy split is what makes this work: the last `:line:column: `
    // wins, not the colon after the drive letter.
    expect(
      configErrorPath("C:\\Users\\u\\AppData\\Tabverse\\config.toml:12:3: bad")
    ).toBe("C:\\Users\\u\\AppData\\Tabverse\\config.toml");
    // The unlocated form — a file that could not be read at all.
    expect(configErrorPath("/etc/tabverse.toml: cannot read this file")).toBe(
      "/etc/tabverse.toml"
    );
    expect(configErrorPath("something went wrong")).toBeNull();
  });
});

describe("keys the file names that we do not know", () => {
  const WARNINGS = [
    {
      key: "appearance.sidebar_wdith",
      path: "/home/u/.config/tabverse/config.toml",
      line: 4,
      column: 1,
    },
    {
      key: "nonsense",
      path: "/home/u/.config/tabverse/config.toml",
      line: 12,
      column: 1,
    },
  ];

  it("keeps every one of them, with its line, and loads the rest", async () => {
    serve(snapshot({ warnings: WARNINGS }));
    await useStore.getState().initConfig();
    const s = useStore.getState();
    expect(s.configWarnings).toEqual(WARNINGS);
    expect(s.configError, "a warning never stops the load").toBeNull();
    expect(s.sidebarWidth, "the rest of the file still applied").toBe(317);
  });

  it("can be closed, and comes back on the next start", async () => {
    serve(snapshot({ warnings: WARNINGS }));
    await useStore.getState().initConfig();
    useStore.getState().dismissConfigWarnings();
    expect(useStore.getState().configWarningsDismissed).toBe(true);
    await useStore.getState().initConfig();
    expect(useStore.getState().configWarningsDismissed).toBe(false);
  });
});
