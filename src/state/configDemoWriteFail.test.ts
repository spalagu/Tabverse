import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

// The settings page asks the core a few things of its own (health, trusted
// hosts, default apps). None of them is what this file is about, and none of
// them may take the page down when there is no core; mocked so they answer
// nothing. The *configuration* calls do not come through here at all —
// `__TAURI_INTERNALS__` is deliberately absent, which is what puts config.ts
// on its demo path.
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { flushAll } from "../persist";
import {
  BOOT_CONFIG_KEY,
  CONFIG_KEYS,
  CONFIG_NOT_READ,
  DEMO_SCHEMA_KEY,
  DEMO_WRITE_FAILS_KEY,
  configGet,
  configReset,
  configSet,
  flushConfigWrites,
  type ConfigValues,
  type Setting,
} from "./config";
import { useStore, type ArchiveThreshold } from "./store";
import { STR } from "../strings";
import { SettingsView } from "../components/SettingsView";

const REPO = process.cwd();
const GATE = resolve(REPO, "tools", "config-registry-extractor.py");

interface Payload {
  values: ConfigValues;
  schema: Setting[];
}

/** The registry, through the extractor the dev-server plugin runs. */
function derive(): Payload {
  const out = execFileSync("python3", [GATE, "--emit-json", "-"], {
    cwd: REPO,
    encoding: "utf8",
  });
  return JSON.parse(out) as Payload;
}

const w = () => window as unknown as Record<string, unknown>;

/** The demo's own edit store, which is also what `sources` reports. */
const DEMO_EDITS_KEY = "tabverse.demo.config";

/** Turn the switch over, exactly as a console would. */
function setWriteFails(on: boolean): void {
  w()[DEMO_WRITE_FAILS_KEY] = on;
}

/** The failed-save banner, or null. */
function failureBanner(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".settings-write-failures");
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

const mounted: Array<() => void> = [];

/** The settings page, mounted for real, with its async work finished. */
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

/** What the demo has stored for `key`, or undefined. */
function stored(key: string): unknown {
  const raw = localStorage.getItem(DEMO_EDITS_KEY);
  if (raw === null) return undefined;
  return (JSON.parse(raw) as Record<string, unknown>)[key];
}

const archiveNow = () => useStore.getState().archiveThreshold;

beforeEach(async () => {
  await flushAll();
  await flushConfigWrites();
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async () => undefined);
  // No desktop core: this is what selects the demo backend, exactly as
  // persist.ts selects its localStorage carrier.
  delete w().__TAURI_INTERNALS__;
  const payload = derive();
  w()[BOOT_CONFIG_KEY] = payload.values;
  w()[DEMO_SCHEMA_KEY] = payload.schema;
  setWriteFails(false);
  // An edit store that already exists, so `sources` is non-empty and the
  // one-time migration of the old session-held settings does not run through
  // these tests — it would issue writes of its own and there would be no
  // telling its failures from the one each test makes on purpose.
  localStorage.setItem(DEMO_EDITS_KEY, "{}");
  useStore.setState({
    ...CONFIG_NOT_READ,
    configError: null,
    configWarnings: [],
    configWarningsDismissed: false,
    configWriteErrors: [],
    configPath: null,
    tabs: [],
    activeTabId: null,
  });
  await useStore.getState().initConfig();
});

afterEach(async () => {
  while (mounted.length > 0) mounted.pop()?.();
  setWriteFails(false);
  await flushConfigWrites();
  delete w()[BOOT_CONFIG_KEY];
  delete w()[DEMO_SCHEMA_KEY];
  delete w()[DEMO_WRITE_FAILS_KEY];
  localStorage.clear();
});

/**
 * A value for the auto-archive setting that is not the one in force, taken
 * from the registry's own domain rather than typed in here.
 */
function otherThreshold(): ArchiveThreshold {
  const now = archiveNow();
  const schema = w()[DEMO_SCHEMA_KEY] as Setting[];
  const kind = schema.find((s) => s.key === CONFIG_KEYS.archiveAfter)
    ?.kind as { choice: { options: string[] } };
  const other = kind.choice.options.find((o) => o !== now);
  expect(other, "the setting has a second value to move to").toBeDefined();
  return other as ArchiveThreshold;
}

