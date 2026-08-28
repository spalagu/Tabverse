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

const BACKGROUND_TASKS_KEY = "terminal.background_tasks";

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

function serve(
  terminal: Record<string, unknown> | null,
  writeError: Error | null = null
) {
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "config_schema") return [];
    if (cmd === "config_get") {
      return { values: config(terminal), warnings: [], sources: ["/x"] };
    }
    if (cmd === "config_set" && writeError !== null) throw writeError;
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
    `[data-setting-key="${BACKGROUND_TASKS_KEY}"]`
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

describe("the background-task prompt switch", () => {
  it("is present as a switch and explains that it asks rather than automatically backgrounds tasks", async () => {
    serve({ background_tasks: false });
    const host = render();
    await settle();

    const button = control(host);
    expect(button, `no control is bound to ${BACKGROUND_TASKS_KEY}`).not.toBeNull();
    expect(button?.getAttribute("role")).toBe("switch");
    expect(button?.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain(
      STR.settings.appearance.terminalBackgroundTasksNote
    );
  });

  it.each([
    [false, true],
    [true, false],
  ])("writes %s as %s under the terminal setting key", async (initial, next) => {
    serve({ background_tasks: initial });
    const host = render();
    await settle();

    flushSync(() => control(host)!.click());
    await settle();
    await flushConfigWrites();

    expect(mocks.invoke.mock.calls).toContainEqual([
      "config_set",
      { key: BACKGROUND_TASKS_KEY, value: next },
    ]);
    expect(control(host)!.getAttribute("aria-checked")).toBe(String(next));
  });

  it("rolls back after a failed write", async () => {
    serve({ background_tasks: false }, new Error("disk full"));
    const host = render();
    await settle();

    flushSync(() => control(host)!.click());
    expect(control(host)!.getAttribute("aria-checked")).toBe("true");
    await flushConfigWrites();
    await settle();

    expect(control(host)!.getAttribute("aria-checked")).toBe("false");
  });

  it("waits for the configuration file rather than inventing a default", async () => {
    serve({ ligatures: false });
    const host = render();
    await settle();

    const button = control(host)!;
    expect(button.disabled).toBe(true);
    expect(host.textContent).toContain(
      STR.settings.appearance.terminalBackgroundTasksUnread
    );
  });
});

describe("the background-task prompt setting key", () => {
  it("matches the registry and has a user-facing title", () => {
    const keys = TERMINAL_KEYS as unknown as Record<string, string>;
    expect(keys.backgroundTasks).toBe(BACKGROUND_TASKS_KEY);
    expect(strAt("settings.appearance.terminalBackgroundTasks")).toBe(
      STR.settings.appearance.terminalBackgroundTasks
    );
  });
});
