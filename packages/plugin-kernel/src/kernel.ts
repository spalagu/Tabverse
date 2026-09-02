import type {
  AsyncDisposable,
  CatalogCommand,
  InstalledPlugin,
  PluginContext,
  PluginHandle,
  PluginManifest,
  ServiceResolver,
  ServiceToken,
  StablePluginState,
  TabContribution,
  TabInstanceContext,
  TabInstanceScope,
} from "@tabverse/tab-contracts";
import {
  type CatalogCommandResult,
  type CatalogJournal,
  type CatalogOperation,
  type CatalogPluginRecord,
  type CatalogSnapshot,
  type CatalogStore,
  MemoryCatalogStore,
  SimulatedProcessCrash,
} from "./catalog";
import { AsyncDisposerStack } from "./disposable";
import { PluginKernelError, asError } from "./errors";
import { topologicalOrder, validateManifest } from "./graph";

interface OwnedValue<T> {
  readonly owner: string;
  readonly value: T;
}

function validateTabPresentation(pluginId: string, contribution: TabContribution<unknown>): void {
  const presentation = contribution.manifest.presentation;
  const invalid = (field: string): never => {
    throw new PluginKernelError(
      "INVALID_MANIFEST",
      `invalid Tab presentation ${field} for ${pluginId}:${contribution.manifest.kind}`,
    );
  };
  const requireText = (value: unknown, field: string): void => {
    if (typeof value !== "string" || value.trim().length === 0) invalid(field);
  };

  if (presentation === null || typeof presentation !== "object") invalid("presentation");
  requireText(presentation.label, "label");
  requireText(presentation.hint, "hint");
  requireText(presentation.icon, "icon");
  if (presentation.order !== undefined && !Number.isFinite(presentation.order)) invalid("order");
  if (presentation.groupLabel !== undefined) requireText(presentation.groupLabel, "groupLabel");
  if (presentation.launch !== undefined && presentation.launch !== "tab" && presentation.launch !== "dialog") {
    invalid("launch");
  }
  if (presentation.creation !== undefined) {
    const creation = presentation.creation;
    if (creation === null || typeof creation !== "object") invalid("creation");
    requireText(creation.field, "creation.field");
    requireText(creation.fieldLabel, "creation.fieldLabel");
    requireText(creation.placeholder, "creation.placeholder");
    requireText(creation.submitLabel, "creation.submitLabel");
    if (
      creation.defaultScheme !== undefined &&
      (typeof creation.defaultScheme !== "string" || !/^[a-z][a-z0-9+.-]*$/i.test(creation.defaultScheme))
    ) {
      invalid("creation.defaultScheme");
    }
  }
}

export interface PluginBlocker {
  readonly type: "tab-instance" | "remote-share" | "dependent-plugin" | "resident-runtime" | "artifact-slot" | "external";
  readonly id: string;
  readonly detail?: string;
}

export interface PluginBlockerContext {
  readonly manifest: PluginManifest;
  readonly tabContributions: readonly TabContribution<unknown>[];
}

export type PluginBlockerProvider = (
  pluginId: string,
  context: PluginBlockerContext,
) => Promise<readonly PluginBlocker[]>;

export interface StateEnvelopeProvider {
  capture(pluginId: string): Promise<unknown>;
}

export interface PluginKernelOptions {
  readonly apiVersion?: number;
  readonly store?: CatalogStore;
  readonly available?: readonly InstalledPlugin[];
  readonly blockers?: PluginBlockerProvider;
  readonly stateEnvelopes?: StateEnvelopeProvider;
}

export interface PluginKernelDiagnostics {
  readonly revision: number;
  readonly activePlugins: readonly string[];
  readonly tabKinds: readonly string[];
  readonly instances: readonly string[];
  readonly services: readonly string[];
  readonly journal: CatalogJournal | null;
}

class ActivationScope implements PluginContext {
  readonly #resources = new AsyncDisposerStack();
  readonly #services = new Map<string, unknown>();
  readonly #tabs = new Map<string, TabContribution<unknown>>();
  readonly #rootServices: ReadonlyMap<string, OwnedValue<unknown>>;

  constructor(
    readonly pluginId: string,
    rootServices: ReadonlyMap<string, OwnedValue<unknown>>,
  ) {
    this.#rootServices = rootServices;
  }

  get disposed(): boolean {
    return this.#resources.disposed;
  }

  defer(value: (() => void | Promise<void>) | AsyncDisposable): void {
    this.#resources.defer(value);
  }

  dispose(): Promise<void> {
    return this.#resources.dispose();
  }

