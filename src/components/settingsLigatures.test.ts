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
  CONFIG_NOT_READ,
  TERMINAL_KEYS,
  flushConfigWrites,
  type ConfigValues,
} from "../state/config";
import { useStore } from "../state/store";
import { STR } from "../strings";
import { SettingsView } from "./SettingsView";
import { strAt } from "./settingsSearch";

/**
 * The key this page writes the switch to.
 *
 * Spelled here rather than imported, on purpose: this is the assertion that
 * the page and the file agree on ONE string, and importing the page's own
 * constant would assert only that it equals itself. The last test ties this
 * literal to the registry's own spelling.
 */
const LIGATURES_KEY = "terminal.ligatures";

function config(values: Partial<ConfigValues["terminal"]> | null): ConfigValues {
  return {
    appearance: { theme: "light", sidebar_width: 301, sidebar_pinned: false },
    browser: {
      search_engine: "duckduckgo",
      custom_search_template: "",
      archive_after: "24h",
    },
    terminal: values === null ? undefined : values,
  };
}

/** Serve the page, with `terminal` as given — null meaning a core that has
 * never heard of this setting. */
function serve(terminal: Record<string, unknown> | null) {
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "config_schema") return [];
    if (cmd === "config_get") {
      return { values: config(terminal), warnings: [], sources: ["/x"] };
    }
    if (cmd === "app_health") {
      return { shellIntegration: false, homeDir: "/home/u", version: "0.0.0" };
    }
    if (cmd === "list_trusted_hosts") return [];
    if (cmd === "default_apps_status") return [];
    return undefined;
  });
}

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

const control = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>(
    `[data-setting-key="${LIGATURES_KEY}"]`
  );

const w = () => window as unknown as Record<string, unknown>;

beforeEach(async () => {
  await flushAll();
  await flushConfigWrites();
  localStorage.clear();
  mocks.invoke.mockReset();
  w().__TAURI_INTERNALS__ = {};
  useStore.setState({ ...CONFIG_NOT_READ, themePreference: "system" });
});

afterEach(async () => {
  while (mounted.length > 0) mounted.pop()?.();
  delete w().__TAURI_INTERNALS__;
  await flushConfigWrites();
});

describe("the ligature switch", () => {
  it("is on the page, bound to the key the file uses", async () => {
    serve({ ligatures: false });
    const host = render();
    await settle();
    expect(control(host), `no control is bound to ${LIGATURES_KEY}`).not.toBeNull();
  });

  it("shows what the file says", async () => {
    serve({ ligatures: true });
    const host = render();
    await settle();
    const button = control(host)!;
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(STR.settings.appearance.on);
  });

  it("writes the opposite of what it shows, under that key", async () => {
    serve({ ligatures: true });
    const host = render();
    await settle();

    flushSync(() => control(host)!.click());
    await settle();
    await flushConfigWrites();

    expect(mocks.invoke.mock.calls).toContainEqual([
      "config_set",
      { key: LIGATURES_KEY, value: false },
    ]);
    // And the control moved at once, rather than after a round trip.
    expect(control(host)!.getAttribute("aria-checked")).toBe("false");
  });

  it("refuses to act while the file has not answered, and says why", async () => {
    // A core older than this setting: the `[terminal]` section arrives with
    // no ligature key at all. The switch must not draw a value of its own.
    serve({ font_family: "", font_size: 13, line_height_percent: 120 });
    const host = render();
    await settle();

    const button = control(host)!;
    expect(button.disabled, "an unread switch must not be pressable").toBe(true);
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain(
      STR.settings.appearance.terminalLigaturesUnread
    );

    // Pressed all the same — a disabled button can still be clicked
    // programmatically, and nothing may be written.
    flushSync(() => button.click());
    await settle();
    await flushConfigWrites();
    const writes = mocks.invoke.mock.calls.filter(
      ([cmd, args]) =>
        cmd === "config_set" &&
        (args as { key?: string } | undefined)?.key === LIGATURES_KEY
    );
    expect(writes, "an unread switch wrote a value").toEqual([]);
  });

  it("says what turning it on costs, when it lands, and where", async () => {
    serve({ ligatures: false });
    const host = render();
    await settle();
    const text = host.textContent ?? "";
    // The sentences, from the strings table rather than retyped: this asserts
    // that the page shows them, not that two copies of them agree.
    //
    // All three, because each answers a question the user would otherwise
    // answer wrongly: the cost (the accelerated renderer), the timing (the
    // three settings above reach terminals that are already open and this
    // one does not, so nothing appears to happen), and the reach (a mirrored
    // remote session and the shell under a file listing are not covered).
    expect(text).toContain(STR.settings.appearance.terminalLigaturesNote);
    expect(text).toContain(STR.settings.appearance.terminalLigaturesWhen);
    expect(text).toContain(STR.settings.appearance.terminalLigaturesScope);
  });
});

describe("the key this page writes", () => {
  it("is the one the registry names", () => {
    // The literal is pinned here and imported nowhere, so this compares the
    // page's spelling with the file's rather than with itself. A rename on
    // either side fails here instead of as a write the core silently refuses.
    const keys = TERMINAL_KEYS as unknown as Record<string, string>;
    expect(keys.ligatures).toBe(LIGATURES_KEY);
  });

  it("has a title for the registry row to point at", () => {
    // The row's `str_key` is `settings.appearance.terminalLigatures`
    // (src-tauri/src/config.rs). A missing leaf is silent — the settings
    // search indexes the row with a null title and it stays findable by its
    // key — so nothing but this would notice the control losing its name.
    expect(strAt("settings.appearance.terminalLigatures")).toBe(
      STR.settings.appearance.terminalLigatures
    );
    expect(STR.settings.appearance.terminalLigatures.length).toBeGreaterThan(0);
  });
});
