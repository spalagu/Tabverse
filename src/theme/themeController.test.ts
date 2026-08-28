import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  logs: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../errlog", () => ({
  coreLog: (level: string, msg: string) => {
    mocks.logs.push(`${level}: ${msg}`);
  },
  installErrorReporting: () => {},
}));

import { flushAll } from "../persist";
import { markFreshRun, useStore } from "../state/store";
import {
  applyResolvedTheme,
  bootstrapTheme,
  initTheme,
  resetThemeControllerForTest,
} from "./themeController";
import tokens from "@tabverse/workbench/theme/tokens.json";
import {
  BUILTIN_THEMES,
  terminalTheme,
  themeColors,
  themeIds,
  editorThemeName,
} from "./tokens";

// Captured before any test touches the store: the store's own initial value.
/** What the store holds before anything has been read into it. */
const PREF_AT_BIRTH = useStore.getState().themePreference;

/** An id tokens.json does not declare, in a form no theme would ever use. */
const NO_SUCH_THEME = "no-such-theme-here";

/** The first theme that is NOT one of the built-in two — read off
 *  tokens.json rather than named, so these tests stay about "a theme beyond
 *  the two" rather than about whichever theme happens to be third. */
const EXTRA_THEME =
  themeIds().find((t) => !(BUILTIN_THEMES as readonly string[]).includes(t)) ?? "";

/** The browser-demo carrier key for the theme scope (persist.ts). */
const CARRIER_KEY = "tabverse.state.theme";

/** A controllable stand-in for matchMedia("(prefers-color-scheme: dark)"). */
function stubMatchMedia(matches: boolean) {
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const mql = {
    matches,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
      listeners.push(fn);
    },
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = () => mql;
  return {
    fire(dark: boolean) {
      mql.matches = dark;
      for (const fn of listeners) fn({ matches: dark });
    },
  };
}

const markerWindow = window as unknown as Record<string, unknown>;

function setThemeCalls(): Array<Record<string, unknown> | undefined> {
  return mocks.invoke.mock.calls
    .filter(([cmd]) => cmd === "set_theme")
    .map(([, args]) => args);
}

beforeEach(async () => {
  await flushAll();
  localStorage.clear();
  delete markerWindow.__TAURI_INTERNALS__;
  delete markerWindow.__TABVERSE_BOOT_THEME__;
  resetThemeControllerForTest();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (cmd) =>
    cmd === "theme_pref_load" ? "system" : undefined
  );
  mocks.logs.length = 0;
  stubMatchMedia(true);
  useStore.setState({
    themePreference: "system",
    systemDark: true,
    resolvedTheme: "dark",
  });
  document.documentElement.dataset.theme = "dark";
});

afterEach(() => {
  vi.useRealTimers();
});

it("holds no theme preference until one is read", () => {
  // The inverse of what this asserted. The store used to start on "system",
  // which was one of the six copies of that default the survey found — and
  // the one nothing would have updated when the registry's default changed.
  // It starts on nothing now: bootstrapTheme puts the cold-start snapshot
  // there before the first paint, and the configuration file corrects it.
  expect(PREF_AT_BIRTH).toBeNull();
});

it("resolves an unread preference to a real one at boot, once", async () => {
  // Null must not reach the applier: something has to decide what an absent
  // preference means, and asThemePreference is the one place that does.
  useStore.setState({ themePreference: null });
  await initTheme();
  expect(useStore.getState().themePreference).not.toBeNull();
});

