import { describe, expect, it } from "vitest";
import { createPluginComposition } from "@tabverse/plugin-composition";
import { createFilesPlugin, createFilesRuntimePlugin } from "./index";

describe("Files TabContribution", () => {
  it("preserves legacy state fields and renders through the runtime service", async () => {
    const runtime = createFilesRuntimePlugin({
      id: "tabverse.runtime.test.files",
      service: {
        runtimeKind: "test",
        render: (args) => ({ runtimeKind: "test", kind: "files", ...args }),
      },
    });
    const composition = createPluginComposition({
      plugins: [runtime, createFilesPlugin({ runtimePluginId: runtime.manifest.id })],
    });
    await composition.start();
    const instance = await composition.createInstance("files", "files-1");
    const state = { cwd: "/workspace", openPath: "README.md", future: 1 };
    expect(instance.contribution.state.migrate(state, 0)).toBe(state);
    expect(instance.contribution.view.render({
      tabId: instance.tabId,
      state,
      active: true,
      services: instance,
    })).toMatchObject({ runtimeKind: "test", kind: "files", state });
    expect(instance.contribution.remote).toBeUndefined();
    expect(instance.contribution.resident).toEqual({
      capability: "state-only",
      runtimeKind: "files",
    });
    await instance.dispose();
    await composition.dispose();
  });
});
