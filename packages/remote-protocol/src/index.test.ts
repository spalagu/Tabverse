import { describe, expect, it } from "vitest";
import type {
  RemoteFrame,
  RemoteIntentDeclaration,
  RemoteIntentEnvelope,
  TabContribution,
} from "@tabverse/tab-contracts";
import {
  RemoteClientState,
  RemoteIntentHost,
  RemoteResnapshotRequired,
  attachRemoteState,
  createObservedRemoteState,
  createRemoteTabSet,
  foldRemoteReplacement,
  type RemoteReplaceFrame,
} from "./index";

describe("ordered RemoteContribution state machine", () => {
  it("uses the snapshot cut to eliminate snapshot/live races and folds each frame once", async () => {
    let epoch = 0;
    const host = createObservedRemoteState<number, RemoteReplaceFrame<number>>({
      epoch: () => `epoch-${++epoch}`,
    });
    host.observe("tab-1", 1, { type: "replace", state: 1 });
    const delivered: Array<RemoteFrame<RemoteReplaceFrame<number>>> = [];
    const attachmentPromise = attachRemoteState(host.state, "tab-1", null, (frame) => {
      delivered.push(frame);
    });
    host.observe("tab-1", 2, { type: "replace", state: 2 });
    const attachment = await attachmentPromise;
    const client = new RemoteClientState<number, RemoteReplaceFrame<number>>(
      foldRemoteReplacement,
    );
    expect(client.installSnapshot(attachment.snapshot)).toBe(2);
    expect(delivered).toEqual([]);

    const live = host.observe("tab-1", 3, { type: "replace", state: 3 })!;
    expect(client.receive(live)).toBe("applied");
    expect(client.receive(live)).toBe("duplicate");
    expect(client.state).toBe(3);
    expect(client.cursor).toEqual({ epoch: "epoch-1", ackedFrameSeq: 2n });
    await attachment.dispose();
  });

  it("forces resnapshot for gaps, epoch changes, and stale cursors", async () => {
    let epoch = 0;
    const host = createObservedRemoteState<number, RemoteReplaceFrame<number>>({
      epoch: () => `epoch-${++epoch}`,
      maxReplayFrames: 1,
    });
    host.observe("tab-1", 0, { type: "replace", state: 0 });
    const snapshot = await host.state.snapshot("tab-1");
    const one = host.observe("tab-1", 1, { type: "replace", state: 1 })!;
    const two = host.observe("tab-1", 2, { type: "replace", state: 2 })!;
    const client = new RemoteClientState<number, RemoteReplaceFrame<number>>(
      foldRemoteReplacement,
    );
    client.installSnapshot(snapshot);
    expect(client.receive(two)).toBe("resnapshot");
    expect(client.needsSnapshot).toBe(true);
    expect(() => host.state.subscribe(
      "tab-1",
      { epoch: snapshot.epoch, ackedFrameSeq: 0n },
      () => {},
    )).toThrowError(RemoteResnapshotRequired);

    host.resetEpoch("tab-1", 3);
    const next = host.observe("tab-1", 4, { type: "replace", state: 4 })!;
    const resumed = new RemoteClientState<number, RemoteReplaceFrame<number>>(
      foldRemoteReplacement,
    );
    resumed.installSnapshot({ ...snapshot, state: 1, lastFrameSeq: one.frameSeq });
    expect(resumed.receive(next)).toBe("resnapshot");
  });
});

describe("Remote intent identity and permissions", () => {
  const declaration: RemoteIntentDeclaration<{ amount: number }> = {
    name: "increment",
    schema: {
      id: "increment/v1",
      validate: (input): input is { amount: number } =>
        typeof input === "object" &&
        input !== null &&
        Number.isSafeInteger((input as { amount?: unknown }).amount),
    },
    minAccess: "steer",
    idempotent: false,
  };

  it("executes an attachment, generation, and intent ID tuple once while rejecting stale or unauthorized intents", async () => {
    let executions = 0;
    const host = new RemoteIntentHost([declaration], async (intent) => {
      executions += 1;
      return intent.payload.amount;
    });
    const intent: RemoteIntentEnvelope<{ amount: number }> = {
      attachmentId: "viewer-a",
      attachmentGeneration: 2n,
      intentId: "intent-1",
      name: "increment",
      payload: { amount: 1 },
    };
    const attachment = { id: "viewer-a", generation: 2n };
    expect(await host.apply("steer", attachment, intent)).toEqual({
      intentId: "intent-1",
      ok: 1,
    });
    expect(await host.apply("steer", attachment, intent)).toEqual({
      intentId: "intent-1",
      ok: 1,
    });
    expect(executions).toBe(1);
    expect(await host.apply("view", attachment, { ...intent, intentId: "intent-2" }))
      .toMatchObject({ error: "steer access required" });
    expect(await host.apply("steer", attachment, {
      ...intent,
      attachmentGeneration: 1n,
      intentId: "intent-3",
    })).toMatchObject({ error: "stale attachment" });
  });
});

describe("RemoteTabSet", () => {
  const contribution = (kind: string, remote: boolean): TabContribution<unknown> => ({
    manifest: {
      kind,
      version: 1,
      stateVersion: 1,
      presentation: { label: kind, hint: kind, icon: kind },
    },
    view: { requiredServices: [], render: () => null },
    state: { parse: (input) => input, migrate: (input) => input },
    remote: remote ? {
      protocol: { name: `${kind}-semantic`, minVersion: 4, maxVersion: 4 },
      state: {
        snapshot: async () => ({ epoch: "e", snapshotRevision: 1n, lastFrameSeq: 0n, state: {} }),
        subscribe: async () => ({ dispose: () => {} }),
      },
      client: { fold: (state) => state, render: () => null },
      intents: [],
      fallback: "read-only",
    } : undefined,
    permissions: [],
    fallback: "unsupported",
  });

  it("projects Whole App and Single Tab shares dynamically from the same contributions", () => {
    expect(createRemoteTabSet([
      contribution("terminal", true),
      contribution("settings", false),
      contribution("future.tab", true),
    ])).toEqual([
      {
        kind: "future.tab",
        protocol: { name: "future.tab-semantic", minVersion: 4, maxVersion: 4 },
        fallback: "read-only",
      },
      {
        kind: "terminal",
        protocol: { name: "terminal-semantic", minVersion: 4, maxVersion: 4 },
        fallback: "read-only",
      },
    ]);
  });
});
