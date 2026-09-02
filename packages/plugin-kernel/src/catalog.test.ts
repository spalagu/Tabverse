import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "@tabverse/tab-contracts";
import {
  emptyCatalog,
  JsonCatalogStore,
  MemoryCatalogStore,
  PluginKernel,
  type CatalogPluginRecord,
  type CatalogSnapshot,
} from "./index";

function descriptor(id: string, activate: InstalledPlugin["activate"]): InstalledPlugin {
  return {
    manifest: {
      id,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [],
      tabs: [],
      builtIn: true,
      enabledByDefault: false,
    },
    activate,
  };
}

describe("PluginCatalog recovery", () => {
  it("persists canonical JSON through an adapter-owned atomic write", async () => {
    let durable: string | null = null;
    const store = new JsonCatalogStore({
      read: async () => durable,
      writeAtomic: async (contents) => { durable = contents; },
    });
    expect(await store.load()).toEqual(emptyCatalog());
    await store.save({ ...emptyCatalog(), revision: 3 });
    expect(durable).toContain('"revision": 3');
    expect(await store.load()).toMatchObject({ schema: "tabverse-plugin-catalog/v1", revision: 3 });
    durable = "{broken";
    await expect(store.load()).rejects.toMatchObject({ code: "CATALOG_CORRUPT" });
  });

  it("restores enabled after a disposer failure when compensation activation succeeds", async () => {
    let activation = 0;
    const plugin = descriptor("restore", async () => {
      activation += 1;
      if (activation === 1) return { dispose: () => { throw new Error("dispose failed"); } };
      return { dispose: () => undefined };
    });
    const kernel = new PluginKernel();
    await kernel.install(plugin, { commandId: "install", expectedRevision: 0 });
    await kernel.enable("restore", { commandId: "enable", expectedRevision: 1 });
    await expect(kernel.disable("restore", { commandId: "disable", expectedRevision: 2 }))
      .rejects.toMatchObject({ code: "DISPOSAL_FAILED", details: { compensationFailed: false } });
    expect(await kernel.inspect("restore")).toMatchObject({ state: "enabled", lastStableState: "enabled" });
    expect(await kernel.diagnostics()).toMatchObject({ activePlugins: ["restore"] });
    await kernel.dispose();
  });

  it("enters failed after compensation fails, then retry reaches the original target", async () => {
    const plugin = descriptor("retryable", async () => ({ dispose: () => undefined }));
    const failedRecord: CatalogPluginRecord = {
      manifest: plugin.manifest,
      state: "failed",
      lastStableState: "installed",
      failure: { operation: "enable", message: "activation and compensation failed", atRevision: 1 },
    };
    const initial: CatalogSnapshot = { ...emptyCatalog(), revision: 1, plugins: { retryable: failedRecord } };
    const store = new MemoryCatalogStore(initial);
    const kernel = new PluginKernel({ store, available: [plugin] });
    const retried = await kernel.retry("retryable", { commandId: "retry", expectedRevision: 1 });
    expect(retried).toMatchObject({ state: "enabled", outcome: "committed" });
    expect(await kernel.inspect("retryable")).toMatchObject({ state: "enabled", lastStableState: "enabled" });
    expect(await kernel.diagnostics()).toMatchObject({ activePlugins: ["retryable"] });
    await kernel.dispose();
  });

  it("rejects corrupt plugin records before runtime activation", async () => {
    let durable = JSON.stringify({
      ...emptyCatalog(),
      plugins: { bad: { manifest: { id: "different" }, state: "enabled", lastStableState: "enabled" } },
    });
    const store = new JsonCatalogStore({ read: async () => durable, writeAtomic: async (value) => { durable = value; } });
    await expect(store.load()).rejects.toMatchObject({ code: "CATALOG_CORRUPT" });
  });

  it("rolls back earlier dependency activation when bootstrap later fails", async () => {
    let providerActive = 0;
    const provider = descriptor("provider", async () => {
      providerActive += 1;
      return { dispose: () => { providerActive -= 1; } };
    });
    const consumer: InstalledPlugin = {
      manifest: {
        ...descriptor("consumer", async () => undefined).manifest,
        dependencies: [{ id: "provider", range: "^1.0.0" }],
      },
      activate: async () => { throw new Error("consumer failed"); },
    };
    const enabled = (plugin: InstalledPlugin): CatalogPluginRecord => ({
      manifest: plugin.manifest,
      state: "enabled",
      lastStableState: "enabled",
    });
    const store = new MemoryCatalogStore({
      ...emptyCatalog(),
      revision: 2,
      plugins: { provider: enabled(provider), consumer: enabled(consumer) },
    });
    const kernel = new PluginKernel({ store, available: [provider, consumer] });
    await expect(kernel.bootstrap()).rejects.toMatchObject({ code: "ACTIVATION_FAILED" });
    expect(providerActive).toBe(0);
    expect(await kernel.diagnostics()).toMatchObject({ activePlugins: [], services: [], tabKinds: [] });
  });
});
