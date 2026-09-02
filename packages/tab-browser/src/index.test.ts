import { describe, expect, it } from "vitest";
import { createPluginComposition } from "@tabverse/plugin-composition";
import { createBrowserPlugin, createBrowserRuntimePlugin } from "./index";

describe("Browser TabContribution", () => {
  it("preserves legacy state and renders through the narrow runtime service", async () => {
    const runtime = createBrowserRuntimePlugin({
      id: "tabverse.runtime.test.browser",
      service: {
        runtimeKind: "test",
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
});
