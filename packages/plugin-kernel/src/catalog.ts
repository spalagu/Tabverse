import type {
  CatalogCommand,
  PluginManifest,
  PluginState,
  StablePluginState,
} from "@tabverse/tab-contracts";
import { PluginKernelError } from "./errors";

export type CatalogOperation =
  | "install"
  | "enable"
  | "disable"
  | "uninstall"
  | "repair"
  | "retry"
  | "controlled-uninstall";

export interface PluginFailure {
  readonly operation: CatalogOperation;
  readonly message: string;
  readonly atRevision: number;
}

export interface CatalogPluginRecord {
  readonly manifest: PluginManifest;
  readonly state: PluginState;
  readonly lastStableState: StablePluginState;
  readonly failure?: PluginFailure;
}

export interface CatalogJournal {
  readonly command: CatalogCommand;
  readonly pluginId: string;
  readonly operation: CatalogOperation;
  readonly targetState: StablePluginState;
  readonly transientState: Extract<PluginState, "installing" | "enabling" | "disabling" | "uninstalling">;
  readonly lastStableState: StablePluginState;
  readonly phase: "prepared" | "effects-applied";
  readonly previousRecord?: CatalogPluginRecord;
}

export interface CatalogCommandResult {
  readonly commandId: string;
  readonly pluginId: string;
  readonly operation: CatalogOperation;
  readonly revision: number;
  readonly state: PluginState;
  readonly outcome: "committed" | "reconciled";
}

export interface RetainedStateEnvelope {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly catalogRevision: number;
  readonly payload: unknown;
}

export interface CatalogSnapshot {
  readonly schema: "tabverse-plugin-catalog/v1";
  readonly revision: number;
  readonly plugins: Readonly<Record<string, CatalogPluginRecord>>;
  readonly journal?: CatalogJournal;
  readonly commandResults: Readonly<Record<string, CatalogCommandResult>>;
  readonly retainedState: Readonly<Record<string, RetainedStateEnvelope>>;
}

export interface CatalogStore {
  load(): Promise<CatalogSnapshot>;
  save(snapshot: CatalogSnapshot): Promise<void>;
}

export interface AtomicCatalogStorage {
  read(): Promise<string | null>;
  writeAtomic(contents: string): Promise<void>;
}

export function emptyCatalog(): CatalogSnapshot {
  return {
    schema: "tabverse-plugin-catalog/v1",
    revision: 0,
    plugins: {},
    commandResults: {},
    retainedState: {},
  };
}

