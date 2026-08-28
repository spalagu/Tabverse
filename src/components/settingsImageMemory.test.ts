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
  type Setting,
} from "../state/config";
import { useStore } from "../state/store";
import { STR } from "../strings";
import { SettingsView } from "./SettingsView";
import { strAt } from "./settingsSearch";

/**
 * The key this page writes the number to — pinned as a literal for the
 * same reason the ligature file gives: importing the page's own constant
 * would assert only that it equals itself. The last test ties the literal
 * to the registry's spelling via TERMINAL_KEYS.
 */
const IMAGE_KEY = "terminal.image_memory_mb";

/** The registry row for the setting, as `config_schema` would serve it.
 * The real bounds live in src-tauri/src/config.rs and are pinned by the
 * Rust tests; this is the row arriving over the wire. */
const IMAGE_BOUNDS: { min: number; max: number } = { min: 16, max: 512 };
const IMAGE_ROW: Setting = {
  key: IMAGE_KEY,
  kind: { number: IMAGE_BOUNDS },
  section: "appearance",
  str_key: "settings.appearance.terminalImageMemory",
  default: 128,
};

function config(terminal: Record<string, unknown> | null): ConfigValues {
  return {
    appearance: { theme: "light", sidebar_width: 301, sidebar_pinned: false },
    browser: {
      search_engine: "duckduckgo",
      custom_search_template: "",
      archive_after: "24h",
    },
    terminal: values(terminal),
  };
}

/** The `[terminal]` section with the one field this row cares about, or
 * null for a core that has never heard of the setting. */
function values(terminal: Record<string, unknown> | null) {
  return terminal === null
    ? undefined
    : {
        font_family: "",
        font_size: 13,
        line_height_percent: 120,
        ligatures: false,
        ...terminal,
      };
}

function serve(terminal: Record<string, unknown> | null) {
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "config_schema") return [IMAGE_ROW];
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
  host.querySelector<HTMLInputElement>(`[data-setting-key="${IMAGE_KEY}"]`);

/** Type into the number box the way a user does: per character, through
 * the native setter, so React's onChange actually runs. */
function type(host: HTMLElement, value: string) {
  const input = control(host)!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const writesFor = () =>
  mocks.invoke.mock.calls.filter(
    ([cmd, args]) =>
      cmd === "config_set" &&
      (args as { key?: string } | undefined)?.key === IMAGE_KEY
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

describe("the image-memory number row", () => {
  it("is on the page, bound to the key the file uses", async () => {
    serve({ image_memory_mb: 64 });
    const host = render();
    await settle();
    expect(control(host), `no control is bound to ${IMAGE_KEY}`).not.toBeNull();
  });

  it("shows what the file says, bounded by what the registry row says", async () => {
    serve({ image_memory_mb: 64 });
    const host = render();
    await settle();
    const input = control(host)!;
    expect(input.value).toBe("64");
    expect(input.disabled).toBe(false);
    // The bounds the registry row carries — never a copy beside the input.
    expect(String(input.min)).toBe(String(IMAGE_BOUNDS.min));
    expect(String(input.max)).toBe(String(IMAGE_BOUNDS.max));
  });

  it("writes a number inside the range under that key, and not one outside it", async () => {
    serve({ image_memory_mb: 64 });
    const host = render();
    await settle();

    type(host, "96");
    await settle();
    await flushConfigWrites();
    expect(writesFor()).toContainEqual([
      "config_set",
      { key: IMAGE_KEY, value: 96 },
    ]);

    // Out of range in both directions: shown as a draft, never written.
    type(host, "4");
    type(host, "600");
    await settle();
    await flushConfigWrites();
    const written = writesFor().map(
      ([, args]) => (args as { value?: number } | undefined)?.value
    );
    expect(
      written,
      "only the in-range number reached the file"
    ).toEqual([96]);
  });

  it("refuses to act while the file has not answered", async () => {
    // A core older than this setting: the section arrives with no
    // image_memory_mb key at all.
    serve(null);
    const host = render();
    await settle();
    const input = control(host)!;
    expect(input.disabled, "an unread number must not be editable").toBe(true);
    expect(input.value).toBe("");
  });

  it("says per pane and new-terminals-only, in the strings table's words", async () => {
    serve({ image_memory_mb: 64 });
    const host = render();
    await settle();
    const text = host.textContent ?? "";
    expect(text).toContain(STR.settings.appearance.terminalImageMemory);
    expect(text).toContain(STR.settings.appearance.terminalImageMemoryUnit);
    expect(text).toContain(STR.settings.appearance.terminalImageMemoryWhen);
    expect(STR.settings.appearance.terminalImageMemoryWhen).toContain("pane");
    expect(STR.settings.appearance.terminalImageMemoryWhen).toContain(
      "afterwards"
    );
  });
});

describe("the key this page writes", () => {
  it("is the one the registry names, with a title to point at", () => {
    const keys = TERMINAL_KEYS as unknown as Record<string, string>;
    expect(keys.imageMemoryMb).toBe(IMAGE_KEY);
    // A missing leaf would leave the settings search indexing the row with
    // a null title — silent, so nothing but this would notice.
    expect(strAt("settings.appearance.terminalImageMemory")).toBe(
      STR.settings.appearance.terminalImageMemory
    );
    expect(STR.settings.appearance.terminalImageMemory.length).toBeGreaterThan(
      0
    );
  });
});