describe("applyResolvedTheme ①/② discipline", () => {
  it("demo: CSS and data-theme land synchronously, and no IPC leaves", () => {
    void applyResolvedTheme("light");
    // Asserted before any await: step ② is synchronous by contract.
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(
      document.documentElement.style.getPropertyValue("--bg")
    ).toBe(tokens.themes.light.color.bg);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("desktop: ① is issued first, ② follows in the same tick", async () => {
    markerWindow.__TAURI_INTERNALS__ = {};
    await initTheme();
    let themeWhenInvoked: string | undefined;
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "set_theme") {
        themeWhenInvoked = document.documentElement.dataset.theme;
      }
      return undefined;
    });
    mocks.invoke.mockClear();
    const done = applyResolvedTheme("light");
    // Same synchronous tick: the IPC has left AND the CSS is already new.
    expect(setThemeCalls()).toEqual([{ theme: "light" }]);
    expect(document.documentElement.dataset.theme).toBe("light");
    // Order within the tick: at the moment ① fired, ② had not run yet.
    expect(themeWhenInvoked).toBe("dark");
    await done;
  });

  it("is idempotent: applying the applied theme costs nothing", async () => {
    markerWindow.__TAURI_INTERNALS__ = {};
    await initTheme();
    mocks.invoke.mockClear();
    await applyResolvedTheme("light");
    await applyResolvedTheme("light");
    expect(setThemeCalls()).toHaveLength(1);
  });

 it("an IPC that does not come back is logged by a timer, not rAF", async () => {
    markerWindow.__TAURI_INTERNALS__ = {};
    await initTheme();
    let releaseIpc: (v?: unknown) => void = () => {};
    mocks.invoke.mockImplementation((cmd) =>
      cmd === "set_theme"
        ? new Promise((res) => {
            releaseIpc = res;
          })
        : Promise.resolve(undefined)
    );
    vi.useFakeTimers();
    const done = applyResolvedTheme("light");
    expect(mocks.logs.filter((l) => l.includes("set_theme"))).toHaveLength(0);
    vi.advanceTimersByTime(150);
    const warned = mocks.logs.filter(
      (l) => l.startsWith("warn") && l.includes("set_theme(light)")
    );
    expect(warned).toHaveLength(1);
    // The CSS was never held hostage to the hung IPC.
    expect(document.documentElement.dataset.theme).toBe("light");
    vi.useRealTimers();
    releaseIpc();
    await done;
  });

  it("a failed set_theme costs a log line, never the CSS", async () => {
    markerWindow.__TAURI_INTERNALS__ = {};
    await initTheme();
    mocks.invoke.mockImplementation((cmd) =>
      cmd === "set_theme"
        ? Promise.reject(new Error("no window"))
        : Promise.resolve(undefined)
    );
    await applyResolvedTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(
      mocks.logs.some((l) => l.startsWith("error") && l.includes("set_theme(light)"))
    ).toBe(true);
  });
});

