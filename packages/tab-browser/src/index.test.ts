import { describe, expect, it } from "vitest";
import { createPluginComposition } from "@tabverse/plugin-composition";
import {
  createBrowserPlugin,
  createBrowserRuntimePlugin,
  type BrowserEventEnvelope,
  type BrowserSessionHandle,
  type BrowserSessionPort,
  type BrowserSessionSpec,
} from "./index";

function sessionPort(): BrowserSessionPort & { readonly sessions: Set<string> } {
  const sessions = new Set<string>();
  const listeners = new Map<string, Set<(event: BrowserEventEnvelope) => void>>();
  let generation = 0n;
  return {
    engine: "cef",
    capabilities: {
      navigation: true,
      history: true,
      find: true,
      zoom: true,
      permissionPrompt: true,
      basicAuthPrompt: true,
      certificateErrorPrompt: true,
      download: true,
      popup: true,
      devtools: false,
      crashRecovery: true,
    },
    sessions,
    async ensureSession(spec: BrowserSessionSpec): Promise<BrowserSessionHandle> {
      sessions.add(spec.tabId);
      return { tabId: spec.tabId, sessionGeneration: ++generation };
    },
    async attachSurface(tabId) {
      if (!sessions.has(tabId)) throw new Error("SESSION_GONE");
    },
    async command(tabId) {
      return sessions.has(tabId) ? { ok: true } : { ok: false, code: "SESSION_GONE" };
    },
    subscribe(tabId, sink) {
      const tabListeners = listeners.get(tabId) ?? new Set();
      tabListeners.add(sink);
      listeners.set(tabId, tabListeners);
      return {
        dispose: () => {
          tabListeners.delete(sink);
        },
      };
    },
    async closeSession(tabId) {
      sessions.delete(tabId);
      listeners.delete(tabId);
    },
  };
}

describe("Browser TabContribution", () => {
  it("preserves legacy state and renders through the narrow runtime service", async () => {
    const session = sessionPort();
    const runtime = createBrowserRuntimePlugin({
      id: "tabverse.runtime.test.browser",
      service: {
        runtimeKind: "test",
        session,
        render: (args) => ({ runtimeKind: "test", kind: "browser", ...args }),
      },
    });
    const composition = createPluginComposition({
      plugins: [runtime, createBrowserPlugin({ runtimePluginId: runtime.manifest.id })],
    });
    await composition.start();
    const instance = await composition.createInstance("browser", "browser-1");
    const state = { url: "http://intranet.local/", pinnedUrl: "http://intranet.local/", future: 1 };
    expect(instance.contribution.state.migrate(state, 0)).toBe(state);
    expect(instance.contribution.view.render({
      tabId: instance.tabId,
      state,
      active: true,
      services: instance,
    })).toMatchObject({ runtimeKind: "test", kind: "browser", state });
    expect(instance.contribution.permissions.map((permission) => permission.capability)).toEqual([
      "browser.runtime",
    ]);
    expect(instance.contribution.resident).toEqual({
      capability: "state-only",
      runtimeKind: "browser",
    });
    await instance.dispose();
    await composition.dispose();
  });

  it("keeps native engine details behind one lifecycle-safe session port", async () => {
    const port = sessionPort();
    expect(port.engine).toBe("cef");
    for (let index = 0; index < 100; index += 1) {
      const tabId = `browser-${index}`;
      const handle = await port.ensureSession({
        tabId,
        profileId: "default",
        initialUrl: "https://example.test/",
        network: { kind: "system" },
        privateMode: false,
      });
      expect(handle.tabId).toBe(tabId);
      await port.attachSurface(tabId, {
        slotId: `slot-${index}`,
        slotRevision: 1n,
        ownerWindowId: "main",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      });
      expect(await port.command(tabId, { type: "reload" })).toEqual({ ok: true });
      const subscription = port.subscribe(tabId, () => {});
      await subscription.dispose();
      await port.closeSession(tabId, "tab-close");
    }
    expect(port.sessions.size).toBe(0);
    expect(await port.command("missing", { type: "reload" })).toEqual({
      ok: false,
      code: "SESSION_GONE",
    });
  });
});
