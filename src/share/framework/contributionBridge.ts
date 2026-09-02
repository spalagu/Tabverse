import type { PluginComposition } from "@tabverse/plugin-composition";
import {
  RemoteIntentHost,
  attachRemoteState,
} from "@tabverse/remote-protocol";
import type {
  RemoteAccess,
  RemoteIntentEnvelope,
  RemoteResumeCursor,
  TabInstanceScope,
} from "@tabverse/tab-contracts";

export interface ContributionHostTab {
  readonly id: string;
  readonly type: string;
}

export interface ContributionIntentEvent {
  readonly viewer: number;
  readonly access: RemoteAccess;
  readonly tabId: string;
  readonly attachmentId: string;
  readonly attachmentGeneration: number;
  readonly intentId: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ContributionAckEvent {
  readonly viewer: number;
  readonly tabId: string;
  readonly epoch: string;
  readonly frameSeq: number;
}

export interface ContributionResnapshotEvent {
  readonly viewer: number;
  readonly tabId: string;
  readonly epoch?: string;
}

export interface ContributionSnapshotRequestEvent {
  readonly viewer: number;
  readonly tabId: string;
}

export type ContributionInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

interface HostEntry {
  readonly kind: string;
  readonly instance: TabInstanceScope;
  readonly stream: { dispose(): void | Promise<void> };
  readonly intents: RemoteIntentHost;
  state: ContributionHostTab;
}

export interface ContributionBridgeOptions {
  readonly composition: Pick<
    PluginComposition,
    "createInstance" | "tabContributions"
  >;
  readonly invoke: ContributionInvoke;
  readonly executeIntent: (
    tabId: string,
    name: string,
    payload: unknown,
  ) => Promise<unknown>;
  readonly reportError?: (message: string) => void;
}

/** Desktop adapter for v4 contribution streams. Settings has no contribution. */
export function createContributionBridge(options: ContributionBridgeOptions) {
  const entries = new Map<string, HostEntry>();
  const acknowledgements = new Map<number, Map<string, RemoteResumeCursor>>();
  let tail = Promise.resolve();
  let disposed = false;

  const report = (error: unknown): void => {
    options.reportError?.(
      error instanceof Error ? error.message : String(error),
    );
  };

  const sendSnapshot = async (
    tabId: string,
    entry: HostEntry,
    viewer: number | null = null,
  ): Promise<void> => {
    const remote = entry.instance.contribution.remote;
    if (remote === undefined) return;
    const snapshot = await remote.state.snapshot(tabId);
    await options.invoke("app_share_contribution_snapshot", {
      viewer,
      tabId,
      kind: entry.kind,
      epoch: snapshot.epoch,
      snapshotRevision: snapshot.snapshotRevision.toString(),
      lastFrameSeq: snapshot.lastFrameSeq.toString(),
      snapshot: snapshot.state,
    });
  };

  const open = async (
    tab: ContributionHostTab,
    activeTabId: string | null,
  ): Promise<void> => {
    const instance = await options.composition.createInstance(
      tab.type,
      `remote-host:${tab.id}`,
    );
    const remote = instance.contribution.remote;
    if (remote === undefined) {
      await instance.dispose();
      return;
    }
    instance.contribution.view.render({
      tabId: tab.id,
      state: tab,
      active: tab.id === activeTabId,
      services: instance,
    });
    const stream = await attachRemoteState(
      remote.state,
      tab.id,
      null,
      (frame) => {
        void options.invoke("app_share_contribution_frame", {
          viewer: null,
          tabId: tab.id,
          kind: tab.type,
          epoch: frame.epoch,
          frameSeq: frame.frameSeq.toString(),
          payload: frame.payload,
        }).catch(report);
      },
    );
    const intents = new RemoteIntentHost(remote.intents, (intent) =>
      options.executeIntent(tab.id, intent.name, intent.payload),
    );
    const entry = { kind: tab.type, instance, stream, intents, state: tab };
    entries.set(tab.id, entry);
    await options.invoke("app_share_contribution_snapshot", {
      viewer: null,
      tabId: tab.id,
      kind: tab.type,
      epoch: stream.snapshot.epoch,
      snapshotRevision: stream.snapshot.snapshotRevision.toString(),
      lastFrameSeq: stream.snapshot.lastFrameSeq.toString(),
      snapshot: stream.snapshot.state,
    });
  };

  const reconcile = async (
    tabs: readonly ContributionHostTab[],
    activeTabId: string | null,
  ): Promise<void> => {
    if (disposed) return;
    const remoteKinds = new Set(
      (await options.composition.tabContributions())
        .filter((contribution) => contribution.remote !== undefined)
        .map((contribution) => contribution.manifest.kind),
    );
    const shareableTabs = tabs.filter((tab) => remoteKinds.has(tab.type));
    const current = new Map(shareableTabs.map((tab) => [tab.id, tab]));
    for (const [tabId, entry] of [...entries]) {
      const tab = current.get(tabId);
      if (tab === undefined || tab.type !== entry.kind) {
        entries.delete(tabId);
        await entry.stream.dispose();
        await entry.instance.contribution.remote?.state.release?.(tabId);
        await entry.instance.dispose();
      }
    }
    for (const tab of shareableTabs) {
      const entry = entries.get(tab.id);
      if (entry === undefined) {
        await open(tab, activeTabId);
      } else if (entry.state !== tab) {
        entry.state = tab;
        entry.instance.contribution.view.render({
          tabId: tab.id,
          state: tab,
          active: tab.id === activeTabId,
          services: entry.instance,
        });
      }
    }
  };

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const result = tail.then(work);
    tail = result.catch(report);
    return result;
  };

