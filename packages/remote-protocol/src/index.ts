import type {
  AsyncDisposable,
  RemoteAccess,
  RemoteContribution,
  RemoteFrame,
  RemoteIntentDeclaration,
  RemoteIntentEnvelope,
  RemoteResumeCursor,
  RemoteSnapshot,
  RemoteStateProvider,
  TabContribution,
  TabId,
} from "@tabverse/tab-contracts";

export interface RemoteReplaceFrame<State> {
  readonly type: "replace";
  readonly state: State;
}

export function foldRemoteReplacement<State>(
  _state: State,
  frame: RemoteReplaceFrame<State>,
): State {
  return frame.state;
}

export class RemoteResnapshotRequired extends Error {
  readonly code = "REMOTE_RESNAPSHOT_REQUIRED";

  constructor(
    readonly reason: "epoch-changed" | "cursor-ahead" | "cursor-expired" | "frame-gap",
  ) {
    super(`remote resnapshot required: ${reason}`);
  }
}

interface StreamRecord<State, Frame> {
  epoch: string;
  frameSeq: bigint;
  snapshotRevision: bigint;
  state: State;
  log: Array<RemoteFrame<Frame>>;
  listeners: Set<(frame: RemoteFrame<Frame>) => void>;
}

export interface ObservedRemoteState<State, Frame> {
  readonly state: RemoteStateProvider<State, Frame>;
  observe(tabId: TabId, state: State, frame: Frame): RemoteFrame<Frame> | null;
  resetEpoch(tabId: TabId, state: State): void;
}

let epochSeed = 0;
const defaultEpoch = (): string => `epoch-${Date.now()}-${++epochSeed}`;

/** Host-side single-writer stream used by every Tab contribution adapter. */
export function createObservedRemoteState<State, Frame>(options: {
  readonly epoch?: () => string;
  readonly maxReplayFrames?: number;
  readonly equals?: (left: State, right: State) => boolean;
} = {}): ObservedRemoteState<State, Frame> {
  const records = new Map<TabId, StreamRecord<State, Frame>>();
  const nextEpoch = options.epoch ?? defaultEpoch;
  const maxReplayFrames = options.maxReplayFrames ?? 4_096;
  const equals = options.equals ?? Object.is;

  const record = (tabId: TabId): StreamRecord<State, Frame> => {
    const found = records.get(tabId);
    if (found === undefined) throw new Error(`remote state is not observed: ${tabId}`);
    return found;
  };

  const state: RemoteStateProvider<State, Frame> = {
    snapshot(tabId) {
      const current = record(tabId);
      return {
        epoch: current.epoch,
        snapshotRevision: current.snapshotRevision,
        lastFrameSeq: current.frameSeq,
        state: current.state,
      };
    },
    subscribe(tabId, resume, emit) {
      const current = record(tabId);
      if (resume !== null) {
        if (resume.epoch !== current.epoch) {
          throw new RemoteResnapshotRequired("epoch-changed");
        }
        if (resume.ackedFrameSeq > current.frameSeq) {
          throw new RemoteResnapshotRequired("cursor-ahead");
        }
        const next = resume.ackedFrameSeq + 1n;
        const earliest = current.log[0]?.frameSeq ?? (current.frameSeq + 1n);
        if (next < earliest) {
          throw new RemoteResnapshotRequired("cursor-expired");
        }
      }
      current.listeners.add(emit);
      if (resume !== null) {
        for (const frame of current.log) {
          if (frame.frameSeq > resume.ackedFrameSeq) emit(frame);
        }
      }
      return {
        dispose: () => {
          current.listeners.delete(emit);
        },
      } satisfies AsyncDisposable;
    },
    release(tabId) {
      if (records.get(tabId)?.listeners.size === 0) records.delete(tabId);
    },
  };

  return {
    state,
    observe(tabId, nextState, frame) {
      const existing = records.get(tabId);
      if (existing === undefined) {
        records.set(tabId, {
          epoch: nextEpoch(),
          frameSeq: 0n,
          snapshotRevision: 1n,
          state: nextState,
          log: [],
          listeners: new Set(),
        });
        return null;
      }
      if (equals(existing.state, nextState)) return null;
      existing.state = nextState;
      existing.snapshotRevision += 1n;
      existing.frameSeq += 1n;
      const envelope = {
        epoch: existing.epoch,
        frameSeq: existing.frameSeq,
        payload: frame,
      } satisfies RemoteFrame<Frame>;
      existing.log.push(envelope);
      if (existing.log.length > maxReplayFrames) existing.log.shift();
      for (const listener of existing.listeners) listener(envelope);
      return envelope;
    },
    resetEpoch(tabId, nextState) {
      const listeners = records.get(tabId)?.listeners ?? new Set();
      records.set(tabId, {
        epoch: nextEpoch(),
        frameSeq: 0n,
        snapshotRevision: 1n,
        state: nextState,
        log: [],
        listeners,
      });
    },
  };
}

export interface RemoteHostAttachment<State> extends AsyncDisposable {
  readonly snapshot: RemoteSnapshot<State>;
}

