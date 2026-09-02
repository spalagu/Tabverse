/** Tabverse-owned contracts. Product plugins must not depend on a kernel implementation. */

export type Awaitable<T> = T | Promise<T>;
export type TabId = string;

export interface AsyncDisposable {
  dispose(): Awaitable<void>;
}

export type Disposer = () => Awaitable<void>;

declare const serviceType: unique symbol;

/** A stable, serialisable service identity with a compile-time value type. */
export interface ServiceToken<T> {
  readonly id: string;
  readonly [serviceType]?: T;
}

export function serviceToken<T>(id: string): ServiceToken<T> {
  if (!id.trim()) throw new Error("service token id must not be empty");
  return Object.freeze({ id }) as ServiceToken<T>;
}

export interface ServiceResolver {
  get<T>(token: ServiceToken<T>): T;
  optional<T>(token: ServiceToken<T>): T | undefined;
}

export interface OwnedScope extends ServiceResolver, AsyncDisposable {
  readonly disposed: boolean;
  defer(disposer: Disposer | AsyncDisposable): void;
}

export type PluginState =
  | "not-installed"
  | "installing"
  | "installed"
  | "enabling"
  | "enabled"
  | "disabling"
  | "disabled"
  | "uninstalling"
  | "failed";

export type StablePluginState =
  | "not-installed"
  | "installed"
  | "enabled"
  | "disabled";

export interface PluginDependency {
  readonly id: string;
  readonly range: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: number;
  readonly dependencies: readonly PluginDependency[];
  readonly tabs: readonly string[];
  readonly builtIn: boolean;
  readonly enabledByDefault: boolean;
}

export interface CapabilityRequest {
  readonly capability: string;
  readonly reason: string;
  readonly optional?: boolean;
}

export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly run: (tabId: TabId, input?: unknown) => Awaitable<unknown>;
}

export type RemoteAccess = "view" | "steer" | "approve";

export interface RemoteProtocolRange {
  readonly name: string;
  readonly minVersion: number;
  readonly maxVersion: number;
}

export interface RemoteFrame<Frame = unknown> {
  readonly epoch: string;
  readonly frameSeq: bigint;
  readonly payload: Frame;
}

export interface RemoteSnapshot<State = unknown> {
  readonly epoch: string;
  readonly snapshotRevision: bigint;
  readonly lastFrameSeq: bigint;
  readonly state: State;
}

export interface RemoteResumeCursor {
  readonly epoch: string;
  readonly ackedFrameSeq: bigint;
}

export interface RemoteStateProvider<State = unknown, Frame = unknown> {
  snapshot(tabId: TabId): Awaitable<RemoteSnapshot<State>>;
  subscribe(
    tabId: TabId,
    resume: RemoteResumeCursor | null,
    emit: (frame: RemoteFrame<Frame>) => void,
  ): Awaitable<AsyncDisposable>;
  /** Drop per-Tab replay state after its final remote attachment closes. */
  release?(tabId: TabId): Awaitable<void>;
}

export interface RemoteSchema<Input = unknown> {
  readonly id: string;
  readonly validate: (input: unknown) => input is Input;
}

export interface RemoteIntentDeclaration<Intent = unknown> {
  readonly name: string;
  readonly schema: RemoteSchema<Intent>;
  readonly minAccess: RemoteAccess;
  /** Non-idempotent intents are never replayed automatically after reconnect. */
  readonly idempotent: boolean;
}

export interface RemoteIntentEnvelope<Intent = unknown> {
  readonly attachmentId: string;
  readonly attachmentGeneration: bigint;
  readonly intentId: string;
  readonly name: string;
  readonly payload: Intent;
}

export interface RemotePrivateStreamDeclaration {
  readonly name: string;
  readonly minAccess: RemoteAccess;
}

export interface PrivateStreamProvider {
  readonly streams: readonly RemotePrivateStreamDeclaration[];
}

export interface RemoteContribution<State = unknown, Frame = unknown, Intent = unknown> {
  readonly protocol: RemoteProtocolRange;
  readonly state: RemoteStateProvider<State, Frame>;
  readonly client: {
    readonly fold: (state: State, frame: Frame) => State;
    readonly render: TabRenderer<State>;
  };
  readonly intents: readonly RemoteIntentDeclaration<Intent>[];
  readonly privateStreams?: PrivateStreamProvider;
  readonly fallback: "unsupported" | "read-only" | "semantic-document";
}

