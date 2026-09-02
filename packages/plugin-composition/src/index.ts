import {
  MemoryCatalogStore,
  PluginKernel,
  PluginKernelError,
  topologicalOrder,
  type CatalogSnapshot,
  type CatalogStore,
  type PluginBlockerProvider,
  type StateEnvelopeProvider,
} from "@tabverse/plugin-kernel";
import type {
  InstalledPlugin,
  PluginManifest,
  TabContribution,
  TabInstanceScope,
} from "@tabverse/tab-contracts";

export interface PluginCompositionOptions {
  readonly plugins: readonly InstalledPlugin[];
  readonly store?: CatalogStore;
  readonly blockers?: PluginBlockerProvider;
  readonly stateEnvelopes?: StateEnvelopeProvider;
}

export interface PluginCatalogItem {
  readonly manifest: PluginManifest;
  readonly state:
    | CatalogSnapshot["plugins"][string]["state"]
    | "not-installed";
  readonly failure?: CatalogSnapshot["plugins"][string]["failure"];
  readonly retainedState: boolean;
}

function canonicalManifest(manifest: PluginManifest): string {
  return JSON.stringify({
    apiVersion: manifest.apiVersion,
    builtIn: manifest.builtIn,
    dependencies: [...manifest.dependencies].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    enabledByDefault: manifest.enabledByDefault,
    id: manifest.id,
    tabs: [...manifest.tabs].sort(),
    version: manifest.version,
  });
}

function assertUniqueCatalog(plugins: readonly InstalledPlugin[]): void {
  const ids = new Set<string>();
  const kinds = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.manifest.id)) {
      throw new PluginKernelError(
        "DUPLICATE_PLUGIN",
        `duplicate composition plugin: ${plugin.manifest.id}`,
      );
    }
    ids.add(plugin.manifest.id);
    for (const kind of plugin.manifest.tabs) {
      if (kinds.has(kind)) {
        throw new PluginKernelError(
          "DUPLICATE_KIND",
          `duplicate composition tab kind: ${kind}`,
        );
      }
      kinds.add(kind);
    }
  }
}

/**
 * One application composition root around PluginKernel.
 *
 * The supplied descriptors are trusted, bundled plugins. Persistent catalog
 * state decides which installed plugins remain enabled; enabledByDefault is
 * applied only on a plugin's first install, so a user's explicit disable is
 * not undone on the next process start.
 */
export class PluginComposition {
  readonly #plugins: readonly InstalledPlugin[];
  readonly #kernel: PluginKernel;
  readonly #listeners = new Set<(snapshot: CatalogSnapshot) => void>();
  #startPromise: Promise<CatalogSnapshot> | undefined;
  #commandSequence = 0;
  #disposed = false;

