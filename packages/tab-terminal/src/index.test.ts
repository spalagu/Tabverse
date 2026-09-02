import { describe, expect, it, vi } from "vitest";
import { createPluginComposition } from "@tabverse/plugin-composition";
import {
  createTerminalPlugin,
  createTerminalRuntimePlugin,
  TERMINAL_KIND,
  TERMINAL_PLUGIN_ID,
  type TerminalCommand,
} from "./index";

describe("Terminal TabContribution", () => {
  it("assembles view, state, and commands through the narrow runtime service", async () => {
    const render = vi.fn((args) => ({ tabId: args.tabId, state: args.state }));
    const runCommand = vi.fn(
      (tabId: string, command: TerminalCommand, input?: unknown) => ({
        tabId,
        command,
        input,
      }),
    );
    const runtime = createTerminalRuntimePlugin({
      id: "tabverse.runtime.test.terminal",
      service: {
        runtimeKind: "test",
        render,
        runCommand,
        resident: {
          capability: "continuous",
          runtimeKind: "terminal",
          descriptor: async () => ({
            pluginId: "tabverse.tab.terminal",
            pluginVersion: "1.0.0",
            artifactHash: "a".repeat(64),
            entrypoint: "terminal-worker",
            permissions: [],
            protocolRange: { min: 1, max: 2 },
            signature: "fixture",
          }),
          initialStateSchema: {
            id: "terminal.initial/v1",
            validate: (input): input is Readonly<Record<string, unknown>> =>
              input !== null && typeof input === "object" && !Array.isArray(input),
          },
          checkpointSchema: {
            id: "terminal.checkpoint/v1",
            validate: (input): input is Readonly<Record<string, unknown>> =>
              input !== null && typeof input === "object" && !Array.isArray(input),
          },
        },
      },
    });
    const composition = createPluginComposition({
      plugins: [
        runtime,
        createTerminalPlugin({ runtimePluginId: runtime.manifest.id }),
      ],
    });

    await composition.start();
    const instance = await composition.createInstance(TERMINAL_KIND, "term-1");
    const state = { title: "Shell", cwd: "/workspace", future: { kept: true } };
    expect(instance.pluginId).toBe(TERMINAL_PLUGIN_ID);
    expect(instance.contribution.state.parse(state)).toBe(state);
    expect(instance.contribution.state.migrate(state, 0)).toBe(state);
    expect(() => instance.contribution.state.parse([])).toThrow(
      "terminal state must be an object",
    );
    expect(
      instance.contribution.view.render({
        tabId: instance.tabId,
        state,
        active: true,
        services: instance,
      }),
    ).toEqual({ tabId: "term-1", state });
    await expect(
      Promise.resolve(
        instance.contribution.commands?.[0]?.run("term-1", { cwd: "/tmp" }),
      ),
    ).resolves.toMatchObject({
      tabId: "term-1",
      command: "terminal.split-horizontal",
    });
    expect(instance.contribution.permissions).toEqual([
      expect.objectContaining({ capability: "terminal.runtime" }),
    ]);
    expect(instance.contribution.remote).toBeUndefined();
    expect(instance.contribution.resident).toMatchObject({
      capability: "continuous",
      runtimeKind: "terminal",
    });

    await instance.dispose();
    await composition.dispose();
  });
});