  get<T>(token: ServiceToken<T>): T {
    if (this.#services.has(token.id)) return this.#services.get(token.id) as T;
    const entry = this.#rootServices.get(token.id);
    if (!entry) throw new PluginKernelError("UNKNOWN_SERVICE", `unknown service: ${token.id}`);
    return entry.value as T;
  }

  optional<T>(token: ServiceToken<T>): T | undefined {
    if (this.#services.has(token.id)) return this.#services.get(token.id) as T;
    return this.#rootServices.get(token.id)?.value as T | undefined;
  }

  provide<T>(token: ServiceToken<T>, value: T): void {
    if (this.#services.has(token.id)) {
      throw new PluginKernelError("DUPLICATE_SERVICE", `plugin ${this.pluginId} provides ${token.id} twice`);
    }
    this.#services.set(token.id, value);
  }

  contributeTab<State>(contribution: TabContribution<State>): void {
    validateTabPresentation(this.pluginId, contribution as TabContribution<unknown>);
    const kind = contribution.manifest.kind;
    if (this.#tabs.has(kind)) {
      throw new PluginKernelError("DUPLICATE_KIND", `plugin ${this.pluginId} contributes ${kind} twice`);
    }
    this.#tabs.set(kind, contribution as TabContribution<unknown>);
  }

  validate(manifest: PluginManifest, rootTabs: ReadonlyMap<string, OwnedValue<TabContribution<unknown>>>): void {
    const actualKinds = [...this.#tabs.keys()].sort();
    const declaredKinds = [...manifest.tabs].sort();
    if (JSON.stringify(actualKinds) !== JSON.stringify(declaredKinds)) {
      throw new PluginKernelError("INVALID_MANIFEST", `tab contributions do not match manifest for ${manifest.id}`, {
        declaredKinds,
        actualKinds,
      });
    }
    for (const id of this.#services.keys()) {
      const existing = this.#rootServices.get(id);
      if (existing) throw new PluginKernelError("DUPLICATE_SERVICE", `service ${id} already owned by ${existing.owner}`);
    }
    for (const kind of this.#tabs.keys()) {
      const existing = rootTabs.get(kind);
      if (existing) throw new PluginKernelError("DUPLICATE_KIND", `tab kind ${kind} already owned by ${existing.owner}`);
    }
  }

  commit(
    rootServices: Map<string, OwnedValue<unknown>>,
    rootTabs: Map<string, OwnedValue<TabContribution<unknown>>>,
  ): void {
    for (const [id, value] of this.#services) rootServices.set(id, { owner: this.pluginId, value });
    for (const [kind, value] of this.#tabs) rootTabs.set(kind, { owner: this.pluginId, value });
  }

  async disposeResources(): Promise<void> {
    await this.#resources.dispose();
  }
}

class RuntimePlugin {
  constructor(
    readonly pluginId: string,
    readonly revision: number,
    readonly scope: ActivationScope,
  ) {}
}

class InstanceScope implements TabInstanceScope {
  readonly #resources = new AsyncDisposerStack();
  readonly #resolver: ServiceResolver;
  #onDisposed: (() => void) | undefined;

  constructor(
    readonly tabId: string,
    readonly kind: string,
    readonly pluginId: string,
    readonly contribution: TabContribution<unknown>,
    resolver: ServiceResolver,
    onDisposed: () => void,
  ) {
    this.#resolver = resolver;
    this.#onDisposed = onDisposed;
  }

  get disposed(): boolean {
    return this.#resources.disposed;
  }

  defer(value: (() => void | Promise<void>) | AsyncDisposable): void {
    this.#resources.defer(value);
  }

  get<T>(token: ServiceToken<T>): T {
    return this.#resolver.get(token);
  }

  optional<T>(token: ServiceToken<T>): T | undefined {
    return this.#resolver.optional(token);
  }

  async dispose(): Promise<void> {
    try {
      await this.#resources.dispose();
    } finally {
      this.#onDisposed?.();
      this.#onDisposed = undefined;
    }
  }
}

const transientByOperation: Readonly<Record<Exclude<CatalogOperation, "repair" | "retry" | "controlled-uninstall">, CatalogJournal["transientState"]>> = {
  install: "installing",
  enable: "enabling",
  disable: "disabling",
  uninstall: "uninstalling",
};

export class PluginKernel implements AsyncDisposable {
  readonly #apiVersion: number;
  readonly #store: CatalogStore;
  readonly #available = new Map<string, InstalledPlugin>();
  readonly #active = new Map<string, RuntimePlugin>();
  readonly #services = new Map<string, OwnedValue<unknown>>();
  readonly #tabs = new Map<string, OwnedValue<TabContribution<unknown>>>();
  readonly #instances = new Map<string, InstanceScope>();
  readonly #acceptingInstances = new Set<string>();
  readonly #blockerProvider: PluginBlockerProvider;
  readonly #stateEnvelopes: StateEnvelopeProvider;
  #tail: Promise<void> = Promise.resolve();
  #handleSequence = 0;
  #disposed = false;

  constructor(options: PluginKernelOptions = {}) {
    this.#apiVersion = options.apiVersion ?? 1;
    this.#store = options.store ?? new MemoryCatalogStore();
    this.#blockerProvider = options.blockers ?? (async () => []);
    this.#stateEnvelopes = options.stateEnvelopes ?? { capture: async () => null };
    for (const descriptor of options.available ?? []) this.registerAvailable(descriptor);
  }

  registerAvailable(descriptor: InstalledPlugin): void {
    this.#assertOpen();
    validateManifest(descriptor.manifest, this.#apiVersion);
    const existing = this.#available.get(descriptor.manifest.id);
    if (existing && existing !== descriptor) {
      throw new PluginKernelError("DUPLICATE_PLUGIN", `duplicate available plugin: ${descriptor.manifest.id}`);
    }
    this.#available.set(descriptor.manifest.id, descriptor);
  }

  install(descriptor: InstalledPlugin, command: CatalogCommand): Promise<CatalogCommandResult> {
    this.registerAvailable(descriptor);
    return this.#serial(async () => {
      const manifest = descriptor.manifest;
      let snapshot = await this.#prepareCommand(command, manifest.id, "install");
      const duplicate = snapshot.commandResults[command.commandId];
      if (duplicate) return duplicate;
      if (snapshot.plugins[manifest.id]) {
        throw new PluginKernelError("DUPLICATE_PLUGIN", `plugin already installed: ${manifest.id}`);
      }
      const journal = this.#journal(command, manifest.id, "install", "not-installed", "installed");
      snapshot = {
        ...snapshot,
        plugins: { ...snapshot.plugins, [manifest.id]: { manifest, state: "installing", lastStableState: "not-installed" } },
        journal,
      };
      await this.#store.save(snapshot);
      return this.#commit(snapshot, journal, { manifest, state: "installed", lastStableState: "installed" });
    });
  }

  enable(pluginId: string, command: CatalogCommand): Promise<PluginHandle> {
    return this.#serial(async () => {
      let snapshot = await this.#prepareCommand(command, pluginId, "enable");
      const duplicate = snapshot.commandResults[command.commandId];
      if (duplicate) {
        if (duplicate.state !== "enabled" || duplicate.outcome !== "committed") {
          throw new PluginKernelError("ACTIVATION_FAILED", `enable command ${command.commandId} was reconciled to ${duplicate.state}`, { result: duplicate });
        }
        return this.#handle(pluginId, duplicate.revision);
      }
      const record = this.#record(snapshot, pluginId);
      if (record.state !== "installed" && record.state !== "disabled") {
        throw this.#transitionError(pluginId, record.state, "enable");
      }
      this.#validateEnableGraph(snapshot, pluginId);
      const journal = this.#journal(command, pluginId, "enable", record.state, "enabled", record);
      snapshot = this.#withTransient(snapshot, journal, record);
      await this.#store.save(snapshot);
      try {
        await this.#activate(this.#descriptor(pluginId), snapshot.revision + 1);
        const applied = { ...snapshot, journal: { ...journal, phase: "effects-applied" as const } };
        await this.#store.save(applied);
        const result = await this.#commit(applied, applied.journal, { ...record, state: "enabled", lastStableState: "enabled", failure: undefined });
        this.#acceptingInstances.add(pluginId);
        return this.#handle(pluginId, result.revision);
      } catch (error) {
        if (error instanceof SimulatedProcessCrash) throw error;
        return this.#activationFailure(snapshot, journal, record, error);
      }
    });
  }

  disable(pluginId: string, command: CatalogCommand): Promise<CatalogCommandResult> {
    return this.#serial(async () => {
      let snapshot = await this.#prepareCommand(command, pluginId, "disable");
      const duplicate = snapshot.commandResults[command.commandId];
      if (duplicate) return duplicate;
      const record = this.#record(snapshot, pluginId);
      if (record.state !== "enabled") throw this.#transitionError(pluginId, record.state, "disable");
      this.#acceptingInstances.delete(pluginId);
      const blockers = await this.#blockers(snapshot, pluginId);
      if (blockers.length > 0) {
        this.#acceptingInstances.add(pluginId);
        throw new PluginKernelError("PLUGIN_BLOCKED", `plugin ${pluginId} cannot be disabled`, { blockers });
      }
      const journal = this.#journal(command, pluginId, "disable", "enabled", "disabled", record);
      snapshot = this.#withTransient(snapshot, journal, record);
      await this.#store.save(snapshot);
      try {
        await this.#deactivate(pluginId);
        const applied = { ...snapshot, journal: { ...journal, phase: "effects-applied" as const } };
        await this.#store.save(applied);
        return this.#commit(applied, applied.journal, { ...record, state: "disabled", lastStableState: "disabled", failure: undefined });
      } catch (error) {
        if (error instanceof SimulatedProcessCrash) throw error;
        let compensationError: unknown;
        try {
          await this.#activate(this.#descriptor(pluginId), snapshot.revision);
          this.#acceptingInstances.add(pluginId);
        } catch (restoreError) {
          compensationError = restoreError;
        }
        if (compensationError === undefined) {
          await this.#commit(snapshot, journal, { ...record, state: "enabled", lastStableState: "enabled" });
        } else {
          await this.#commit(snapshot, journal, {
            ...record,
            state: "failed",
            lastStableState: "enabled",
            failure: {
              operation: "disable",
              message: asError(compensationError).message,
              atRevision: snapshot.revision + 1,
            },
          });
        }
        throw new PluginKernelError("DISPOSAL_FAILED", `plugin disable failed: ${pluginId}`, {
          compensationFailed: compensationError !== undefined,
        }, { cause: asError(error) });
      }
    });
  }

  uninstall(pluginId: string, command: CatalogCommand): Promise<CatalogCommandResult> {
    return this.#uninstall(pluginId, command, false);
  }

  controlledUninstall(pluginId: string, command: CatalogCommand): Promise<CatalogCommandResult> {
    return this.#uninstall(pluginId, command, true);
  }

  repair(pluginId: string, command: CatalogCommand): Promise<CatalogCommandResult> {
    return this.#recover(pluginId, command, false);
  }

  retry(pluginId: string, command: CatalogCommand): Promise<CatalogCommandResult> {
    return this.#recover(pluginId, command, true);
  }

  async createInstance(kind: string, tabId: string): Promise<TabInstanceScope> {
    this.#assertOpen();
    if (this.#instances.has(tabId)) {
      throw new PluginKernelError("DUPLICATE_TAB_INSTANCE", `duplicate tab instance: ${tabId}`);
    }
    const entry = this.#tabs.get(kind);
    if (!entry) throw new PluginKernelError("UNKNOWN_TAB_KIND", `unknown tab kind: ${kind}`);
    if (!this.#acceptingInstances.has(entry.owner)) {
      throw new PluginKernelError("PLUGIN_NOT_ENABLED", `plugin is not accepting instances: ${entry.owner}`);
    }
    for (const token of entry.value.view.requiredServices) this.#get(token);
    const instance = new InstanceScope(tabId, kind, entry.owner, entry.value, this.#resolver(), () => {
      this.#instances.delete(tabId);
    });
    this.#instances.set(tabId, instance);
    try {
      const activated = await entry.value.activate?.(instance as TabInstanceContext);
      if (activated) instance.defer(activated);
      return instance;
    } catch (error) {
      await instance.dispose();
      throw new PluginKernelError("ACTIVATION_FAILED", `tab instance activation failed: ${tabId}`, { kind, pluginId: entry.owner }, { cause: asError(error) });
    }
  }

  /** Enabled contributions, exposed read-only for dynamic cross-cutting sets. */
  tabContributions(): readonly TabContribution<unknown>[] {
    this.#assertOpen();
    return [...this.#tabs.values()]
      .map((entry) => entry.value)
      .sort((left, right) =>
        left.manifest.kind.localeCompare(right.manifest.kind),
      );
  }

  inspect(pluginId: string): Promise<CatalogPluginRecord | undefined> {
    return this.#serial(async () => (await this.#store.load()).plugins[pluginId]);
  }

  snapshot(): Promise<CatalogSnapshot> {
    return this.#serial(async () => this.#store.load());
  }

  reconcile(): Promise<CatalogSnapshot> {
    return this.#serial(async () => this.#reconcileLocked());
  }

  bootstrap(): Promise<CatalogSnapshot> {
    return this.#serial(async () => {
      const snapshot = await this.#reconcileLocked();
      const manifests = new Map(Object.values(snapshot.plugins).map((record) => [record.manifest.id, record.manifest]));
      const activated: string[] = [];
      try {
        for (const pluginId of topologicalOrder(manifests)) {
          if (snapshot.plugins[pluginId]?.state !== "enabled" || this.#active.has(pluginId)) continue;
          await this.#activate(this.#descriptor(pluginId), snapshot.revision);
          this.#acceptingInstances.add(pluginId);
          activated.push(pluginId);
        }
      } catch (error) {
        const rollbackErrors: Error[] = [];
        for (const pluginId of activated.reverse()) {
          try { await this.#deactivate(pluginId); } catch (rollbackError) { rollbackErrors.push(asError(rollbackError)); }
        }
        if (rollbackErrors.length > 0) {
          throw new PluginKernelError("DISPOSAL_FAILED", "bootstrap rollback failed", {
            activationError: asError(error).message,
            rollbackErrors: rollbackErrors.map((rollbackError) => rollbackError.message),
          }, { cause: new AggregateError([asError(error), ...rollbackErrors]) });
        }
        throw new PluginKernelError("ACTIVATION_FAILED", "plugin bootstrap failed atomically", {}, { cause: asError(error) });
      }
      return snapshot;
    });
  }

  async diagnostics(): Promise<PluginKernelDiagnostics> {
    const snapshot = await this.#store.load();
    return {
      revision: snapshot.revision,
      activePlugins: [...this.#active.keys()].sort(),
      tabKinds: [...this.#tabs.keys()].sort(),
      instances: [...this.#instances.keys()].sort(),
      services: [...this.#services.keys()].sort(),
      journal: snapshot.journal ?? null,
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: Error[] = [];
    for (const instance of [...this.#instances.values()]) {
      try { await instance.dispose(); } catch (error) { errors.push(asError(error)); }
    }
    for (const pluginId of [...this.#active.keys()].reverse()) {
      try { await this.#deactivate(pluginId); } catch (error) { errors.push(asError(error)); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "plugin kernel disposal failed");
  }

  #uninstall(pluginId: string, command: CatalogCommand, controlled: boolean): Promise<CatalogCommandResult> {
    return this.#serial(async () => {
      const operation: CatalogOperation = controlled ? "controlled-uninstall" : "uninstall";
      let snapshot = await this.#prepareCommand(command, pluginId, operation);
      const duplicate = snapshot.commandResults[command.commandId];
      if (duplicate) return duplicate;
      const record = this.#record(snapshot, pluginId);
      if (controlled ? record.state !== "failed" : record.state !== "installed" && record.state !== "disabled") {
        throw this.#transitionError(pluginId, record.state, operation);
      }
      const blockers = await this.#blockers(snapshot, pluginId);
      if (blockers.length > 0) throw new PluginKernelError("PLUGIN_BLOCKED", `plugin ${pluginId} cannot be uninstalled`, { blockers });
      const lastStable: StablePluginState = record.state === "failed"
        ? record.lastStableState
        : record.state as "installed" | "disabled";
      const journal = this.#journal(command, pluginId, operation, lastStable, "not-installed", record, "uninstalling");
      snapshot = this.#withTransient(snapshot, journal, record);
      await this.#store.save(snapshot);
      try {
        const payload = await this.#stateEnvelopes.capture(pluginId);
        const applied: CatalogSnapshot = {
          ...snapshot,
          journal: { ...journal, phase: "effects-applied" },
          retainedState: {
            ...snapshot.retainedState,
            [pluginId]: {
              pluginId,
              pluginVersion: record.manifest.version,
              catalogRevision: snapshot.revision + 1,
              payload,
            },
          },
        };
        await this.#store.save(applied);
        return this.#commit(applied, journal, undefined);
      } catch (error) {
        if (error instanceof SimulatedProcessCrash) throw error;
        return this.#failedOrRestored(snapshot, journal, record, error);
      }
    });
  }

  #recover(pluginId: string, command: CatalogCommand, retry: boolean): Promise<CatalogCommandResult> {
    return this.#serial(async () => {
      const operation: CatalogOperation = retry ? "retry" : "repair";
      let snapshot = await this.#prepareCommand(command, pluginId, operation);
      const duplicate = snapshot.commandResults[command.commandId];
      if (duplicate) return duplicate;
      const record = this.#record(snapshot, pluginId);
      if (record.state !== "failed" || !record.failure) throw this.#transitionError(pluginId, record.state, operation);
      const blockers = await this.#blockers(snapshot, pluginId);
      if (blockers.length > 0) throw new PluginKernelError("PLUGIN_BLOCKED", `plugin ${pluginId} recovery is blocked`, { blockers });
      const original = record.failure.operation;
      const target = retry ? this.#retryTarget(original, record.lastStableState) : record.lastStableState;
      const transientState = target === "not-installed"
        ? "uninstalling"
        : target === "enabled"
          ? "enabling"
          : "disabling";
      const journal: CatalogJournal = {
        command,
        pluginId,
        operation,
        targetState: target,
        transientState,
        lastStableState: record.lastStableState,
        phase: "prepared",
        previousRecord: record,
      };
      snapshot = this.#withTransient(snapshot, journal, record);
      await this.#store.save(snapshot);
      try {
        await this.#deactivate(pluginId);
        if (target === "enabled") {
          this.#validateEnableGraph({
            ...snapshot,
            plugins: { ...snapshot.plugins, [pluginId]: { ...record, state: record.lastStableState } },
          }, pluginId);
          await this.#activate(this.#descriptor(pluginId), snapshot.revision + 1);
          this.#acceptingInstances.add(pluginId);
        }
        let applied: CatalogSnapshot = { ...snapshot, journal: { ...journal, phase: "effects-applied" } };
        if (retry && original === "uninstall") {
          const payload = await this.#stateEnvelopes.capture(pluginId);
          applied = {
            ...applied,
            retainedState: {
              ...applied.retainedState,
              [pluginId]: {
                pluginId,
                pluginVersion: record.manifest.version,
                catalogRevision: snapshot.revision + 1,
                payload,
              },
            },
          };
        }
        await this.#store.save(applied);
        if (target === "not-installed") return this.#commit(applied, journal, undefined);
        return this.#commit(applied, journal, {
          ...record,
          state: target,
          lastStableState: target,
          failure: undefined,
        });
      } catch (error) {
        if (error instanceof SimulatedProcessCrash) throw error;
        const failed: CatalogPluginRecord = {
          ...record,
          state: "failed",
          failure: { operation: original, message: asError(error).message, atRevision: snapshot.revision + 1 },
        };
        await this.#commit(snapshot, journal, failed);
        throw new PluginKernelError("DISPOSAL_FAILED", `plugin recovery failed: ${pluginId}/${operation}`, {}, { cause: asError(error) });
      }
    });
  }

  #retryTarget(operation: CatalogOperation, lastStableState: StablePluginState): StablePluginState {
    switch (operation) {
      case "install": return "installed";
      case "enable": return "enabled";
      case "disable": return "disabled";
      case "uninstall":
      case "controlled-uninstall": return "not-installed";
      case "repair":
      case "retry": return lastStableState;
    }
  }

  async #prepareCommand(command: CatalogCommand, pluginId: string, operation: CatalogOperation): Promise<CatalogSnapshot> {
    this.#assertOpen();
    if (!command.commandId.trim()) throw new PluginKernelError("COMMAND_CONFLICT", "commandId must not be empty");
    let snapshot = await this.#store.load();
    if (snapshot.schema !== "tabverse-plugin-catalog/v1") throw new PluginKernelError("CATALOG_CORRUPT", "unsupported catalog schema");
    if (snapshot.journal) snapshot = await this.#reconcileSnapshot(snapshot);
    const previous = snapshot.commandResults[command.commandId];
    if (previous) {
      if (previous.pluginId !== pluginId || previous.operation !== operation) {
        throw new PluginKernelError("COMMAND_CONFLICT", `commandId ${command.commandId} was used for another command`, { previous });
      }
      return snapshot;
    }
    if (snapshot.revision !== command.expectedRevision) {
      throw new PluginKernelError("REVISION_CONFLICT", `catalog revision conflict for ${command.commandId}`, {
        expected: command.expectedRevision,
        actual: snapshot.revision,
      });
    }
    return snapshot;
  }

  #journal(
    command: CatalogCommand,
    pluginId: string,
    operation: CatalogOperation,
    lastStableState: StablePluginState,
    targetState: StablePluginState,
    previousRecord?: CatalogPluginRecord,
    transientState?: CatalogJournal["transientState"],
  ): CatalogJournal {
    const basic = operation === "controlled-uninstall" ? "uninstall" : operation;
    if (basic === "repair" || basic === "retry") throw new PluginKernelError("INVALID_STATE_TRANSITION", `operation ${operation} requires a recovery path`);
    return {
      command,
      pluginId,
      operation,
      lastStableState,
      targetState,
      transientState: transientState ?? transientByOperation[basic],
      phase: "prepared",
      previousRecord,
    };
  }

  #withTransient(snapshot: CatalogSnapshot, journal: CatalogJournal, record: CatalogPluginRecord): CatalogSnapshot {
    return {
      ...snapshot,
      plugins: { ...snapshot.plugins, [journal.pluginId]: { ...record, state: journal.transientState } },
      journal,
    };
  }

  async #commit(snapshot: CatalogSnapshot, journal: CatalogJournal, record: CatalogPluginRecord | undefined): Promise<CatalogCommandResult> {
    const revision = snapshot.revision + 1;
    const result: CatalogCommandResult = {
      commandId: journal.command.commandId,
      pluginId: journal.pluginId,
      operation: journal.operation,
      revision,
      state: record?.state ?? "not-installed",
      outcome: "committed",
    };
    const plugins = { ...snapshot.plugins };
    if (record) plugins[journal.pluginId] = record;
    else delete plugins[journal.pluginId];
    const committed: CatalogSnapshot = {
      ...snapshot,
      revision,
      plugins,
      journal: undefined,
      commandResults: { ...snapshot.commandResults, [result.commandId]: result },
    };
    await this.#store.save(committed);
    return result;
  }

  async #activationFailure(
    snapshot: CatalogSnapshot,
    journal: CatalogJournal,
    record: CatalogPluginRecord,
    activationError: unknown,
  ): Promise<never> {
    const compensationFailed = activationError instanceof PluginKernelError && activationError.details.cleanupFailed === true;
    if (!compensationFailed) {
      await this.#commit(snapshot, journal, { ...record, state: journal.lastStableState, lastStableState: journal.lastStableState });
    } else {
      await this.#commit(snapshot, journal, {
        ...record,
        state: "failed",
        lastStableState: journal.lastStableState,
        failure: { operation: journal.operation, message: asError(activationError).message, atRevision: snapshot.revision + 1 },
      });
    }
    throw new PluginKernelError("ACTIVATION_FAILED", `plugin activation failed: ${journal.pluginId}`, {
      compensationFailed,
    }, { cause: asError(activationError) });
  }

  async #failedOrRestored(
    snapshot: CatalogSnapshot,
    journal: CatalogJournal,
    record: CatalogPluginRecord,
    error: unknown,
  ): Promise<never> {
    const restored = { ...record, state: journal.lastStableState, lastStableState: journal.lastStableState } as CatalogPluginRecord;
    try {
      await this.#commit(snapshot, journal, restored);
    } catch (compensationError) {
      await this.#commit(snapshot, journal, {
        ...record,
        state: "failed",
        lastStableState: journal.lastStableState,
        failure: { operation: journal.operation, message: asError(compensationError).message, atRevision: snapshot.revision + 1 },
      });
    }
    throw new PluginKernelError("DISPOSAL_FAILED", `plugin operation failed: ${journal.pluginId}/${journal.operation}`, {}, { cause: asError(error) });
  }

  async #reconcileLocked(): Promise<CatalogSnapshot> {
    return this.#reconcileSnapshot(await this.#store.load());
  }

  async #reconcileSnapshot(snapshot: CatalogSnapshot): Promise<CatalogSnapshot> {
    const journal = snapshot.journal;
    if (!journal) return snapshot;
    const plugins = { ...snapshot.plugins };
    if (journal.lastStableState === "not-installed") delete plugins[journal.pluginId];
    else if (journal.previousRecord) {
      plugins[journal.pluginId] = {
        ...journal.previousRecord,
        state: journal.lastStableState,
        lastStableState: journal.lastStableState,
      };
    } else {
      throw new PluginKernelError("CATALOG_CORRUPT", `journal lacks previous record for ${journal.pluginId}`);
    }
    const revision = snapshot.revision + 1;
    const result: CatalogCommandResult = {
      commandId: journal.command.commandId,
      pluginId: journal.pluginId,
      operation: journal.operation,
      revision,
      state: journal.lastStableState,
      outcome: "reconciled",
    };
    const reconciled: CatalogSnapshot = {
      ...snapshot,
      revision,
      plugins,
      journal: undefined,
      commandResults: { ...snapshot.commandResults, [result.commandId]: result },
    };
    await this.#store.save(reconciled);
    return reconciled;
  }

  async #activate(descriptor: InstalledPlugin, revision: number): Promise<void> {
    const pluginId = descriptor.manifest.id;
    if (this.#active.has(pluginId)) return;
    const scope = new ActivationScope(pluginId, this.#services);
    try {
      const disposable = await descriptor.activate(scope);
      if (disposable) scope.defer(disposable);
      scope.validate(descriptor.manifest, this.#tabs);
      scope.commit(this.#services, this.#tabs);
      this.#active.set(pluginId, new RuntimePlugin(pluginId, revision, scope));
    } catch (error) {
      try {
        await scope.disposeResources();
      } catch (cleanupError) {
        throw new PluginKernelError("ACTIVATION_FAILED", `plugin activation cleanup failed: ${pluginId}`, {
          cleanupFailed: true,
          activationError: asError(error).message,
          cleanupError: asError(cleanupError).message,
        }, { cause: new AggregateError([asError(error), asError(cleanupError)]) });
      }
      throw error;
    }
  }

  async #deactivate(pluginId: string): Promise<void> {
    const active = this.#active.get(pluginId);
    if (!active) return;
    let disposalError: unknown;
    try {
      await active.scope.disposeResources();
    } catch (error) {
      disposalError = error;
    } finally {
      for (const [id, value] of this.#services) if (value.owner === pluginId) this.#services.delete(id);
      for (const [kind, value] of this.#tabs) if (value.owner === pluginId) this.#tabs.delete(kind);
      this.#active.delete(pluginId);
      this.#acceptingInstances.delete(pluginId);
    }
    if (disposalError !== undefined) throw disposalError;
  }

  #validateEnableGraph(snapshot: CatalogSnapshot, pluginId: string): void {
    const manifests = new Map(Object.values(snapshot.plugins).map((record) => [record.manifest.id, record.manifest]));
    topologicalOrder(manifests);
    const record = this.#record(snapshot, pluginId);
    for (const dependency of record.manifest.dependencies) {
      if (snapshot.plugins[dependency.id]?.state !== "enabled") {
        throw new PluginKernelError("DEPENDENCY_NOT_ENABLED", `dependency ${dependency.id} must be enabled before ${pluginId}`);
      }
    }
    const enabledKinds = new Map<string, string>();
    for (const candidate of Object.values(snapshot.plugins)) {
      if (candidate.manifest.id !== pluginId && candidate.state !== "enabled") continue;
      for (const kind of candidate.manifest.tabs) {
        const owner = enabledKinds.get(kind);
        if (owner) throw new PluginKernelError("DUPLICATE_KIND", `tab kind ${kind} declared by ${owner} and ${candidate.manifest.id}`);
        enabledKinds.set(kind, candidate.manifest.id);
      }
    }
  }

  async #blockers(snapshot: CatalogSnapshot, pluginId: string): Promise<readonly PluginBlocker[]> {
    const blockers: PluginBlocker[] = [];
    for (const instance of this.#instances.values()) {
      if (instance.pluginId === pluginId) blockers.push({ type: "tab-instance", id: instance.tabId });
    }
    for (const record of Object.values(snapshot.plugins)) {
      if (record.state === "enabled" && record.manifest.dependencies.some((dependency) => dependency.id === pluginId)) {
        blockers.push({ type: "dependent-plugin", id: record.manifest.id });
      }
    }
    blockers.push(...await this.#blockerProvider(pluginId, {
      manifest: this.#record(snapshot, pluginId).manifest,
      tabContributions: [...this.#tabs.values()]
        .filter((entry) => entry.owner === pluginId)
        .map((entry) => entry.value),
    }));
    return blockers.sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  }

  #resolver(): ServiceResolver {
    return { get: <T>(token: ServiceToken<T>) => this.#get(token), optional: <T>(token: ServiceToken<T>) => this.#services.get(token.id)?.value as T | undefined };
  }

  #get<T>(token: ServiceToken<T>): T {
    const entry = this.#services.get(token.id);
    if (!entry) throw new PluginKernelError("UNKNOWN_SERVICE", `unknown service: ${token.id}`);
    return entry.value as T;
  }

  #record(snapshot: CatalogSnapshot, pluginId: string): CatalogPluginRecord {
    const record = snapshot.plugins[pluginId];
    if (!record) throw new PluginKernelError("UNKNOWN_PLUGIN", `unknown plugin: ${pluginId}`);
    return record;
  }

  #descriptor(pluginId: string): InstalledPlugin {
    const descriptor = this.#available.get(pluginId);
    if (!descriptor) throw new PluginKernelError("UNKNOWN_PLUGIN", `plugin artifact is unavailable: ${pluginId}`);
    return descriptor;
  }

  #handle(pluginId: string, revision: number): PluginHandle {
    let disposed = false;
    const sequence = ++this.#handleSequence;
    return {
      pluginId,
      revision,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        const snapshot = await this.#store.load();
        if (snapshot.plugins[pluginId]?.state !== "enabled") return;
        await this.disable(pluginId, { commandId: `handle:${pluginId}:${sequence}`, expectedRevision: snapshot.revision });
      },
    };
  }

  #transitionError(pluginId: string, state: string, operation: string): PluginKernelError {
    return new PluginKernelError("INVALID_STATE_TRANSITION", `${operation} is not allowed for ${pluginId} in ${state}`);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new PluginKernelError("INVALID_STATE_TRANSITION", "plugin kernel is disposed");
  }
}
