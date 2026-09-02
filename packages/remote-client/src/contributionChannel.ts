import type {
  AsyncDisposable,
  RemoteContribution,
  RemoteFrame,
  RemoteSnapshot,
} from "@tabverse/tab-contracts";
import { RemoteClientState } from "@tabverse/remote-protocol";
import type { AppHostFrame } from "./appFrame";

type SnapshotFrame = Extract<AppHostFrame, { type: "contributionSnapshot" }>;
type LiveFrame = Extract<AppHostFrame, { type: "contributionFrame" }>;

export interface ResolvedRemoteContribution extends AsyncDisposable {
  readonly contribution: RemoteContribution;
}

export interface ContributionChannelOptions {
  readonly resolve: (
    kind: string,
    tabId: string,
  ) => Promise<ResolvedRemoteContribution>;
  readonly sendAck: (tabId: string, epoch: string, frameSeq: bigint) => void;
  readonly requestSnapshot: (tabId: string, epoch?: string) => void;
  readonly onState: (tabId: string, kind: string, state: unknown) => void;
}

interface ClientEntry {
  readonly tabId: string;
  readonly kind: string;
  readonly resolved: ResolvedRemoteContribution;
  readonly state: RemoteClientState<unknown, unknown>;
}

/** Viewer adapter for v4 contribution snapshots and ordered live frames. */
export function createContributionChannel(options: ContributionChannelOptions) {
  const entries = new Map<string, Promise<ClientEntry>>();

  const entryFor = (kind: string, tabId: string): Promise<ClientEntry> => {
    const existing = entries.get(tabId);
    if (existing !== undefined) return existing;
    const created = options.resolve(kind, tabId).then((resolved) => ({
      tabId,
      kind,
      resolved,
      state: new RemoteClientState<unknown, unknown>(
        resolved.contribution.client.fold,
      ),
    }));
    entries.set(tabId, created);
    return created;
  };

  const installSnapshot = async (frame: SnapshotFrame): Promise<void> => {
    const entry = await entryFor(frame.kind, frame.tabId);
    if (entry.kind !== frame.kind) {
      options.requestSnapshot(frame.tabId);
      return;
    }
    const snapshot: RemoteSnapshot<unknown> = {
      epoch: frame.epoch,
      snapshotRevision: BigInt(frame.snapshotRevision),
      lastFrameSeq: BigInt(frame.lastFrameSeq),
      state: frame.state,
    };
    const state = entry.state.installSnapshot(snapshot);
    options.onState(frame.tabId, frame.kind, state);
    options.sendAck(frame.tabId, snapshot.epoch, snapshot.lastFrameSeq);
  };

  const applyFrame = async (frame: LiveFrame): Promise<void> => {
    const pending = entries.get(frame.tabId);
    if (pending === undefined) {
      options.requestSnapshot(frame.tabId);
      return;
    }
    const entry = await pending;
    if (entry.kind !== frame.kind) {
      options.requestSnapshot(frame.tabId);
      return;
    }
    const envelope: RemoteFrame<unknown> = {
      epoch: frame.epoch,
      frameSeq: BigInt(frame.frameSeq),
      payload: frame.payload,
    };
    const disposition = entry.state.receive(envelope);
    if (disposition === "resnapshot") {
      options.requestSnapshot(frame.tabId, entry.state.cursor?.epoch);
      return;
    }
    if (disposition === "applied") {
      options.onState(frame.tabId, frame.kind, entry.state.state);
    }
    const cursor = entry.state.cursor;
    if (cursor !== null) {
      options.sendAck(frame.tabId, cursor.epoch, cursor.ackedFrameSeq);
    }
  };

  return {
    async consume(frame: AppHostFrame): Promise<boolean> {
      if (frame.type === "contributionSnapshot") {
        await installSnapshot(frame);
        return true;
      }
      if (frame.type === "contributionFrame") {
        await applyFrame(frame);
        return true;
      }
      return false;
    },
    async resume(): Promise<void> {
      const settled = await Promise.allSettled(entries.values());
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        const cursor = result.value.state.cursor;
        if (cursor === null) continue;
        if (result.value.state.needsSnapshot) {
          options.requestSnapshot(result.value.tabId);
          continue;
        }
        options.sendAck(
          result.value.tabId,
          cursor.epoch,
          cursor.ackedFrameSeq,
        );
        options.requestSnapshot(result.value.tabId, cursor.epoch);
      }
    },
    async dispose(): Promise<void> {
      const settled = await Promise.allSettled(entries.values());
      entries.clear();
      await Promise.all(
        settled.flatMap((result) =>
          result.status === "fulfilled"
            ? [
                Promise.resolve(
                  result.value.resolved.contribution.state.release?.(
                    result.value.tabId,
                  ),
                ).then(() => result.value.resolved.dispose()),
              ]
            : [],
        ),
      );
    },
  };
}
