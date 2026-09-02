import { describe, expect, it } from "vitest";
import { createPluginComposition } from "@tabverse/plugin-composition";
import { createSettingsPlugin, createSettingsRuntimePlugin } from "./index";

describe("Settings TabContribution", () => {
  it("provides local view and state without remote or resident contributions", async () => {
    const runtime = createSettingsRuntimePlugin({
      id: "tabverse.runtime.test.settings",
      service: {
        runtimeKind: "test",
        render: (args) => ({ runtimeKind: "test", kind: "settings", ...args }),
      },
    });
    const composition = createPluginComposition({
      plugins: [
        runtime,
        createSettingsPlugin({ runtimePluginId: runtime.manifest.id }),
      ],
    });
    await composition.start();
    const instance = await composition.createInstance("settings", "settings-1");
    const state = { section: "network", future: true };
    expect(instance.contribution.state.migrate(state, 0)).toBe(state);
    expect(instance.contribution.remote).toBeUndefined();
    expect(instance.contribution.resident).toBeUndefined();
    expect(instance.contribution.permissions).toEqual([]);
    await instance.dispose();
    await composition.dispose();
  });
});
