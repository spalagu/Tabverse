import { describe, expect, it } from "vitest";
import {
  serviceToken,
  type InstalledPlugin,
  type PluginDependency,
  type PluginManifest,
  type ServiceToken,
} from "@tabverse/tab-contracts";
import {
  emptyCatalog,
  MemoryCatalogStore,
  PluginKernel,
  PluginKernelError,
  SimulatedProcessCrash,
  type CatalogPluginRecord,
  type CatalogSnapshot,
} from "./index";

class ResourceTracker {
  readonly counts = new Map<string, number>();

  acquire(kind: string): () => void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) throw new Error(`double release: ${kind}`);
      released = true;
      this.counts.set(kind, (this.counts.get(kind) ?? 0) - 1);
    };
  }

  total(): number {
    return [...this.counts.values()].reduce((sum, count) => sum + count, 0);
  }
}

function manifest(
  id: string,
  tabs: readonly string[] = [id],
  dependencies: readonly PluginDependency[] = [],
): PluginManifest {
  return { id, version: "1.0.0", apiVersion: 1, dependencies, tabs, builtIn: true, enabledByDefault: false };
}

function plugin(
  id: string,
  tracker: ResourceTracker,
  options: {
    readonly tabs?: readonly string[];
    readonly dependencies?: readonly PluginDependency[];
    readonly provide?: readonly [ServiceToken<string>, string];
    readonly require?: ServiceToken<string>;
    readonly failActivation?: boolean;
  } = {},
): InstalledPlugin {
  const pluginManifest = manifest(id, options.tabs ?? [id], options.dependencies ?? []);
  return {
    manifest: pluginManifest,
    async activate(context) {
      for (const resource of ["listener", "timer", "subscription", "native-handle"]) {
        context.defer(tracker.acquire(`${id}:${resource}`));
      }
      if (options.provide) context.provide(...options.provide);
      if (options.require) context.get(options.require);
      for (const kind of pluginManifest.tabs) {
        context.contributeTab({
          manifest: {
            kind,
            version: 1,
            stateVersion: 1,
            presentation: { label: kind, hint: kind, icon: kind },
          },
          view: { render: ({ tabId }) => tabId, requiredServices: [] },
          state: { parse: (input) => input, migrate: (input) => input },
          permissions: [],
          fallback: "placeholder",
          activate(instance) {
            instance.defer(tracker.acquire(`${id}:instance`));
          },
        });
      }
      if (options.failActivation) throw new Error("injected activation failure");
      return { dispose: tracker.acquire(`${id}:plugin`) };
    },
  };
}

async function installAndEnable(kernel: PluginKernel, descriptor: InstalledPlugin): Promise<number> {
  const installed = await kernel.install(descriptor, { commandId: `install:${descriptor.manifest.id}`, expectedRevision: 0 });
  const enabled = await kernel.enable(descriptor.manifest.id, { commandId: `enable:${descriptor.manifest.id}`, expectedRevision: installed.revision });
  return enabled.revision;
}