  return {
    sync<Tab extends ContributionHostTab>(
      tabs: readonly Tab[],
      activeTabId: string | null,
    ): Promise<void> {
      return enqueue(() => reconcile(tabs, activeTabId));
    },

    snapshotAll(): Promise<void> {
      return enqueue(async () => {
        for (const [tabId, entry] of entries) {
          await sendSnapshot(tabId, entry);
        }
      });
    },

    snapshotTab(tabId: string, viewer: number): Promise<void> {
      return enqueue(async () => {
        const entry = entries.get(tabId);
        if (entry !== undefined) await sendSnapshot(tabId, entry, viewer);
      });
    },

    handleIntent(event: ContributionIntentEvent): Promise<void> {
      return enqueue(async () => {
        const entry = entries.get(event.tabId);
        const envelope: RemoteIntentEnvelope = {
          attachmentId: event.attachmentId,
          attachmentGeneration: BigInt(event.attachmentGeneration),
          intentId: event.intentId,
          name: event.name,
          payload: event.args,
        };
        const result = entry === undefined
          ? { intentId: event.intentId, error: "unknown remote tab" }
          : await entry.intents.apply(
              event.access,
              {
                id: event.attachmentId,
                generation: BigInt(event.attachmentGeneration),
              },
              envelope,
            );
        await options.invoke("app_share_intent_result", {
          viewer: event.viewer,
          tabId: event.tabId,
          attachmentId: event.attachmentId,
          attachmentGeneration: event.attachmentGeneration.toString(),
          intentId: event.intentId,
          ok: result.error === undefined ? (result.ok ?? null) : null,
          err: result.error ?? null,
        });
      });
    },

    handleAck(event: ContributionAckEvent): Promise<void> {
      return enqueue(async () => {
        let viewer = acknowledgements.get(event.viewer);
        if (viewer === undefined) {
          viewer = new Map();
          acknowledgements.set(event.viewer, viewer);
        }
        const previous = viewer.get(event.tabId);
        const next = BigInt(event.frameSeq);
        if (
          previous === undefined ||
          previous.epoch !== event.epoch ||
          next > previous.ackedFrameSeq
        ) {
          viewer.set(event.tabId, {
            epoch: event.epoch,
            ackedFrameSeq: next,
          });
        }
      });
    },

    handleResnapshot(event: ContributionResnapshotEvent): Promise<void> {
      return enqueue(async () => {
        const entry = entries.get(event.tabId);
        if (entry === undefined) return;
        const remote = entry.instance.contribution.remote;
        if (remote === undefined) return;
        const cursor = acknowledgements.get(event.viewer)?.get(event.tabId);
        if (
          event.epoch === undefined ||
          cursor === undefined ||
          event.epoch !== cursor.epoch
        ) {
          await sendSnapshot(event.tabId, entry, event.viewer);
          return;
        }
        const sends: Promise<unknown>[] = [];
        try {
          const replay = await remote.state.subscribe(
            event.tabId,
            cursor,
            (frame) => {
              sends.push(options.invoke("app_share_contribution_frame", {
                viewer: event.viewer,
                tabId: event.tabId,
                kind: entry.kind,
                epoch: frame.epoch,
                frameSeq: frame.frameSeq.toString(),
                payload: frame.payload,
              }));
            },
          );
          await replay.dispose();
          await Promise.all(sends);
        } catch {
          await sendSnapshot(event.tabId, entry, event.viewer);
        }
      });
    },

    clear(): Promise<void> {
      return enqueue(async () => {
        const stale = [...entries];
        entries.clear();
        acknowledgements.clear();
        for (const [tabId, entry] of stale) {
          await entry.stream.dispose();
          await entry.instance.contribution.remote?.state.release?.(tabId);
          await entry.instance.dispose();
        }
      });
    },

    async dispose(): Promise<void> {
      disposed = true;
      await tail;
      const stale = [...entries];
      entries.clear();
      acknowledgements.clear();
      for (const [tabId, entry] of stale) {
        await entry.stream.dispose();
        await entry.instance.contribution.remote?.state.release?.(tabId);
        await entry.instance.dispose();
      }
    },
  };
}