describe("initTheme hydration and the OS listener", () => {
  it("desktop: theme_pref_load hydrates the store and applies the theme", async () => {
    markerWindow.__TAURI_INTERNALS__ = {};
    mocks.invoke.mockImplementation(async (cmd) =>
      cmd === "theme_pref_load" ? "light" : undefined
    );
    await initTheme();
    const s = useStore.getState();
    expect(s.themePreference).toBe("light");
    expect(s.resolvedTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(setThemeCalls()).toEqual([{ theme: "light" }]);
  });

  it("follows the OS while the preference is system, and only then", async () => {
    const media = stubMatchMedia(false);
    await initTheme();
    expect(useStore.getState().resolvedTheme).toBe("light");
    media.fire(true);
    expect(useStore.getState().resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    // An explicit preference parks the listener: resolve ignores systemDark.
    useStore.getState().setThemePreference("light");
    expect(useStore.getState().resolvedTheme).toBe("light");
    media.fire(false);
    media.fire(true);
    expect(useStore.getState().resolvedTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    // The snapshot kept following regardless — the field, not the theme.
    expect(useStore.getState().systemDark).toBe(true);
  });

  it("demo: reads the carrier scope back at boot", async () => {
    localStorage.setItem(CARRIER_KEY, JSON.stringify({ preference: "light" }));
    await initTheme();
    expect(useStore.getState().themePreference).toBe("light");
    expect(useStore.getState().resolvedTheme).toBe("light");
  });

  it("demo: an unknown stored value falls back to system", async () => {
    // A theme id tokens.json does not declare. It used to be enough to
    // write "sepia" here; sepia is a real theme now, and the two tests
    // together are the point — a stored id is honoured when the file knows
    // it and refused when it does not, with no list of names in this file.
    localStorage.setItem(CARRIER_KEY, JSON.stringify({ preference: NO_SUCH_THEME }));
    await initTheme();
    expect(useStore.getState().themePreference).toBe("system");
  });

  it("demo: a stored theme beyond the built-in two is honoured", async () => {
    localStorage.setItem(CARRIER_KEY, JSON.stringify({ preference: EXTRA_THEME }));
    await initTheme();
    expect(useStore.getState().themePreference).toBe(EXTRA_THEME);
    expect(useStore.getState().resolvedTheme).toBe(EXTRA_THEME);
    expect(document.documentElement.dataset.theme).toBe(EXTRA_THEME);
  });

  it("settings → store → subscription: a switch flips the CSS in one tick", async () => {
    markerWindow.__TAURI_INTERNALS__ = {};
    await initTheme();
    mocks.invoke.mockClear();
    useStore.getState().setThemePreference("light");
    // No await between the action and the assertion: the store subscription
    // runs synchronously, and ①② inside it are synchronous by contract.
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(setThemeCalls()).toEqual([{ theme: "light" }]);
  });
});

describe("bootstrapTheme and the injected boot marker", () => {
  it("desktop: the injected resolved theme beats matchMedia", () => {
    markerWindow.__TAURI_INTERNALS__ = {};
    markerWindow.__TABVERSE_BOOT_THEME__ = "light";
    stubMatchMedia(true); // the OS says dark; theme.json knew better
    bootstrapTheme();
    expect(useStore.getState().resolvedTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    // The marker answers the resolution, never the OS snapshot: systemDark
    // keeps reporting what matchMedia actually said.
    expect(useStore.getState().systemDark).toBe(true);
  });

  it("an unknown marker value is ignored: matchMedia decides", () => {
    markerWindow.__TAURI_INTERNALS__ = {};
    markerWindow.__TABVERSE_BOOT_THEME__ = NO_SUCH_THEME;
    stubMatchMedia(true);
    bootstrapTheme();
    expect(useStore.getState().resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("a marker naming a theme beyond the built-in two paints it", () => {
    // The pre-paint path is where a theme that is neither light nor dark
    // used to be dropped on the floor; the first frame is the whole reason
    // the marker exists, so it has to carry every id the file declares.
    markerWindow.__TAURI_INTERNALS__ = {};
    markerWindow.__TABVERSE_BOOT_THEME__ = EXTRA_THEME;
    stubMatchMedia(true);
    bootstrapTheme();
    expect(useStore.getState().resolvedTheme).toBe(EXTRA_THEME);
    expect(document.documentElement.dataset.theme).toBe(EXTRA_THEME);
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(
      themeColors(EXTRA_THEME).bg,
    );
  });

  it("the marker outranks the demo carrier — the read order is fixed", () => {
    localStorage.setItem(CARRIER_KEY, JSON.stringify({ preference: "dark" }));
    markerWindow.__TABVERSE_BOOT_THEME__ = "light";
    stubMatchMedia(true);
    bootstrapTheme();
    expect(useStore.getState().resolvedTheme).toBe("light");
    // The preference itself still reads from the carrier: the marker only
    // decides the first frame's resolved theme.
    expect(useStore.getState().themePreference).toBe("dark");
  });
});

describe("③/④ fan-out: consumers subscribe to resolvedTheme", () => {
  it("a fake xterm and a fake Monaco follow every switch", async () => {
    await initTheme();
    const fakeTerm = {
      options: { theme: terminalTheme(useStore.getState().resolvedTheme) },
    };
    const setTheme = vi.fn<(name: string) => void>();
    const unsubTerm = useStore.subscribe((s, prev) => {
      if (s.resolvedTheme !== prev.resolvedTheme) {
        fakeTerm.options.theme = terminalTheme(s.resolvedTheme);
      }
    });
    const unsubMonaco = useStore.subscribe((s, prev) => {
      if (s.resolvedTheme !== prev.resolvedTheme) {
        setTheme(editorThemeName(s.resolvedTheme));
      }
    });
    useStore.getState().setThemePreference("light");
    expect(fakeTerm.options.theme.background).toBe(themeColors("light").termBg);
    expect(setTheme).toHaveBeenLastCalledWith("tabverse-light");
    useStore.getState().setThemePreference("dark");
    expect(fakeTerm.options.theme.background).toBe(themeColors("dark").termBg);
    expect(setTheme).toHaveBeenLastCalledWith("tabverse-dark");
    expect(setTheme).toHaveBeenCalledTimes(2);
    unsubTerm();
    unsubMonaco();
  });
});

describe("preference persistence", () => {
  it("desktop: setThemePreference fires theme_pref_save", async () => {
    markerWindow.__TAURI_INTERNALS__ = {};
    useStore.getState().setThemePreference("light");
    // The import inside persistThemePreference is async; let it land.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const saves = mocks.invoke.mock.calls.filter(
      ([cmd]) => cmd === "theme_pref_save"
    );
    expect(saves).toEqual([["theme_pref_save", { pref: "light" }]]);
  });

  it("demo: the preference lands in the carrier under its own scope", async () => {
    useStore.getState().setThemePreference("dark");
    await flushAll();
    expect(localStorage.getItem(CARRIER_KEY)).toBe(
      JSON.stringify({ preference: "dark" })
    );
  });

  // LAST on purpose: markFreshRun is one-way for this module registry, and
  // every test after it would inherit the fresh-run rule.
  it("fresh run: the switch applies, nothing lands, nothing is read", async () => {
    localStorage.setItem(CARRIER_KEY, JSON.stringify({ preference: "light" }));
    markFreshRun();
    await initTheme();
    // Inherit nothing: the stored preference stays unread.
    expect(useStore.getState().themePreference).toBe("system");
    localStorage.clear();
    useStore.getState().setThemePreference("light");
    expect(useStore.getState().resolvedTheme).toBe("light");
    await flushAll();
    // Write nothing: the carrier stays empty.
    expect(localStorage.getItem(CARRIER_KEY)).toBeNull();
  });
});