describe("PluginKernel contracts", () => {
  it("rejects malformed runtime presentation metadata before committing a Tab contribution", async () => {
    const tracker = new ResourceTracker();
    const malformed: InstalledPlugin = {
      manifest: manifest("invalid-presentation"),
      async activate(context) {
        context.defer(tracker.acquire("invalid-presentation:resource"));
        context.contributeTab({
          manifest: {
            kind: "invalid-presentation",
            version: 1,
            stateVersion: 1,
            presentation: { label: " ", hint: "Invalid", icon: "invalid" },
          },
          view: { render: ({ tabId }) => tabId, requiredServices: [] },
          state: { parse: (input) => input, migrate: (input) => input },
          permissions: [],
          fallback: "placeholder",
        });
      },
    };
    const kernel = new PluginKernel();
    await kernel.install(malformed, { commandId: "install-invalid-presentation", expectedRevision: 0 });

    await expect(kernel.enable("invalid-presentation", {
      commandId: "enable-invalid-presentation",
      expectedRevision: 1,
    })).rejects.toMatchObject({
      code: "ACTIVATION_FAILED",
      cause: { code: "INVALID_MANIFEST" },
    });
    expect(await kernel.diagnostics()).toMatchObject({ activePlugins: [], tabKinds: [] });
    expect(tracker.total()).toBe(0);
  });

  it("fails fast for missing, cyclic and version-incompatible dependency graphs", async () => {
    const tracker = new ResourceTracker();
    const missing = new PluginKernel();
    const missingPlugin = plugin("missing-root", tracker, { dependencies: [{ id: "absent", range: "^1.0.0" }] });
    await missing.install(missingPlugin, { commandId: "install-missing", expectedRevision: 0 });
    await expect(missing.enable("missing-root", { commandId: "enable-missing", expectedRevision: 1 }))
      .rejects.toMatchObject({ code: "MISSING_DEPENDENCY" });

    const cycle = new PluginKernel();
    const a = plugin("a", tracker, { dependencies: [{ id: "b", range: "1.0.0" }] });
    const b = plugin("b", tracker, { dependencies: [{ id: "a", range: "1.0.0" }] });
    await cycle.install(a, { commandId: "install-a", expectedRevision: 0 });
    await cycle.install(b, { commandId: "install-b", expectedRevision: 1 });
    await expect(cycle.enable("a", { commandId: "enable-a", expectedRevision: 2 }))
      .rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });

    const version = new PluginKernel();
    const provider = plugin("provider", tracker);
    const consumer = plugin("consumer", tracker, { dependencies: [{ id: "provider", range: "^2.0.0" }] });
    await version.install(provider, { commandId: "install-provider", expectedRevision: 0 });
    await version.install(consumer, { commandId: "install-consumer", expectedRevision: 1 });
    await expect(version.enable("provider", { commandId: "enable-provider", expectedRevision: 2 }))
      .rejects.toMatchObject({ code: "DEPENDENCY_VERSION" });
  });

  it("owns plugin and instance resources across 100 serial and 20 concurrent scopes", async () => {
    const tracker = new ResourceTracker();
    const descriptor = plugin("reference", tracker);
    const kernel = new PluginKernel({ stateEnvelopes: { capture: async (id) => ({ id, state: "kept" }) } });
    const enabledRevision = await installAndEnable(kernel, descriptor);

    for (let index = 0; index < 100; index += 1) {
      const scope = await kernel.createInstance("reference", `serial-${index}`);
      await scope.dispose();
      expect(tracker.total()).toBe(5);
    }
    const concurrent = await Promise.all(Array.from({ length: 20 }, (_, index) => kernel.createInstance("reference", `parallel-${index}`)));
    expect(tracker.total()).toBe(25);
    await Promise.all(concurrent.map((scope) => scope.dispose()));
    expect(tracker.total()).toBe(5);

    const blocking = await kernel.createInstance("reference", "blocking");
    await expect(kernel.disable("reference", { commandId: "disable-blocked", expectedRevision: enabledRevision }))
      .rejects.toMatchObject({ code: "PLUGIN_BLOCKED" });
    await blocking.dispose();
    const disabled = await kernel.disable("reference", { commandId: "disable", expectedRevision: enabledRevision });
    expect(disabled.state).toBe("disabled");
    expect(tracker.total()).toBe(0);
    const uninstalled = await kernel.uninstall("reference", { commandId: "uninstall", expectedRevision: disabled.revision });
    expect(uninstalled.state).toBe("not-installed");
    expect((await kernel.snapshot()).retainedState.reference.payload).toEqual({ id: "reference", state: "kept" });
    expect(await kernel.diagnostics()).toMatchObject({ activePlugins: [], tabKinds: [], instances: [], services: [] });
  });

  it("completes 100 full install-enable-create-close-disable-uninstall cycles with zero resources", async () => {
    const tracker = new ResourceTracker();
    const descriptor = plugin("cycle", tracker);
    const kernel = new PluginKernel();
    let revision = 0;
    for (let index = 0; index < 100; index += 1) {
      revision = (await kernel.install(descriptor, { commandId: `install:${index}`, expectedRevision: revision })).revision;
      revision = (await kernel.enable("cycle", { commandId: `enable:${index}`, expectedRevision: revision })).revision;
      const instance = await kernel.createInstance("cycle", `cycle:${index}`);
      await instance.dispose();
      revision = (await kernel.disable("cycle", { commandId: `disable:${index}`, expectedRevision: revision })).revision;
      revision = (await kernel.uninstall("cycle", { commandId: `uninstall:${index}`, expectedRevision: revision })).revision;
      expect(tracker.total()).toBe(0);
    }
    expect(revision).toBe(400);
    expect(await kernel.diagnostics()).toMatchObject({ activePlugins: [], tabKinds: [], instances: [], services: [] });
  });

  it("stages activation atomically and releases resources when activation fails", async () => {
    const tracker = new ResourceTracker();
    const descriptor = plugin("fails", tracker, { failActivation: true });
    const kernel = new PluginKernel();
    await kernel.install(descriptor, { commandId: "install", expectedRevision: 0 });
    await expect(kernel.enable("fails", { commandId: "enable", expectedRevision: 1 }))
      .rejects.toMatchObject({ code: "ACTIVATION_FAILED" });
    expect(tracker.total()).toBe(0);
    expect(await kernel.inspect("fails")).toMatchObject({ state: "installed", lastStableState: "installed" });
    expect(await kernel.diagnostics()).toMatchObject({ activePlugins: [], tabKinds: [], services: [] });
  });

  it("enters failed when activation cleanup cannot restore the last stable state", async () => {
    const descriptor: InstalledPlugin = {
      manifest: manifest("cleanup-fails", []),
      async activate(context) {
        context.defer(() => { throw new Error("cleanup failed"); });
        throw new Error("activation failed");
      },
    };
    const kernel = new PluginKernel();
    await kernel.install(descriptor, { commandId: "install-cleanup-fails", expectedRevision: 0 });
    await expect(kernel.enable("cleanup-fails", { commandId: "enable-cleanup-fails", expectedRevision: 1 }))
      .rejects.toMatchObject({ code: "ACTIVATION_FAILED", details: { compensationFailed: true } });
    expect(await kernel.inspect("cleanup-fails")).toMatchObject({
      state: "failed",
      lastStableState: "installed",
      failure: { operation: "enable" },
    });
    expect(await kernel.diagnostics()).toMatchObject({ activePlugins: [], tabKinds: [], services: [] });
  });

  it("resolves typed services only from enabled dependencies and blocks their disable", async () => {
    const tracker = new ResourceTracker();
    const token = serviceToken<string>("test.message");
    const provider = plugin("provider", tracker, { provide: [token, "ready"] });
    const consumer = plugin("consumer", tracker, {
      dependencies: [{ id: "provider", range: "^1.0.0" }],
      require: token,
    });
    const kernel = new PluginKernel();
    const providerInstalled = await kernel.install(provider, { commandId: "install-provider", expectedRevision: 0 });
    const consumerInstalled = await kernel.install(consumer, { commandId: "install-consumer", expectedRevision: providerInstalled.revision });
    const providerHandle = await kernel.enable("provider", { commandId: "enable-provider", expectedRevision: consumerInstalled.revision });
    const consumerHandle = await kernel.enable("consumer", { commandId: "enable-consumer", expectedRevision: providerHandle.revision });
    await expect(kernel.disable("provider", { commandId: "disable-provider", expectedRevision: consumerHandle.revision }))
      .rejects.toMatchObject({ code: "PLUGIN_BLOCKED" });
    const disabledConsumer = await kernel.disable("consumer", { commandId: "disable-consumer", expectedRevision: consumerHandle.revision });
    await kernel.disable("provider", { commandId: "disable-provider-2", expectedRevision: disabledConsumer.revision });
    expect(tracker.total()).toBe(0);
  });

  it("rejects kind and service conflicts before any staged registration becomes visible", async () => {
    const tracker = new ResourceTracker();
    const token = serviceToken<string>("conflict.service");
    const first = plugin("first", tracker, { tabs: ["shared"], provide: [token, "first"] });
    const sameKind = plugin("same-kind", tracker, { tabs: ["shared"] });
    const sameService = plugin("same-service", tracker, { tabs: [], provide: [token, "second"] });
    const kernel = new PluginKernel();
    let revision = (await kernel.install(first, { commandId: "install-first", expectedRevision: 0 })).revision;
    revision = (await kernel.install(sameKind, { commandId: "install-same-kind", expectedRevision: revision })).revision;
    revision = (await kernel.install(sameService, { commandId: "install-same-service", expectedRevision: revision })).revision;
    revision = (await kernel.enable("first", { commandId: "enable-first", expectedRevision: revision })).revision;
    await expect(kernel.enable("same-kind", { commandId: "enable-same-kind", expectedRevision: revision }))
      .rejects.toMatchObject({ code: "DUPLICATE_KIND" });
    await expect(kernel.enable("same-service", { commandId: "enable-same-service", expectedRevision: revision }))
      .rejects.toMatchObject({ code: "ACTIVATION_FAILED" });
    expect(await kernel.inspect("same-service")).toMatchObject({ state: "installed" });
    expect(await kernel.diagnostics()).toMatchObject({ activePlugins: ["first"], tabKinds: ["shared"], services: ["conflict.service"] });
    await kernel.dispose();
    expect(tracker.total()).toBe(0);
  });

  it("serializes commands, deduplicates commandId and rejects stale revisions", async () => {
    const tracker = new ResourceTracker();
    const descriptor = plugin("serial", tracker);
    const kernel = new PluginKernel();
    const command = { commandId: "install-once", expectedRevision: 0 };
    const first = await kernel.install(descriptor, command);
    const duplicate = await kernel.install(descriptor, command);
    expect(duplicate).toEqual(first);
    await expect(kernel.enable("serial", { commandId: "stale", expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const other = plugin("other", tracker);
    await expect(kernel.install(other, command)).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });
  });

  it("reconciles crashes after each persisted boundary without replaying activation", async () => {
    const tracker = new ResourceTracker();
    const descriptor = plugin("crashy", tracker);
    const store = new MemoryCatalogStore();
    const first = new PluginKernel({ store, available: [descriptor] });
    await first.install(descriptor, { commandId: "install", expectedRevision: 0 });

    store.crashAfterSave(store.saveCount + 1);
    await expect(first.enable("crashy", { commandId: "enable-crash-prepared", expectedRevision: 1 }))
      .rejects.toBeInstanceOf(SimulatedProcessCrash);
    const afterPrepared = new PluginKernel({ store, available: [descriptor] });
    const reconciledPrepared = await afterPrepared.reconcile();
    expect(reconciledPrepared).toMatchObject({ revision: 2, journal: undefined });
    expect(reconciledPrepared.plugins.crashy.state).toBe("installed");
    expect(reconciledPrepared.commandResults["enable-crash-prepared"]).toMatchObject({ outcome: "reconciled", state: "installed" });

    store.crashAfterSave(store.saveCount + 2);
    await expect(afterPrepared.enable("crashy", { commandId: "enable-crash-effects", expectedRevision: 2 }))
      .rejects.toBeInstanceOf(SimulatedProcessCrash);
    const afterEffects = new PluginKernel({ store, available: [descriptor] });
    const reconciledEffects = await afterEffects.reconcile();
    expect(reconciledEffects.plugins.crashy.state).toBe("installed");
    expect(reconciledEffects.commandResults["enable-crash-effects"]).toMatchObject({ outcome: "reconciled", state: "installed" });
    expect(await afterEffects.diagnostics()).toMatchObject({ activePlugins: [], tabKinds: [], instances: [] });
    await first.dispose();
    await afterPrepared.dispose();
  });

  it("repairs failed state and only controlled-uninstalls after blockers are zero", async () => {
    const tracker = new ResourceTracker();
    const descriptor = plugin("failed", tracker);
    const failedRecord: CatalogPluginRecord = {
      manifest: descriptor.manifest,
      state: "failed",
      lastStableState: "installed",
      failure: { operation: "enable", message: "compensation failed", atRevision: 1 },
    };
    const initial: CatalogSnapshot = {
      ...emptyCatalog(),
      revision: 1,
      plugins: { failed: failedRecord },
    };
    let blocked = true;
    const store = new MemoryCatalogStore(initial);
    const kernel = new PluginKernel({
      store,
      available: [descriptor],
      blockers: async () => blocked ? [{ type: "resident-runtime", id: "runtime-1" }] : [],
    });
    await expect(kernel.controlledUninstall("failed", { commandId: "blocked", expectedRevision: 1 }))
      .rejects.toMatchObject({ code: "PLUGIN_BLOCKED" });
    blocked = false;
    const repaired = await kernel.repair("failed", { commandId: "repair", expectedRevision: 1 });
    expect(repaired.state).toBe("installed");

    const failedAgain: CatalogSnapshot = {
      ...await store.load(),
      revision: repaired.revision + 1,
      plugins: { failed: { ...failedRecord, failure: { ...failedRecord.failure!, atRevision: repaired.revision + 1 } } },
    };
    const secondStore = new MemoryCatalogStore(failedAgain);
    const second = new PluginKernel({ store: secondStore, available: [descriptor] });
    const removed = await second.controlledUninstall("failed", { commandId: "controlled", expectedRevision: failedAgain.revision });
    expect(removed.state).toBe("not-installed");
    expect(await second.inspect("failed")).toBeUndefined();
  });

  it("returns structured errors", () => {
    const error = new PluginKernelError("UNKNOWN_PLUGIN", "missing", { pluginId: "x" });
    expect(error).toMatchObject({ name: "PluginKernelError", code: "UNKNOWN_PLUGIN", details: { pluginId: "x" } });
  });
});