  constructor(options: PluginCompositionOptions) {
    assertUniqueCatalog(options.plugins);
    this.#plugins = [...options.plugins];
    this.#kernel = new PluginKernel({
      available: this.#plugins,
      store: options.store ?? new MemoryCatalogStore(),
      blockers: options.blockers,
      stateEnvelopes: options.stateEnvelopes,
    });
  }

  get manifests(): readonly PluginManifest[] {
    return this.#plugins.map((plugin) => plugin.manifest);
  }

  start(): Promise<CatalogSnapshot> {
    if (this.#disposed) {
      return Promise.reject(new Error("plugin composition is disposed"));
    }
    this.#startPromise ??= this.#start().catch((error: unknown) => {
      this.#startPromise = undefined;
      throw error;
    });
    return this.#startPromise;
  }

  async createInstance(kind: string, tabId: string): Promise<TabInstanceScope> {
    await this.start();
    return this.#kernel.createInstance(kind, tabId);
  }

  /** Enabled Tab declarations; RemoteTabSet and future policy sets project from this list. */
  async tabContributions(): Promise<readonly TabContribution<unknown>[]> {
    await this.start();
    return this.#kernel.tabContributions();
  }

  /** All trusted bundled artifacts, including explicitly uninstalled ones. */
  async catalog(): Promise<readonly PluginCatalogItem[]> {
    const snapshot = await this.snapshot();
    return this.#plugins
      .map(({ manifest }) => {
        const record = snapshot.plugins[manifest.id];
        return {
          manifest,
          state: record?.state ?? "not-installed",
          failure: record?.failure,
          retainedState: snapshot.retainedState[manifest.id] !== undefined,
        };
      })
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }

  async snapshot(): Promise<CatalogSnapshot> {
    await this.start();
    return this.#kernel.snapshot();
  }

  subscribe(listener: (snapshot: CatalogSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async install(pluginId: string): Promise<CatalogSnapshot> {
    await this.start();
    const descriptor = this.#descriptor(pluginId);
    const snapshot = await this.#kernel.snapshot();
    await this.#kernel.install(descriptor, this.#command("install", pluginId, snapshot.revision));
    return await this.#publish();
  }

  async enable(pluginId: string): Promise<CatalogSnapshot> {
    await this.start();
    const snapshot = await this.#kernel.snapshot();
    await this.#kernel.enable(pluginId, this.#command("enable", pluginId, snapshot.revision));
    return await this.#publish();
  }

  async disable(pluginId: string): Promise<CatalogSnapshot> {
    await this.start();
    const snapshot = await this.#kernel.snapshot();
    await this.#kernel.disable(pluginId, this.#command("disable", pluginId, snapshot.revision));
    return await this.#publish();
  }

  async uninstall(pluginId: string): Promise<CatalogSnapshot> {
    await this.start();
    const snapshot = await this.#kernel.snapshot();
    await this.#kernel.uninstall(pluginId, this.#command("uninstall", pluginId, snapshot.revision));
    return await this.#publish();
  }

  async repair(pluginId: string): Promise<CatalogSnapshot> {
    await this.start();
    const snapshot = await this.#kernel.snapshot();
    await this.#kernel.repair(pluginId, this.#command("repair", pluginId, snapshot.revision));
    return await this.#publish();
  }

  async retry(pluginId: string): Promise<CatalogSnapshot> {
    await this.start();
    const snapshot = await this.#kernel.snapshot();
    await this.#kernel.retry(pluginId, this.#command("retry", pluginId, snapshot.revision));
    return await this.#publish();
  }

  async controlledUninstall(pluginId: string): Promise<CatalogSnapshot> {
    await this.start();
    const snapshot = await this.#kernel.snapshot();
    await this.#kernel.controlledUninstall(
      pluginId,
      this.#command("controlled-uninstall", pluginId, snapshot.revision),
    );
    return await this.#publish();
  }

  diagnostics() {
    return this.#kernel.diagnostics();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#kernel.dispose();
  }

  async #start(): Promise<CatalogSnapshot> {
    let snapshot = await this.#kernel.reconcile();
    for (const plugin of [...this.#plugins].sort((left, right) =>
      left.manifest.id.localeCompare(right.manifest.id),
    )) {
      const existing = snapshot.plugins[plugin.manifest.id];
      if (existing !== undefined) {
        if (canonicalManifest(existing.manifest) !== canonicalManifest(plugin.manifest)) {
          throw new PluginKernelError(
            "INVALID_MANIFEST",
            `installed manifest differs from bundled plugin: ${plugin.manifest.id}`,
            { installed: existing.manifest, bundled: plugin.manifest },
          );
        }
        continue;
      }
      // An uninstall leaves a retained-state tombstone. Do not silently
      // reverse the user's choice merely because the artifact is bundled.
      if (snapshot.retainedState[plugin.manifest.id] !== undefined) continue;
      const installCommandId =
        `composition.install:${plugin.manifest.id}:${plugin.manifest.version}`;
      const result = await this.#kernel.install(plugin, {
        commandId: installCommandId,
        expectedRevision: snapshot.revision,
      });
      snapshot = await this.#kernel.snapshot();
      if (snapshot.revision !== result.revision) {
        throw new Error(`catalog revision drift after installing ${plugin.manifest.id}`);
      }
    }

    await this.#kernel.bootstrap();

    const manifests = new Map(
      this.#plugins.map((plugin) => [plugin.manifest.id, plugin.manifest]),
    );
    for (const pluginId of topologicalOrder(manifests)) {
      const manifest = manifests.get(pluginId)!;
      snapshot = await this.#kernel.snapshot();
      const installCommandId =
        `composition.install:${pluginId}:${manifest.version}`;
      const installedByComposition =
        snapshot.commandResults[installCommandId]?.operation === "install";
      if (
        !manifest.enabledByDefault ||
        snapshot.plugins[pluginId]?.state !== "installed" ||
        !installedByComposition
      ) {
        continue;
      }
      await this.#kernel.enable(pluginId, {
        commandId: `composition.enable:${pluginId}:${manifest.version}:r${snapshot.revision}`,
        expectedRevision: snapshot.revision,
      });
    }
    return this.#publish();
  }

  #descriptor(pluginId: string): InstalledPlugin {
    const descriptor = this.#plugins.find((plugin) => plugin.manifest.id === pluginId);
    if (descriptor === undefined) {
      throw new PluginKernelError("UNKNOWN_PLUGIN", `unknown bundled plugin: ${pluginId}`);
    }
    return descriptor;
  }

  #command(operation: string, pluginId: string, expectedRevision: number) {
    this.#commandSequence += 1;
    return {
      commandId: `composition.${operation}:${pluginId}:r${expectedRevision}:c${this.#commandSequence}`,
      expectedRevision,
    };
  }

  async #publish(): Promise<CatalogSnapshot> {
    const snapshot = await this.#kernel.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
    return snapshot;
  }
}

export function createPluginComposition(
  options: PluginCompositionOptions,
): PluginComposition {
  return new PluginComposition(options);
}