export interface RuntimeDescriptor {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly artifactHash: string;
  readonly entrypoint: string;
  readonly permissions: readonly CapabilityRequest[];
  readonly protocolRange: {
    readonly min: number;
    readonly max: number;
  };
  readonly signature: string;
}

export interface ResidentSchema<Input = unknown> {
  readonly id: string;
  readonly validate: (input: unknown) => input is Input;
}

export interface StateOnlyResidentContribution {
  readonly capability: "state-only";
  readonly runtimeKind: string;
  /** Independently started work that may outlive the state-only Tab view. */
  readonly continuousTasks?: readonly ContinuousResidentContribution[];
}

export interface ContinuousResidentContribution<Initial = unknown, Checkpoint = unknown> {
  readonly capability: "continuous";
  readonly runtimeKind: string;
  /** Resolve the platform artifact selected by the signed installed bundle. */
  readonly descriptor: () => Awaitable<RuntimeDescriptor>;
  readonly initialStateSchema: ResidentSchema<Initial>;
  readonly checkpointSchema: ResidentSchema<Checkpoint>;
}

export type ResidentContribution =
  | StateOnlyResidentContribution
  | ContinuousResidentContribution;

export interface ResidentPolicy {
  readonly appDefault: "on" | "off";
  readonly tab: "inherit" | "on" | "off";
}

export type EffectiveResidentMode = "continuous" | "state-only" | "none";

export interface ResidentRuntimeRef {
  readonly runtimeId: string;
  readonly tabId: TabId;
  readonly kind: string;
  readonly generation: number;
  readonly pluginVersion: string;
  readonly artifactSlot: string;
  readonly leaseId: string;
}

export interface ResidentEventRecord {
  readonly seq: number;
  readonly payload: unknown;
}

export interface ResidentAttachReplay {
  readonly runtime: ResidentRuntimeRef;
  readonly checkpointSeq: number;
  readonly checkpoint: unknown;
  readonly events: readonly ResidentEventRecord[];
}

export interface EnsureResidentRuntimeRequest {
  readonly tabId: TabId;
  readonly kind: string;
  readonly descriptor: RuntimeDescriptor;
  readonly expectedCatalogRevision: number;
  readonly requestId: string;
  readonly initialCheckpoint: unknown;
}

/** Narrow port exposed by the GUI adapter; it deliberately has no spawn API. */
export interface ResidentRuntimePort {
  ensure(request: EnsureResidentRuntimeRequest): Awaitable<ResidentRuntimeRef>;
  list(): Awaitable<readonly ResidentRuntimeRef[]>;
  attach(runtimeId: string, lastAckSeq: number): Awaitable<ResidentAttachReplay>;
  poll(runtimeId: string, lastAckSeq: number): Awaitable<ResidentAttachReplay>;
  intent(runtimeId: string, payload: unknown): Awaitable<void>;
  detach(runtime: ResidentRuntimeRef): Awaitable<ResidentRuntimeRef>;
  stop(runtime: ResidentRuntimeRef): Awaitable<void>;
}

/** Resolve the finite policy matrix without inventing continuity for a Tab. */
export function effectiveResidentMode(
  contribution: ResidentContribution | undefined,
  policy: ResidentPolicy,
): EffectiveResidentMode {
  if (contribution === undefined) return "none";
  if (contribution.capability === "state-only") return "state-only";
  const enabled = policy.tab === "inherit"
    ? policy.appDefault === "on"
    : policy.tab === "on";
  return enabled ? "continuous" : "none";
}

export interface TabRendererArgs<State = unknown> {
  readonly tabId: TabId;
  readonly state: State;
  readonly active: boolean;
  readonly services: ServiceResolver;
}

export type TabRenderer<State = unknown, Output = unknown> = (
  args: TabRendererArgs<State>,
) => Output;

export interface TabInstanceContext extends OwnedScope {
  readonly tabId: TabId;
  readonly kind: string;
  readonly pluginId: string;
}

