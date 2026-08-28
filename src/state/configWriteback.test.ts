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
  flushConfigWrites,
  type ConfigSnapshot,
  type ConfigValues,
  type Setting,
} from "./config";
import { useStore, type ArchiveThreshold } from "./store";
import { STR } from "../strings";
import { SettingsView } from "../components/SettingsView";

/**
 * What the file says, as `config_get` answers it.
 *
 * Values nothing in the interface could have supplied, for the usual reason:
 * a setting that reads back as one of these travelled over the command rather
 * than being remembered somewhere in the frontend.
 */
const FROM_THE_FILE: ConfigValues = {
  appearance: { theme: "light", sidebar_width: 317, sidebar_pinned: false },
  browser: {
    search_engine: "bing",
    custom_search_template: "https://from-the-file.test/?q=%s",
    archive_after: "7d",
  },
};

/**
 * The registry, whose defaults are deliberately none of the values above and
 * none of the values these tests change to.
 *
 * That separation is the whole discriminating power of the first test: a
 * rollback that restored the default would land on `BUILT_IN` below, a
 * rollback that restores what the user had lands on the file's value, and no
 * assertion could tell the two apart if the fixture let them coincide.
 */
const SCHEMA: Setting[] = [
  {
    key: CONFIG_KEYS.archiveAfter,
    kind: { choice: { options: ["12h", "24h", "7d", "off"] } },
    section: "auto-archive",
    str_key: "settings.autoArchive.after",
    default: "24h",
  },
  {
    key: CONFIG_KEYS.theme,
    kind: { choice: { options: ["system", "light", "dark"] } },
    section: "appearance",
    str_key: "settings.appearance.theme",
    default: "system",
  },
];

/** The built-in value of the setting these tests move — what a *reset* gives. */
const BUILT_IN = SCHEMA[0].default;
/** What the file holds for it — what putting it *back* gives. */
const IN_THE_FILE = FROM_THE_FILE.browser.archive_after;

/** Two values a chain of changes runs through, neither of them either above. */
const FIRST: ArchiveThreshold = "12h";
const SECOND: ArchiveThreshold = "off";

/** What the core says when it cannot write the file. */
const REFUSAL =
  "/home/u/.config/tabverse/config.toml: permission denied writing this file";

function snapshot(): ConfigSnapshot {
  return {
    values: FROM_THE_FILE,
    warnings: [],
    // Non-empty on purpose: a file that exists is what stops the one-time
    // migration of the old session settings from running through these tests.
    sources: ["/home/u/.config/tabverse/config.toml"],
  };
}

/** How `config_set` answers. Replaced per test. */
let answerSet: (key: string, value: unknown) => Promise<void> = async () => {};

/** Answer every command the store and the settings page ask. */
function serve() {
  mocks.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "config_get") return snapshot();
    if (cmd === "config_schema") return SCHEMA;
    if (cmd === "config_set") {
      return await answerSet(args?.key as string, args?.value);
    }
    if (cmd === "app_health") {
      return { shellIntegration: false, homeDir: "/home/u", version: "0.0.0" };
    }
    if (cmd === "list_trusted_hosts") return [];
    if (cmd === "default_apps_status") return [];
    return undefined;
  });
}

/** Every write refuses, with the message above. */
function refuseWrites() {
  answerSet = async () => {
    throw REFUSAL;
  };
}

/** Every write is accepted. */
function acceptWrites() {
  answerSet = async () => {};
}

/** Every `config_set` issued, in call order. */
function writes(): Array<[string, unknown]> {
  return mocks.invoke.mock.calls
    .filter(([cmd]) => cmd === "config_set")
    .map(([, args]) => [args?.key as string, args?.value]);
}

/**
 * Let the promise chains this code starts finish. Macrotask turns as well as
 * microtask ones: the settings page reaches the core over a dynamic import,
 * which does not resolve on the microtask queue.
 */
async function settle() {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const mounted: Array<() => void> = [];

/** The settings page, mounted for real, with its own async work finished. */
async function renderSettings(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(SettingsView)));
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  await settle();
  flushSync(() => {});
  return host;
}

/** The failed-save banner, or null. */
function failureBanner(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".settings-write-failures");
}

const w = () => window as unknown as Record<string, unknown>;

const archiveNow = () => useStore.getState().archiveThreshold;

beforeEach(async () => {
  await flushAll();
  await flushConfigWrites();
  localStorage.clear();
  mocks.invoke.mockReset();
  acceptWrites();
  w().__TAURI_INTERNALS__ = {};
  useStore.setState({
    ...CONFIG_NOT_READ,
    sidebarWidthRange: null,
    configError: null,
    configWarnings: [],
    configWarningsDismissed: false,
    configWriteErrors: [],
    configPath: null,
    tabs: [],
    activeTabId: null,
  });
});

afterEach(async () => {
  while (mounted.length > 0) mounted.pop()?.();
  acceptWrites();
  await flushConfigWrites();
  delete w().__TAURI_INTERNALS__;
});

/** Load the file, then arrange for every write to be refused. */
async function loadedThenRefusing() {
  serve();
  await useStore.getState().initConfig();
  expect(archiveNow(), "the file's value is what the store starts on").toBe(
    IN_THE_FILE
  );
  mocks.invoke.mockClear();
  refuseWrites();
}

