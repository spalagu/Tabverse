import { describe, expect, it } from "vitest";
import { createPluginComposition } from "@tabverse/plugin-composition";
import { createRemotePlugin, createRemoteRuntimePlugin } from "./index";

describe("Remote TabContribution", () => {
  it("declares no nested remote contribution while the desktop runtime provides continuous residence", async () => {
    const runtime = createRemoteRuntimePlugin({
      id: "tabverse.runtime.test.remote",
      service: {
        runtimeKind: "test",
        resident: {
          capability: "continuous",
          runtimeKind: "remote",
          descriptor: async () => ({
            pluginId: "tabverse.tab.remote",
            pluginVersion: "1.0.0",
            artifactHash: "b".repeat(64),
            entrypoint: "remote-worker",
            permissions: [],
            protocolRange: { min: 1, max: 2 },
            signature: "fixture",
          }),
          initialStateSchema: {
            id: "remote.initial/v1",
            validate: (input): input is Readonly<Record<string, unknown>> =>
              input !== null && typeof input === "object" && !Array.isArray(input),
          },
          checkpointSchema: {
            id: "remote.checkpoint/v1",
            validate: (input): input is Readonly<Record<string, unknown>> =>
              input !== null && typeof input === "object" && !Array.isArray(input),
          },
        },
        render: (args) => ({ runtimeKind: "test", kind: "remote", ...args }),
      },
    });
    const composition = createPluginComposition({
      plugins: [runtime, createRemotePlugin({ runtimePluginId: runtime.manifest.id })],
    });
    await composition.start();
    const instance = await composition.createInstance("remote", "remote-1");
    const state = { joinTicket: "ticket-placeholder", future: true };
    expect(instance.contribution.state.migrate(state, 0)).toBe(state);
    expect(instance.contribution.remote).toBeUndefined();
    expect(instance.contribution.resident).toMatchObject({
      capability: "continuous",
      runtimeKind: "remote",
    });
    expect(instance.contribution.permissions.map((permission) => permission.capability)).toEqual([
      "remote.runtime",
    ]);
    await instance.dispose();
    await composition.dispose();
  });
});
