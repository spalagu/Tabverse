import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


// backend/fs.ts chooses its branch at MODULE LOAD by reading the Tauri
// marker off the window; the hoisted block runs before the import graph
// does (filePeek.test.ts's load-time trick, same reason).
vi.hoisted(() => {
  (globalThis as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
});

const mocks = vi.hoisted(() => {
  /** The handlers registered per event name — the fake event channel. */
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
    listen: vi.fn(
      async (name: string, handler: (e: unknown) => void): Promise<() => void> => {
        const forName = listeners.get(name) ?? [];
        forName.push(handler);
        listeners.set(name, forName);
        return () => {};
      }
    ),
    listeners,
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

// Monaco cannot load in the test environment (filesView.test.ts's mock,
// same reason): TabContent imports the whole view family, and the editor is
// the one member of it that needs standing in. Nothing under test touches
// it — the settings pane renders none of FilesView.
vi.mock("./files/CodeEditor", () => ({
  CodeEditor: () => null,
  disposeEditorState: () => {},
  languageFor: (p: string) => p,
  openEditorFind: () => false,
  currentEditorThemeName: () => "",
}));

import { flushAll } from "../persist";
import { CONFIG_NOT_READ, flushConfigWrites } from "../state/config";
import { useStore } from "../state/store";
import { STR } from "../strings";

const { TabContent } = await import("./TabContent");

/** Deliver the page's config with coverage on and a provider chosen — the
 * state in which the proxy runs and its death is the page's news to
 * break. */
function serve() {
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "config_schema") return [];
    if (cmd === "config_get") {
      return {
        values: {
          appearance: { theme: "light", sidebar_width: 301, sidebar_pinned: false },
          browser: {
            search_engine: "duckduckgo",
            custom_search_template: "",
            archive_after: "24h",
          },
          network: { dns_mode: "cloudflare", dns_custom_url: "", cover_page_traffic: true },
        },
        warnings: [],
        sources: ["/x"],
      };
    }
    if (cmd === "app_health") {
      return { shellIntegration: false, homeDir: "/home/u", version: "0.0.0" };
    }
    if (cmd === "list_trusted_hosts") return [];
    if (cmd === "default_apps_status") return [];
    if (cmd === "media_list") return [];
    if (cmd === "userscripts_list") return [];
    if (cmd === "page_coverable") return true;
    return undefined;
  });
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Deliver a core event to whoever subscribed, the way the real channel
 * would — synchronously, so the render it causes is observable at once. */
function deliver(name: string, payload: unknown) {
  for (const handler of mocks.listeners.get(name) ?? []) {
    flushSync(() => handler({ event: name, id: 0, payload }));
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const w = () => window as unknown as Record<string, unknown>;

/** The content area with a settings tab in it — the place the banner is
 * lit through. */
function mountContent() {
  useStore.setState({
    ...CONFIG_NOT_READ,
    themePreference: "system",
    tabs: [{ id: "settings-1", type: "settings", title: "Settings", groupId: null }],
    activeTabId: "settings-1",
    split: null,
    peekTabId: null,
  });
  flushSync(() => {
    root!.render(createElement(TabContent));
  });
}

beforeEach(async () => {
  await flushAll();
  await flushConfigWrites();
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.listen.mockClear();
  mocks.listeners.clear();
  w().__TAURI_INTERNALS__ = {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete w().__TAURI_INTERNALS__;
  await flushConfigWrites();
});

describe("the proxy-down banner's truth", () => {
  it("lights the banner when the core's death event arrives, and un-claims coverage", async () => {
    serve();
    mountContent();
    await settle();

    // Before the death: the covered claim stands and no banner — this is
    // the state the event is about to make false.
    expect(host!.textContent).toContain(STR.settings.network.coveredWebview);
    expect(host!.textContent).not.toContain(STR.settings.network.proxyDownHeading);

    // The core says the listener died — the same event, payload and all,
    // the Rust side emits the moment the accept thread ends unasked.
    deliver("page-proxy-down", { status: "down" });
    await settle();

    const text = host!.textContent ?? "";
    // The banner: what happened, what new tabs do, what open tabs do.
    expect(text).toContain(STR.settings.network.proxyDownHeading);
    expect(text).toContain(STR.settings.network.proxyDownBlurb);
    // The status line fell back with it, and the covered claim is gone —
    // the page must not keep telling the reader both stories.
    expect(text).toContain(STR.settings.network.coverDownWebview);
    expect(text).not.toContain(STR.settings.network.coveredWebview);
  });

  it("does not invent a channel outside the app: no subscription, no banner", async () => {
    // The web demo has no Tauri internals, so no event can arrive and none
    // is subscribed to — the flag's honest value there is and stays false.
    delete w().__TAURI_INTERNALS__;
    serve();
    mountContent();
    await settle();

    expect(mocks.listen).not.toHaveBeenCalled();
    expect(host!.textContent).not.toContain(STR.settings.network.proxyDownHeading);
    expect(host!.textContent).not.toContain(STR.settings.network.coverDownWebview);
  });
});