/** Subscribe-before-snapshot handoff: buffered live frames at or below the cut are dropped. */
export async function attachRemoteState<State, Frame>(
  provider: RemoteStateProvider<State, Frame>,
  tabId: TabId,
  resume: RemoteResumeCursor | null,
  emit: (frame: RemoteFrame<Frame>) => void,
): Promise<RemoteHostAttachment<State>> {
  const buffered: Array<RemoteFrame<Frame>> = [];
  let live = false;
  const subscription = await provider.subscribe(tabId, resume, (frame) => {
    if (live) emit(frame);
    else buffered.push(frame);
  });
  try {
    const snapshot = await provider.snapshot(tabId);
    for (const frame of buffered) {
      if (frame.epoch !== snapshot.epoch) {
        throw new RemoteResnapshotRequired("epoch-changed");
      }
      if (frame.frameSeq > snapshot.lastFrameSeq) emit(frame);
    }
    live = true;
    return { snapshot, dispose: () => subscription.dispose() };
  } catch (error) {
    await subscription.dispose();
    throw error;
  }
}

export type RemoteFrameDisposition = "applied" | "duplicate" | "resnapshot";

/** Viewer fold: every accepted frame is contiguous and applied exactly once. */
export class RemoteClientState<State, Frame> {
  #state: State | undefined;
  #cursor: RemoteResumeCursor | null = null;
  #needsSnapshot = true;

  constructor(readonly fold: (state: State, frame: Frame) => State) {}

  installSnapshot(snapshot: RemoteSnapshot<State>): State {
    this.#state = snapshot.state;
    this.#cursor = { epoch: snapshot.epoch, ackedFrameSeq: snapshot.lastFrameSeq };
    this.#needsSnapshot = false;
    return snapshot.state;
  }

  receive(frame: RemoteFrame<Frame>): RemoteFrameDisposition {
    if (this.#needsSnapshot || this.#state === undefined || this.#cursor === null) {
      return "resnapshot";
    }
    if (frame.epoch !== this.#cursor.epoch) {
      this.#needsSnapshot = true;
      return "resnapshot";
    }
    if (frame.frameSeq <= this.#cursor.ackedFrameSeq) return "duplicate";
    if (frame.frameSeq !== this.#cursor.ackedFrameSeq + 1n) {
      this.#needsSnapshot = true;
      return "resnapshot";
    }
    this.#state = this.fold(this.#state, frame.payload);
    this.#cursor = { ...this.#cursor, ackedFrameSeq: frame.frameSeq };
    return "applied";
  }

  get state(): State | undefined {
    return this.#state;
  }

  get cursor(): RemoteResumeCursor | null {
    return this.#cursor;
  }

  get needsSnapshot(): boolean {
    return this.#needsSnapshot;
  }
}

const ACCESS_RANK: Readonly<Record<RemoteAccess, number>> = {
  view: 0,
  steer: 1,
  approve: 2,
};

export interface RemoteIntentResult<Result = unknown> {
  readonly intentId: string;
  readonly ok?: Result;
  readonly error?: string;
}

/** Host authority for schema/access checks and exactly-once intent identity. */
export class RemoteIntentHost<Intent = unknown, Result = unknown> {
  readonly #declarations: ReadonlyMap<string, RemoteIntentDeclaration<Intent>>;
  readonly #results = new Map<string, RemoteIntentResult<Result>>();

  constructor(
    declarations: readonly RemoteIntentDeclaration<Intent>[],
    readonly execute: (intent: RemoteIntentEnvelope<Intent>) => Promise<Result>,
  ) {
    this.#declarations = new Map(declarations.map((declaration) => [declaration.name, declaration]));
  }

  async apply(
    access: RemoteAccess,
    currentAttachment: { readonly id: string; readonly generation: bigint },
    intent: RemoteIntentEnvelope<Intent>,
  ): Promise<RemoteIntentResult<Result>> {
    const identity = `${intent.attachmentId}:${intent.attachmentGeneration}:${intent.intentId}`;
    const previous = this.#results.get(identity);
    if (previous !== undefined) return previous;
    const declaration = this.#declarations.get(intent.name);
    let result: RemoteIntentResult<Result>;
    if (
      intent.attachmentId !== currentAttachment.id ||
      intent.attachmentGeneration !== currentAttachment.generation
    ) {
      result = { intentId: intent.intentId, error: "stale attachment" };
    } else if (declaration === undefined) {
      result = { intentId: intent.intentId, error: "unknown intent" };
    } else if (ACCESS_RANK[access] < ACCESS_RANK[declaration.minAccess]) {
      result = { intentId: intent.intentId, error: `${declaration.minAccess} access required` };
    } else if (!declaration.schema.validate(intent.payload)) {
      result = { intentId: intent.intentId, error: `invalid ${declaration.schema.id}` };
    } else {
      try {
        result = { intentId: intent.intentId, ok: await this.execute(intent) };
      } catch (error) {
        result = {
          intentId: intent.intentId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    this.#results.set(identity, result);
    return result;
  }
}

export interface RemoteTabDescriptor {
  readonly kind: string;
  readonly protocol: RemoteContribution["protocol"];
  readonly fallback: RemoteContribution["fallback"];
}

/** Whole App Share is a dynamic projection of the same contributions Single Tab uses. */
export function createRemoteTabSet(
  contributions: readonly TabContribution<unknown>[],
): readonly RemoteTabDescriptor[] {
  return contributions
    .filter((contribution) => contribution.remote !== undefined)
    .map((contribution) => ({
      kind: contribution.manifest.kind,
      protocol: contribution.remote!.protocol,
      fallback: contribution.remote!.fallback,
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}
