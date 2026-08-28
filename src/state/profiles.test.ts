import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  BOOT_CONFIG_KEY,
  DEMO_SCHEMA_KEY,
  PROFILES_KEY,
  configGet,
  profileRemove,
  profileSet,
  profiles,
  upsertProfile,
  type ConfigProfile,
  type ConfigValues,
} from "./config";

const w = () => window as unknown as Record<string, unknown>;

/** A configuration as the core injects one, carrying two profiles. */
const WITH_PROFILES: ConfigValues = {
  appearance: { theme: "light", sidebar_width: 317, sidebar_pinned: false },
  browser: {
    search_engine: "bing",
    custom_search_template: "",
    archive_after: "7d",
  },
  terminal: {
    profiles: [
      {
        name: "deploy",
        shell: "/bin/bash",
        cwd: "/srv",
        env: { AWS_PROFILE: "prod" },
        badge: "amber",
      },
      { name: "local" },
    ],
  },
};

/** One row, so the demo has a schema to consider itself configured by. */
const SCHEMA = [
  {
    key: "appearance.sidebar_width",
    kind: { number: { min: 180, max: 520 } },
    section: "appearance",
    str_key: "settings.appearance.sidebarWidth",
    default: 301,
  },
];

/** Every call of `cmd`, with its arguments, in call order. */
function calls(cmd: string): Array<Record<string, unknown> | undefined> {
  return mocks.invoke.mock.calls
    .filter(([name]) => name === cmd)
    .map(([, args]) => args);
}

beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async () => undefined);
  delete w()[BOOT_CONFIG_KEY];
  delete w()[DEMO_SCHEMA_KEY];
  w().__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete w().__TAURI_INTERNALS__;
  delete w()[BOOT_CONFIG_KEY];
  delete w()[DEMO_SCHEMA_KEY];
  localStorage.clear();
});

describe("reading the list", () => {
  it("takes the profiles a configuration carries", () => {
    const list = profiles(WITH_PROFILES);
    expect(list.map((p) => p.name)).toEqual(["deploy", "local"]);
    expect(list[0].env).toEqual({ AWS_PROFILE: "prod" });
  });

  it("answers empty for every shape of nothing, and never null", () => {
    // No configuration at all, no `[terminal]` section, and a section with no
    // entries are one state — a user who has declared no profiles has
    // declared none, which is a complete fact rather than a value not read.
    expect(profiles(null)).toEqual([]);
    expect(profiles({ ...WITH_PROFILES, terminal: undefined })).toEqual([]);
    expect(profiles({ ...WITH_PROFILES, terminal: {} })).toEqual([]);
  });
});

describe("upserting a profile", () => {
  const deploy: ConfigProfile = { name: "deploy", shell: "/bin/bash" };
  const local: ConfigProfile = { name: "local" };

  it("writes over the entry it was told to, leaving the others alone", () => {
    const next = upsertProfile([deploy, local], "deploy", {
      name: "deploy",
      shell: "/bin/zsh",
    });
    expect(next).toEqual([{ name: "deploy", shell: "/bin/zsh" }, local]);
  });

  it("renames in place rather than moving the entry to the end", () => {
    const next = upsertProfile([deploy, local], "deploy", { name: "release" });
    expect(next.map((p) => p.name)).toEqual(["release", "local"]);
  });

  it("appends when the target names no entry", () => {
    const next = upsertProfile([deploy], "brand-new", { name: "brand-new" });
    expect(next.map((p) => p.name)).toEqual(["deploy", "brand-new"]);
  });

  it("refuses a blank name and a name another entry already has", () => {
    expect(() => upsertProfile([deploy], "deploy", { name: "  " })).toThrow();
    // Renaming `local` onto `deploy` is the one route to two entries with one
    // name, and it is the route the core refuses by re-parsing the file.
    expect(() =>
      upsertProfile([deploy, local], "local", { name: "deploy" })
    ).toThrow();
    // Keeping your own name is not a collision with yourself.
    expect(() =>
      upsertProfile([deploy, local], "deploy", { name: "deploy", cwd: "/srv" })
    ).not.toThrow();
  });
});

describe("on the desktop", () => {
  it("sends the entry to edit and the entry to write", async () => {
    await profileSet("deploy", { name: "release", shell: "/bin/bash" });
    expect(calls("config_profile_set")).toEqual([
      { target: "deploy", profile: { name: "release", shell: "/bin/bash" } },
    ]);
  });

  it("sends a removal by name", async () => {
    await profileRemove("deploy");
    expect(calls("config_profile_remove")).toEqual([{ name: "deploy" }]);
  });

  it("never routes a profile through config_set", async () => {
    // `config_set` writes registry keys and the core refuses anything else,
    // so a profile sent that way would fail on the far side rather than here.
    await profileSet("deploy", { name: "deploy" });
    await profileRemove("deploy");
    expect(calls("config_set")).toEqual([]);
    expect(calls("config_reset")).toEqual([]);
  });
});

describe("in the browser demo", () => {
  beforeEach(() => {
    delete w().__TAURI_INTERNALS__;
    w()[BOOT_CONFIG_KEY] = WITH_PROFILES;
    w()[DEMO_SCHEMA_KEY] = SCHEMA;
  });

  it("keeps an edit and hands it back on the next read", async () => {
    await profileSet("deploy", { name: "deploy", shell: "/bin/zsh" });
    const snap = await configGet();
    const list = profiles(snap.values);
    expect(list.map((p) => p.name)).toEqual(["deploy", "local"]);
    expect(list[0].shell).toBe("/bin/zsh");
    // Stored under its own name, beside the settings edits rather than
    // inside one of them.
    const stored = JSON.parse(localStorage.getItem("tabverse.demo.config") ?? "{}");
    expect(stored[PROFILES_KEY]).toHaveLength(2);
  });

  it("creates and deletes without a core", async () => {
    await profileSet("scratch", { name: "scratch", cwd: "/tmp" });
    expect(profiles((await configGet()).values).map((p) => p.name)).toEqual([
      "deploy",
      "local",
      "scratch",
    ]);
    await profileRemove("deploy");
    expect(profiles((await configGet()).values).map((p) => p.name)).toEqual([
      "local",
      "scratch",
    ]);
  });

  it("refuses a rename onto another entry's name, and stores nothing", async () => {
    await expect(profileSet("local", { name: "deploy" })).rejects.toBeDefined();
    expect(localStorage.getItem("tabverse.demo.config")).toBeNull();
  });
});
