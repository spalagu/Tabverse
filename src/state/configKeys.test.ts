import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  clearKeyBinding,
  clearKeyOverrides,
  configGet,
  keyConfigKey,
  setKeyBinding,
  type ConfigSnapshot,
} from "./config";
import {
  SHORTCUTS,
  keyOverlay,
  keysShownFor,
  setKeyOverrides,
} from "../shortcuts";

/**
 * A command the shipped table really has, read off the table itself — a
 * command named by hand here would go on passing after it was renamed.
 */
const ROW = SHORTCUTS[0];
const COMMAND = String(ROW.command);
/** What that command answers before anybody changes anything. */
const SHIPPED = ROW.keys as string;

/** Every call that went out, in order. */
function calls(): Array<[string, Record<string, unknown> | undefined]> {
  return mocks.invoke.mock.calls.map(([cmd, args]) => [cmd, args]);
}

/** The calls that were not the fire-and-forget notice to the core. */
function writes(): Array<[string, Record<string, unknown> | undefined]> {
  return calls().filter(([cmd]) => cmd !== "keys_apply");
}

const w = () => window as unknown as Record<string, unknown>;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  setKeyOverrides({});
  localStorage.clear();
  w().__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  setKeyOverrides({});
  delete w().__TAURI_INTERNALS__;
});

describe("a rebinding reaches the file", () => {
  it("writes the override and puts it in force at once", async () => {
    await setKeyBinding(COMMAND, "⌃⌥J");

    expect(writes()).toEqual([
      ["config_key_set", { command: COMMAND, keys: "⌃⌥J" }],
    ]);
    // In force in the same breath, or a saved key would answer nothing
    // until the next launch.
    expect(keyOverlay()[COMMAND]).toBe("⌃⌥J");
    expect(keysShownFor(ROW.command)).toBe("⌃⌥J");
  });

  it("tells the core, whose menu is built in the other language", async () => {
    await setKeyBinding(COMMAND, "⌃⌥J");
    const notice = calls().find(([cmd]) => cmd === "keys_apply");
    expect(notice, "the core is told what is in force now").toBeDefined();
    expect(notice?.[1]).toEqual({ overrides: { [COMMAND]: "⌃⌥J" } });
  });

  it("leaves the keyboard as it was when the file refuses", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "config_key_set") throw "permission denied";
      return undefined;
    });

    await expect(setKeyBinding(COMMAND, "⌃⌥J")).rejects.toBeTruthy();

    // The whole of the point: a key that could not be recorded must not be
    // answering, or the app would obey a binding no restart would remember
    // and nothing on screen would say why it went away.
    expect(keyOverlay()[COMMAND]).toBeUndefined();
    expect(keysShownFor(ROW.command)).toBe(SHIPPED);
  });
});

describe("the empty string is an unbinding", () => {
  it("writes it as a value, and the command then answers nothing", async () => {
    await setKeyBinding(COMMAND, null);

    expect(writes()).toEqual([
      ["config_key_set", { command: COMMAND, keys: "" }],
    ]);
    // Present in the overlay — "this command answers no key" is something
    // the file says, not something it omits.
    expect(keyOverlay()[COMMAND]).toBe("");
    expect(keysShownFor(ROW.command)).toBe("");
  });
});

describe("going back to the shipped key", () => {
  it("deletes the line instead of writing the shipped key into it", async () => {
    await setKeyBinding(COMMAND, "⌃⌥J");
    mocks.invoke.mockClear();

    await clearKeyBinding(COMMAND);

    expect(writes()).toEqual([["config_key_reset", { command: COMMAND }]]);
    expect(
      writes().some(([cmd]) => cmd === "config_key_set"),
      "a reset must never be a write of the shipped key"
    ).toBe(false);
    expect(keyOverlay()[COMMAND]).toBeUndefined();
    expect(keysShownFor(ROW.command)).toBe(SHIPPED);
  });

  it("drops every override at once for a factory reset", async () => {
    await setKeyBinding(COMMAND, "⌃⌥J");
    mocks.invoke.mockClear();

    await clearKeyOverrides();

    expect(writes()).toEqual([["config_keys_clear", undefined]]);
    expect(keyOverlay()).toEqual({});
    expect(keysShownFor(ROW.command)).toBe(SHIPPED);
  });
});

describe("a hand-edited file is in force after a reload", () => {
  it("takes the overlay from what config_get answers, not from memory", async () => {
    // Somebody typed this into their own `[keys]` section and asked for a
    // reload. Nothing in this process put it there.
    const snap: ConfigSnapshot = {
      values: {
        appearance: { theme: "system", sidebar_width: 248, sidebar_pinned: true },
        browser: {
          search_engine: "duckduckgo",
          custom_search_template: "",
          archive_after: "24h",
        },
        keys: { [COMMAND]: "⌃⌥H" },
      },
      warnings: [],
      sources: ["/home/u/.config/tabverse/config.toml"],
    };
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "config_get") return snap;
      return undefined;
    });

    await configGet();

    expect(keyOverlay()).toEqual({ [COMMAND]: "⌃⌥H" });
    expect(keysShownFor(ROW.command)).toBe("⌃⌥H");
    // And the core is told, because a reload is exactly when its menu and
    // the script it injects have gone stale.
    expect(calls()).toContainEqual([
      "keys_apply",
      { overrides: { [COMMAND]: "⌃⌥H" } },
    ]);
  });
});

describe("the browser demo, which has no file", () => {
  it("keeps the overlay in its own carrier and reads it back", async () => {
    delete w().__TAURI_INTERNALS__;
    // What the dev server injects: the registry's values and its rows.
    w().__TABVERSE_BOOT_CONFIG__ = {
      appearance: { theme: "system", sidebar_width: 248, sidebar_pinned: true },
      browser: {
        search_engine: "duckduckgo",
        custom_search_template: "",
        archive_after: "24h",
      },
      keys: {},
    };
    w().__TABVERSE_DEMO_CONFIG_SCHEMA__ = [
      {
        key: "appearance.theme",
        kind: { choice: { options: ["system"] } },
        section: "appearance",
        str_key: "settings.appearance.theme",
        default: "system",
      },
    ];

    await setKeyBinding(COMMAND, "⌃⌥K");
    expect(mocks.invoke).not.toHaveBeenCalled();

    setKeyOverrides({});
    const snap = await configGet();
    expect(snap.values.keys).toEqual({ [COMMAND]: "⌃⌥K" });
    expect(keyOverlay()).toEqual({ [COMMAND]: "⌃⌥K" });

    delete w().__TABVERSE_BOOT_CONFIG__;
    delete w().__TABVERSE_DEMO_CONFIG_SCHEMA__;
  });
});

describe("naming a key override outside this module", () => {
  it("spells it the way the file does", () => {
    // The failed-save banner shows this, and it is what somebody opening
    // their configuration file would search for.
    expect(keyConfigKey(COMMAND)).toBe(`keys.${COMMAND}`);
  });
});