export interface TabContribution<State = unknown> {
  readonly manifest: {
    readonly kind: string;
    readonly version: number;
    readonly stateVersion: number;
    /** Catalog-owned presentation; entry points must not maintain a second kind table. */
    readonly presentation: {
      readonly label: string;
      readonly hint: string;
      readonly icon: string;
      readonly order?: number;
      readonly groupLabel?: string;
      readonly launch?: "tab" | "dialog";
      readonly creation?: {
        readonly field: string;
        readonly fieldLabel: string;
        readonly placeholder: string;
        readonly submitLabel: string;
        readonly defaultScheme?: string;
      };
    };
  };
  readonly view: {
    readonly render: TabRenderer<State>;
    readonly requiredServices: readonly ServiceToken<unknown>[];
  };
  readonly state: {
    readonly parse: (input: unknown) => State;
    readonly migrate: (input: unknown, from: number) => State;
  };
  readonly remote?: RemoteContribution<State>;
  readonly resident?: ResidentContribution;
  readonly commands?: readonly CommandContribution[];
  readonly permissions: readonly CapabilityRequest[];
  readonly fallback: "placeholder" | "read-only" | "unsupported";
  readonly activate?: (context: TabInstanceContext) => Awaitable<void | AsyncDisposable>;
}

export interface TabStateEnvelope {
  readonly schema: "tabverse-tab-state/v1";
  readonly kind: string;
  readonly contributionVersion: number;
  readonly stateVersion: number;
  readonly payload: unknown;
}

export type TabStatePlaceholderReason =
  | "missing-plugin"
  | "kind-mismatch"
  | "future-contribution-version"
  | "future-state-version"
  | "migration-failed"
  | "invalid-state";

export type TabStateResolution<State> =
  | { readonly status: "ready"; readonly state: State }
  | {
      readonly status: "placeholder";
      readonly reason: TabStatePlaceholderReason;
      readonly envelope: TabStateEnvelope;
      readonly detail: string;
    };

/** Resolve a saved Tab without ever discarding an unreadable payload. */
export function resolveTabStateEnvelope<State>(
  envelope: TabStateEnvelope,
  contribution: TabContribution<State> | undefined,
): TabStateResolution<State> {
  const placeholder = (
    reason: TabStatePlaceholderReason,
    detail: string,
  ): TabStateResolution<State> => ({
    status: "placeholder",
    reason,
    envelope,
    detail,
  });
  if (contribution === undefined) {
    return placeholder("missing-plugin", `plugin for Tab kind ${envelope.kind} is unavailable`);
  }
  if (contribution.manifest.kind !== envelope.kind) {
    return placeholder(
      "kind-mismatch",
      `saved kind ${envelope.kind} does not match ${contribution.manifest.kind}`,
    );
  }
  if (envelope.contributionVersion > contribution.manifest.version) {
    return placeholder(
      "future-contribution-version",
      `saved contribution v${envelope.contributionVersion} is newer than supported v${contribution.manifest.version}`,
    );
  }
  if (envelope.stateVersion > contribution.manifest.stateVersion) {
    return placeholder(
      "future-state-version",
      `saved state v${envelope.stateVersion} is newer than supported v${contribution.manifest.stateVersion}`,
    );
  }
  if (envelope.stateVersion === contribution.manifest.stateVersion) {
    try {
      return { status: "ready", state: contribution.state.parse(envelope.payload) };
    } catch (error) {
      return placeholder(
        "invalid-state",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  let migrated: State;
  try {
    migrated = contribution.state.migrate(envelope.payload, envelope.stateVersion);
  } catch (error) {
    return placeholder(
      "migration-failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    return { status: "ready", state: contribution.state.parse(migrated) };
  } catch (error) {
    return placeholder(
      "invalid-state",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface PluginContext extends OwnedScope {
  readonly pluginId: string;
  provide<T>(token: ServiceToken<T>, value: T): void;
  contributeTab<State>(contribution: TabContribution<State>): void;
}

export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly activate: (context: PluginContext) => Awaitable<void | AsyncDisposable>;
}

export interface PluginHandle extends AsyncDisposable {
  readonly pluginId: string;
  readonly revision: number;
}

export interface TabInstanceScope extends TabInstanceContext {
  readonly contribution: TabContribution<unknown>;
}

export interface CatalogCommand {
  readonly commandId: string;
  readonly expectedRevision: number;
}
