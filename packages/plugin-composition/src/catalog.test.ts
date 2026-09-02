import { describe, expect, it } from "vitest";
import { MemoryCatalogStore } from "@tabverse/plugin-kernel";
import {
  resolveTabStateEnvelope,
  type InstalledPlugin,
  type TabContribution,
  type TabStateEnvelope,
} from "@tabverse/tab-contracts";
import { createPluginComposition } from "./index";

function bundledPlugin(id = "fixture.plugin"): InstalledPlugin {
  return {
    manifest: {
      id,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [],
      tabs: [],
      builtIn: true,
      enabledByDefault: true,
    },
    activate: () => undefined,
  };
}

describe("PluginComposition catalog management", () => {
  it("persists an uninstall tombstone until an explicit reinstall", async () => {
    const store = new MemoryCatalogStore();
    const descriptor = bundledPlugin();
    const first = createPluginComposition({
      plugins: [descriptor],
      store,
      stateEnvelopes: { capture: async () => ({ tabs: ["kept"] }) },
    });
    expect((await first.catalog())[0]).toMatchObject({ state: "enabled" });
    await first.disable(descriptor.manifest.id);
    await first.uninstall(descriptor.manifest.id);
    expect((await first.catalog())[0]).toMatchObject({
      state: "not-installed",
      retainedState: true,
    });
    await first.dispose();

    const restarted = createPluginComposition({ plugins: [descriptor], store });
    expect((await restarted.catalog())[0]).toMatchObject({
      state: "not-installed",
      retainedState: true,
    });
    expect(await restarted.diagnostics()).toMatchObject({ activePlugins: [] });

    await restarted.install(descriptor.manifest.id);
    await restarted.enable(descriptor.manifest.id);
    expect((await restarted.catalog())[0]).toMatchObject({
      state: "enabled",
      retainedState: true,
    });
    await restarted.dispose();
  });

  it("surfaces lifecycle blockers without changing the stable catalog state", async () => {
    const descriptor = bundledPlugin("fixture.blocked");
    const composition = createPluginComposition({
      plugins: [descriptor],
      blockers: async () => [{
        type: "resident-runtime",
        id: "runtime-1",
        detail: "tab-1",
      }],
    });
    await composition.start();
    await expect(composition.disable(descriptor.manifest.id)).rejects.toMatchObject({
      code: "PLUGIN_BLOCKED",
      details: {
        blockers: [{ type: "resident-runtime", id: "runtime-1", detail: "tab-1" }],
      },
    });
    expect((await composition.catalog())[0]).toMatchObject({ state: "enabled" });
    await composition.dispose();
  });
});

describe("Tab state compatibility matrix", () => {
  const contribution: TabContribution<{ value: string; migrated: boolean }> = {
    manifest: {
      kind: "fixture",
      version: 2,
      stateVersion: 2,
      presentation: { label: "Fixture", hint: "Fixture", icon: "fixture" },
    },
    view: { render: () => null, requiredServices: [] },
    state: {
      parse(input) {
        if (
          input === null || typeof input !== "object" || Array.isArray(input) ||
          typeof (input as { value?: unknown }).value !== "string" ||
          typeof (input as { migrated?: unknown }).migrated !== "boolean"
        ) throw new TypeError("fixture state is invalid");
        return input as { value: string; migrated: boolean };
      },
      migrate(input, from) {
        if (from !== 1 || typeof input !== "string") throw new Error("unsupported fixture state");
        return { value: input, migrated: true };
      },
    },
    permissions: [],
    fallback: "placeholder",
  };

  const envelope = (overrides: Partial<TabStateEnvelope> = {}): TabStateEnvelope => ({
    schema: "tabverse-tab-state/v1",
    kind: "fixture",
    contributionVersion: 1,
    stateVersion: 1,
    payload: "kept",
    ...overrides,
  });

  it("migrates N-1 and explicitly retains unknown, future and invalid state", () => {
    expect(resolveTabStateEnvelope(envelope(), contribution)).toEqual({
      status: "ready",
      state: { value: "kept", migrated: true },
    });
    expect(resolveTabStateEnvelope(envelope(), undefined)).toMatchObject({
      status: "placeholder",
      reason: "missing-plugin",
      envelope: envelope(),
    });
    expect(resolveTabStateEnvelope(envelope({ stateVersion: 3 }), contribution)).toMatchObject({
      status: "placeholder",
      reason: "future-state-version",
    });
    expect(resolveTabStateEnvelope(envelope({ contributionVersion: 3 }), contribution)).toMatchObject({
      status: "placeholder",
      reason: "future-contribution-version",
    });
    expect(resolveTabStateEnvelope(envelope({ payload: 42 }), contribution)).toMatchObject({
      status: "placeholder",
      reason: "migration-failed",
      envelope: { payload: 42 },
    });
  });
});