export function cloneCatalog(snapshot: CatalogSnapshot): CatalogSnapshot {
  return structuredClone(snapshot);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const pluginStates = new Set<PluginState>([
  "not-installed", "installing", "installed", "enabling", "enabled",
  "disabling", "disabled", "uninstalling", "failed",
]);
const stableStates = new Set<StablePluginState>(["not-installed", "installed", "enabled", "disabled"]);
const transientStates = new Set<PluginState>(["installing", "enabling", "disabling", "uninstalling"]);
const catalogOperations = new Set<CatalogOperation>([
  "install", "enable", "disable", "uninstall", "repair", "retry", "controlled-uninstall",
]);

export function assertCatalogSnapshot(value: unknown): asserts value is CatalogSnapshot {
  if (!isObject(value) || value.schema !== "tabverse-plugin-catalog/v1" ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
      !isObject(value.plugins) || !isObject(value.commandResults) || !isObject(value.retainedState)) {
    throw new PluginKernelError("CATALOG_CORRUPT", "catalog envelope is invalid");
  }
  for (const [pluginId, candidate] of Object.entries(value.plugins)) {
    if (!isObject(candidate) || !isObject(candidate.manifest) || candidate.manifest.id !== pluginId ||
        typeof candidate.state !== "string" || !pluginStates.has(candidate.state as PluginState) ||
        candidate.state === "not-installed" || typeof candidate.lastStableState !== "string" ||
        !stableStates.has(candidate.lastStableState as StablePluginState)) {
      throw new PluginKernelError("CATALOG_CORRUPT", `catalog plugin record is invalid: ${pluginId}`);
    }
  }
  if (value.journal !== undefined) {
    const journal = value.journal;
    if (!isObject(journal) || !isObject(journal.command) || typeof journal.command.commandId !== "string" ||
        !Number.isSafeInteger(journal.command.expectedRevision) || typeof journal.pluginId !== "string" ||
        typeof journal.operation !== "string" || !catalogOperations.has(journal.operation as CatalogOperation) ||
        typeof journal.transientState !== "string" || !transientStates.has(journal.transientState as PluginState) ||
        typeof journal.targetState !== "string" || !stableStates.has(journal.targetState as StablePluginState) ||
        typeof journal.lastStableState !== "string" || !stableStates.has(journal.lastStableState as StablePluginState) ||
        (journal.phase !== "prepared" && journal.phase !== "effects-applied")) {
      throw new PluginKernelError("CATALOG_CORRUPT", "catalog journal is invalid");
    }
    const plugin = value.plugins[journal.pluginId];
    if (!isObject(plugin) || plugin.state !== journal.transientState) {
      throw new PluginKernelError("CATALOG_CORRUPT", "catalog journal and transient plugin state disagree");
    }
  } else if (Object.values(value.plugins).some((candidate) => isObject(candidate) && transientStates.has(candidate.state as PluginState))) {
    throw new PluginKernelError("CATALOG_CORRUPT", "transient plugin state has no journal");
  }
  for (const [commandId, candidate] of Object.entries(value.commandResults)) {
    if (!isObject(candidate) || candidate.commandId !== commandId || typeof candidate.pluginId !== "string" ||
        typeof candidate.operation !== "string" || !catalogOperations.has(candidate.operation as CatalogOperation) ||
        !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) > Number(value.revision) ||
        typeof candidate.state !== "string" || !pluginStates.has(candidate.state as PluginState) ||
        (candidate.outcome !== "committed" && candidate.outcome !== "reconciled")) {
      throw new PluginKernelError("CATALOG_CORRUPT", `catalog command result is invalid: ${commandId}`);
    }
  }
  for (const [pluginId, candidate] of Object.entries(value.retainedState)) {
    if (!isObject(candidate) || candidate.pluginId !== pluginId || typeof candidate.pluginVersion !== "string" ||
        !Number.isSafeInteger(candidate.catalogRevision) || Number(candidate.catalogRevision) > Number(value.revision) + 1) {
      throw new PluginKernelError("CATALOG_CORRUPT", `retained state envelope is invalid: ${pluginId}`);
    }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** Environment-neutral persistent store; adapters own the actual atomic file/database write. */
export class JsonCatalogStore implements CatalogStore {
  constructor(readonly storage: AtomicCatalogStorage) {}

  async load(): Promise<CatalogSnapshot> {
    const contents = await this.storage.read();
    if (contents === null) return emptyCatalog();
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new PluginKernelError("CATALOG_CORRUPT", "catalog JSON cannot be parsed", {}, { cause: error });
    }
    assertCatalogSnapshot(parsed);
    return cloneCatalog(parsed);
  }

  async save(snapshot: CatalogSnapshot): Promise<void> {
    assertCatalogSnapshot(snapshot);
    await this.storage.writeAtomic(`${JSON.stringify(canonical(snapshot), null, 2)}\n`);
  }
}

/** Deterministic test/default store. Desktop adapters provide an atomic file implementation. */
export class MemoryCatalogStore implements CatalogStore {
  #snapshot: CatalogSnapshot;
  #saveCount = 0;
  #crashAfterSave: number | undefined;

  constructor(initial: CatalogSnapshot = emptyCatalog()) {
    this.#snapshot = cloneCatalog(initial);
  }

  get saveCount(): number {
    return this.#saveCount;
  }

  /** Throws after the selected save has become durable, modelling a process kill boundary. */
  crashAfterSave(saveNumber: number): void {
    this.#crashAfterSave = saveNumber;
  }

  async load(): Promise<CatalogSnapshot> {
    return cloneCatalog(this.#snapshot);
  }

  async save(snapshot: CatalogSnapshot): Promise<void> {
    this.#snapshot = cloneCatalog(snapshot);
    this.#saveCount += 1;
    if (this.#crashAfterSave === this.#saveCount) {
      this.#crashAfterSave = undefined;
      throw new SimulatedProcessCrash(this.#saveCount);
    }
  }
}

export class SimulatedProcessCrash extends Error {
  constructor(readonly persistedSaveNumber: number) {
    super(`simulated process crash after persisted save ${persistedSaveNumber}`);
    this.name = "SimulatedProcessCrash";
  }
}
