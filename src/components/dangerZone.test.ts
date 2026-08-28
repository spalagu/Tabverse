import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { flushAll, SESSION_SCOPE, THEME_SCOPE } from "../persist";
import { CONFIG_KEYS, flushConfigWrites } from "../state/config";
import { useStore } from "../state/store";
import { STR } from "../strings";
import { setKeyOverrides } from "../shortcuts";
import { ConfirmHost } from "./Confirm";
import { SettingsView } from "./SettingsView";
import { dangerActions, runDangerAction, type DangerAction } from "./dangerZone";

/** Answers everything the settings page asks on the way up. */
function serve() {
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "config_schema") return [];
    if (cmd === "config_get") {
      return {
        values: {
          appearance: {
            theme: "system",
            sidebar_width: 248,
            sidebar_pinned: true,
          },
          browser: {
            search_engine: "duckduckgo",
            custom_search_template: "",
            archive_after: "24h",
          },
          keys: {},
        },
        warnings: [],
        sources: ["/home/u/.config/tabverse/config.toml"],
      };
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

/** The settings page with something to ask questions with. */
function render(): HTMLElement {
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
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return host;
}

const w = () => window as unknown as Record<string, unknown>;
const carrier = (scope: string) => `tabverse.state.${scope}`;

beforeEach(async () => {
  await flushAll();
  await flushConfigWrites();
  localStorage.clear();
  mocks.invoke.mockReset();
  setKeyOverrides({});
  w().__TAURI_INTERNALS__ = {};
  serve();
});

afterEach(async () => {
  while (mounted.length > 0) mounted.pop()?.();
  delete w().__TAURI_INTERNALS__;
  setKeyOverrides({});
  await flushAll();
});

// ------------------------------------------------------- the section itself

describe("the destructive actions are one section", () => {
  it("puts every one of them in the danger zone and nowhere else", async () => {
    const host = render();
    await settle();

    const zone = host.querySelector("#danger");
    expect(zone, "the danger zone").not.toBeNull();

    const inZone = Array.from(
      zone!.querySelectorAll<HTMLButtonElement>("button[data-danger]")
    );
    expect(inZone.map((b) => b.getAttribute("data-danger"))).toEqual([
      "session",
      "history",
      "passwords",
      "factory",
    ]);
    // Same red as every other destructive control in the app, so "this
    // erases something" is one visual fact rather than four.
    for (const b of inZone) {
      expect(b.className, `${b.getAttribute("data-danger")} is marked`).toContain(
        "danger"
      );
    }
    // And they are not still sitting in the sections they came from: the
    // survey's finding was three erasures in three places, two of which
    // asked nothing.
    expect(
      host.querySelectorAll("button[data-danger]").length,
      "no destructive button outside the zone"
    ).toBe(inZone.length);
  });
});

// --------------------------------------------------- the question they ask

describe("every one of them asks first, and asks alike", () => {
  /** The question on screen, or null when nothing is asking. */
  function questionOn(host: HTMLElement): string | null {
    const box = host.querySelector(".confirm-box .confirm-text");
    return box === null ? null : (box.textContent ?? "");
  }

  it("asks before it does anything, on every button", async () => {
    const host = render();
    await settle();
    const actions = dangerActions(() => {});

    for (const action of actions) {
      const button = host.querySelector<HTMLButtonElement>(
        `button[data-danger="${action.id}"]`
      );
      expect(button, `the ${action.id} button`).not.toBeNull();
      flushSync(() => button!.click());
      await settle();
      flushSync(() => {});

      expect(questionOn(host), `${action.id} asks before it erases`).toBe(
        action.question
      );

      // Answered NO, every time. Cancel is the free answer and it is the
      // only one this file ever gives.
      const cancel = host.querySelector<HTMLButtonElement>(
        ".confirm-actions .btn:not(.danger)"
      );
      expect(cancel, "the cancel button").not.toBeNull();
      flushSync(() => cancel!.click());
      await settle();
      expect(questionOn(host), "and the question closes").toBeNull();
    }

    // Nothing was erased along the way: the one erasure that would have
    // gone through the core is not among the calls.
    expect(
      mocks.invoke.mock.calls.map(([cmd]) => cmd),
      "no destructive command was issued"
    ).not.toContain("pw_forget_all");
  });

  it("asks in one sentence shape, filled in per action", () => {
    const S = STR.settings.danger;
    const actions = dangerActions(() => {});
    const erases: Record<string, string> = {
      session: S.sessionErases,
      history: S.historyErases,
      passwords: S.passwordsErases,
      factory: S.factoryErases,
    };

    for (const action of actions) {
      const clause = erases[action.id];
      expect(clause, `${action.id} says what it erases`).toBeDefined();
      // The question IS the template applied to this action's clause —
      // not merely similar to it. A hand-written sentence that happened to
      // read the same way today would fail here the moment the template is
      // reworded, which is the drift this is guarding.
      expect(action.question, `${action.id} uses the one template`).toBe(
        S.question({ erases: clause })
      );
      // And each one names its own act on the proceed button, so the
      // confirmation says what is about to happen rather than "OK".
      expect(action.confirmLabel.length, `${action.id} names its act`).toBeGreaterThan(0);
      expect(action.confirmLabel).not.toBe(STR.common.proceed);
    }
  });

  it("does not perform anything when the answer is no", async () => {
    // The guard the two tests above lean on, stated on its own: the path
    // from a press to an erasure runs through the question.
    let ran = 0;
    const asked: string[] = [];
    const action: DangerAction = {
      id: "session",
      label: "x",
      confirmLabel: "y",
      question: "q",
      perform: async () => {
        ran += 1;
      },
    };

    const said = await runDangerAction(action, async (message) => {
      asked.push(message);
      return false;
    });

    expect(asked).toEqual(["q"]);
    expect(ran).toBe(0);
    expect(said).toBe(false);
  });
});

// --------------------------------------------------------- factory reset

describe("restoring factory settings", () => {
  it("clears the scopes, the key overlay and the theme — and nothing else", async () => {
    // The harness, written here so it is plain that the three "scopes"
    // below are this test's own and that no file is involved.
    localStorage.setItem(carrier(SESSION_SCOPE), JSON.stringify({ tabs: [] }));
    localStorage.setItem(
      carrier(THEME_SCOPE),
      JSON.stringify({ preference: "midnight" })
    );
    localStorage.setItem(carrier("browser-history"), "[]");
    setKeyOverrides({ "duplicate-tab": "⌃⌥Z" });

    const factory = dangerActions(() => {}).find((a) => a.id === "factory");
    expect(factory, "the factory reset").toBeDefined();
    const ran = await runDangerAction(factory!, async () => true);
    expect(ran).toBe(true);
    await settle();
    await flushAll();
    await settle();

    // ① every scope, the theme snapshot included — unlike forgetting the
    // session, which spares it.
    for (const scope of [SESSION_SCOPE, THEME_SCOPE, "browser-history"]) {
      expect(localStorage.getItem(carrier(scope)), `${scope} is gone`).toBeNull();
    }
    // ② the key overlay, in the file and in memory.
    const commands = mocks.invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands, "the overlay is dropped in the file").toContain(
      "config_keys_clear"
    );
    // ③ the theme, by deleting its line — never by writing a theme name in,
    // which would freeze today's default into somebody's file.
    expect(mocks.invoke.mock.calls).toContainEqual([
      "config_reset",
      { key: CONFIG_KEYS.theme },
    ]);
    expect(
      mocks.invoke.mock.calls.filter(
        ([cmd, args]) => cmd === "config_set" && args?.key === CONFIG_KEYS.theme
      ),
      "a reset is a deletion, not a write of the default"
    ).toEqual([]);

    // And what it leaves alone: the saved logins are in the keychain, not
    // in any scope, and forgetting them is its own decision one row up.
    expect(commands, "passwords are not part of a factory reset").not.toContain(
      "pw_forget_all"
    );
    // The file is re-read afterwards, which is what puts the theme back on
    // screen rather than leaving the old one showing until a restart.
    expect(commands.filter((c) => c === "config_get").length).toBeGreaterThan(0);
    expect(useStore.getState().themePreference).toBe("system");
  });
});