describe("the demo's write-failure switch", () => {
  it("with the switch off, the change lands and the page says nothing", async () => {
    const next = otherThreshold();
    useStore.getState().setArchiveThreshold(next);
    await flushConfigWrites();
    await settle();

    expect(archiveNow(), "the user's choice stands").toBe(next);
    expect(stored(CONFIG_KEYS.archiveAfter), "and reached the carrier").toBe(
      next
    );
    expect(useStore.getState().configWriteErrors).toEqual([]);
    expect(
      failureBanner(await renderSettings()),
      "no banner while writes work"
    ).toBeNull();
  });

  it("with the switch on, the change is refused and the banner names it", async () => {
    const before = archiveNow();
    const next = otherThreshold();
    setWriteFails(true);

    useStore.getState().setArchiveThreshold(next);
    await flushConfigWrites();
    await settle();

    // The control is back where it was, and nothing was stored: a refused
    // write leaves no trace of itself, here as in the file.
    expect(archiveNow(), "the setting is put back").toBe(before);
    expect(stored(CONFIG_KEYS.archiveAfter)).toBeUndefined();

    const banner = failureBanner(await renderSettings());
    expect(banner, "the failed-save banner").not.toBeNull();
    const rows = Array.from((banner as HTMLElement).querySelectorAll("li"));
    expect(rows.length, "one row per setting that failed").toBe(1);
    expect(
      rows[0].getAttribute("data-setting"),
      "the row is about the setting that was changed"
    ).toBe(CONFIG_KEYS.archiveAfter);
    const text = rows[0].textContent ?? "";
    expect(text, "the setting is named").toContain(
      STR.settings.autoArchive.after
    );
    expect(text, "and the reason says which switch produced it").toContain(
      STR.settings.config.demoWriteRefused
    );
  });

  it("turns back off, and the next change lands with the banner gone", async () => {
    // The half a permanently-failing demo could never show. Without it,
    // "the banner appears when a write fails" is not distinguishable from
    // "the banner is always up".
    setWriteFails(true);
    const first = otherThreshold();
    useStore.getState().setArchiveThreshold(first);
    await flushConfigWrites();
    await settle();
    expect(useStore.getState().configWriteErrors.length).toBe(1);

    setWriteFails(false);
    const second = otherThreshold();
    useStore.getState().setArchiveThreshold(second);
    await flushConfigWrites();
    await settle();

    expect(archiveNow(), "the change now sticks").toBe(second);
    expect(stored(CONFIG_KEYS.archiveAfter)).toBe(second);
    expect(
      useStore.getState().configWriteErrors,
      "a notice must not outlive the condition it reports"
    ).toEqual([]);
    expect(
      failureBanner(await renderSettings()),
      "and the banner is gone from the page"
    ).toBeNull();
  });

  it("refuses a reset too, because a reset is also a write to the file", async () => {
    const next = otherThreshold();
    await configSet(CONFIG_KEYS.archiveAfter, next);
    expect(stored(CONFIG_KEYS.archiveAfter)).toBe(next);

    setWriteFails(true);
    await expect(configReset(CONFIG_KEYS.archiveAfter)).rejects.toBe(
      STR.settings.config.demoWriteRefused
    );
    expect(
      stored(CONFIG_KEYS.archiveAfter),
      "the edit is still there: a refused reset changes nothing"
    ).toBe(next);

    setWriteFails(false);
    await configReset(CONFIG_KEYS.archiveAfter);
    expect(stored(CONFIG_KEYS.archiveAfter)).toBeUndefined();
  });

  it("is off unless it is exactly on, so a typo cannot raise the banner", async () => {
    // `"true"` is what a console typo produces, and a banner that arrived
    // from one would be a banner nobody could explain.
    for (const value of ["true", 1, {}, null, undefined]) {
      w()[DEMO_WRITE_FAILS_KEY] = value;
      await expect(
        configSet(CONFIG_KEYS.archiveAfter, otherThreshold()),
        String(value)
      ).resolves.toBeUndefined();
    }
    const snap = await configGet();
    expect(snap.sources.length, "the carrier is named once it exists").toBe(1);
  });
});
