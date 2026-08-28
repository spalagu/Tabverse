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
} from "../state/config";
import { useStore } from "../state/store";
import { STR } from "../strings";
import {
  BUILTIN_THEMES,
  themeChoices,
  themeIds,
  themeMeta,
} from "../theme/tokens";
import { SettingsView } from "./SettingsView";

function serve() {
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "config_schema") return [];
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

/** The appearance control's buttons, in the order they are offered. */
function themeButtons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    host.querySelectorAll<HTMLButtonElement>(
      `[data-setting-key="${CONFIG_KEYS.theme}"] .segmented-btn`
    )
  );
}

/** The themes tokens.json declares that are not one of the two built-ins. */
const BEYOND_THE_BUILTINS = themeIds().filter(
  (id) => !(BUILTIN_THEMES as readonly string[]).includes(id)
);

const w = () => window as unknown as Record<string, unknown>;

beforeEach(async () => {
  await flushAll();
  await flushConfigWrites();
  localStorage.clear();
  mocks.invoke.mockReset();
  serve();
  w().__TAURI_INTERNALS__ = {};
  useStore.setState({ ...CONFIG_NOT_READ, themePreference: "system" });
});

afterEach(async () => {
  while (mounted.length > 0) mounted.pop()?.();
  delete w().__TAURI_INTERNALS__;
  await flushConfigWrites();
});

describe("the appearance control", () => {
  it("offers every theme there is, plus following the system", async () => {
    const host = render();
    await settle();

    const buttons = themeButtons(host);
    expect(buttons.length, "one per theme, plus system").toBe(
      themeIds().length + 1
    );
    // There are more than the two built-ins to offer, or this test would be
    // satisfied by the very list it exists to catch.
    expect(BEYOND_THE_BUILTINS.length).toBeGreaterThan(0);

    const labels = buttons.map((b) => b.textContent);
    expect(labels).toEqual([
      STR.settings.appearance.system,
      // Each theme's own name, out of its own definition — the strings table
      // no longer holds a second copy of any of them.
      ...themeChoices().map((t) => t.label),
    ]);
  });

  it("selects a theme the app did not ship with, and writes it as its id", async () => {
    const host = render();
    await settle();

    const chosen = BEYOND_THE_BUILTINS[0];
    const button = themeButtons(host).find(
      (b) => b.textContent === themeMeta(chosen).label
    );
    expect(button, `a button for ${chosen}`).toBeDefined();
    flushSync(() => button!.click());
    await settle();

    expect(useStore.getState().themePreference).toBe(chosen);
    expect(useStore.getState().resolvedTheme).toBe(chosen);

    await flushConfigWrites();
    expect(mocks.invoke.mock.calls).toContainEqual([
      "config_set",
      { key: CONFIG_KEYS.theme, value: chosen },
    ]);
  });

  it("shows the chosen one as chosen, whichever it is", async () => {
    const chosen = BEYOND_THE_BUILTINS[BEYOND_THE_BUILTINS.length - 1];
    useStore.setState({ themePreference: chosen });
    const host = render();
    await settle();

    const checked = themeButtons(host).filter(
      (b) => b.getAttribute("aria-checked") === "true"
    );
    expect(checked.length, "exactly one is the chosen one").toBe(1);
    expect(checked[0].textContent).toBe(themeMeta(chosen).label);
  });
});