describe("a setting the file would not take", () => {
  it("puts it back to the value it had, not to its built-in value", async () => {
    await loadedThenRefusing();

    useStore.getState().setArchiveThreshold(SECOND);
    expect(archiveNow(), "the change shows at once, before the write").toBe(
      SECOND
    );

    await flushConfigWrites();
    await settle();

    // The one assertion this whole file exists for.
    expect(
      archiveNow(),
      "a refused write puts the setting back where it was"
    ).toBe(IN_THE_FILE);
    // Named separately so a rollback that resets instead of restoring fails
    // with the reason rather than with a bare inequality.
    expect(
      archiveNow(),
      "putting a setting back is not resetting it to the built-in value"
    ).not.toBe(BUILT_IN);
  });

  it("says which setting did not save, and why", async () => {
    await loadedThenRefusing();

    useStore.getState().setArchiveThreshold(SECOND);
    await flushConfigWrites();
    await settle();

    const banner = failureBanner(await renderSettings());
    expect(banner, "the failed-save banner").not.toBeNull();

    const rows = Array.from(banner!.querySelectorAll("li"));
    expect(rows.length, "one row per setting that failed").toBe(1);
    expect(
      rows[0].getAttribute("data-setting"),
      "the row is about the setting that was changed"
    ).toBe(CONFIG_KEYS.archiveAfter);

    const text = rows[0].textContent ?? "";
    // "Something could not be saved" is not something anyone can act on: the
    // row has to name the setting in the words the page calls it by.
    expect(text, "the setting is named").toContain(
      STR.settings.autoArchive.after
    );
    expect(text, "and the core's reason is carried through").toContain(
      REFUSAL
    );
    expect(banner!.textContent).toContain(
      STR.settings.config.writeFailedHeading
    );
  });

  it("stays on the page: a failed save is not a notice that fades", async () => {
    await loadedThenRefusing();
    useStore.getState().setArchiveThreshold(SECOND);
    await flushConfigWrites();
    await settle();

    const banner = failureBanner(await renderSettings());
    // Announced rather than merely drawn, and still there after any timer a
    // transient notice would have run on.
    expect(banner!.getAttribute("role")).toBe("alert");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    expect(
      failureBanner(await renderSettings()),
      "still on the page later"
    ).not.toBeNull();
  });

  it("keeps one row per setting however often that setting fails", async () => {
    await loadedThenRefusing();
    for (const value of [SECOND, FIRST, SECOND]) {
      useStore.getState().setArchiveThreshold(value);
      await flushConfigWrites();
      await settle();
    }
    expect(useStore.getState().configWriteErrors.map((e) => e.key)).toEqual([
      CONFIG_KEYS.archiveAfter,
    ]);
  });
});

describe("a write that succeeds", () => {
  it("leaves the setting alone and says nothing", async () => {
    serve();
    await useStore.getState().initConfig();
    mocks.invoke.mockClear();
    acceptWrites();

    useStore.getState().setArchiveThreshold(SECOND);
    await flushConfigWrites();
    await settle();

    expect(archiveNow(), "the user's choice stands").toBe(SECOND);
    expect(
      useStore.getState().configWriteErrors,
      "nothing to report"
    ).toEqual([]);
    expect(
      failureBanner(await renderSettings()),
      "and no banner on the page"
    ).toBeNull();
  });

  it("retires the notice the same setting left behind when it failed", async () => {
    await loadedThenRefusing();
    useStore.getState().setArchiveThreshold(SECOND);
    await flushConfigWrites();
    await settle();
    expect(useStore.getState().configWriteErrors.length).toBe(1);

    acceptWrites();
    useStore.getState().setArchiveThreshold(FIRST);
    await flushConfigWrites();
    await settle();

    expect(archiveNow()).toBe(FIRST);
    expect(
      useStore.getState().configWriteErrors,
      "a notice must not outlive the condition it reports"
    ).toEqual([]);
  });
});

describe("the debounce window", () => {
  it("rolls a whole run of changes back to where the run started", async () => {
    await loadedThenRefusing();

    // Three changes inside one 300ms window — the shape of a drag, or of
    // somebody trying options in a dropdown. They collapse into one write.
    useStore.getState().setArchiveThreshold(FIRST);
    useStore.getState().setArchiveThreshold(SECOND);
    useStore.getState().setArchiveThreshold(FIRST);
    await flushConfigWrites();
    await settle();

    expect(writes(), "one write, carrying the last value").toEqual([
      [CONFIG_KEYS.archiveAfter, FIRST],
    ]);
    // Not SECOND, and not FIRST: the value to go back to is the one from
    // before the run, not one from the middle of it.
    expect(
      archiveNow(),
      "back to where the run of changes started"
    ).toBe(IN_THE_FILE);
  });

  it("leaves a change made while the call was out alone", async () => {
    await loadedThenRefusing();

    // A write that has gone out and not yet come back.
    let refuse!: (e: unknown) => void;
    answerSet = () =>
      new Promise<void>((_, reject) => {
        refuse = reject;
      });
    useStore.getState().setArchiveThreshold(SECOND);
    const inFlight = flushConfigWrites();
    await settle();

    // The user changes their mind while it is in flight. This is a change
    // nothing has tried to write yet.
    useStore.getState().setArchiveThreshold(FIRST);

    refuse(REFUSAL);
    await inFlight;
    await settle();

    expect(
      archiveNow(),
      "the newer choice owns the setting; the old failure must not eat it"
    ).toBe(FIRST);
  });
});
