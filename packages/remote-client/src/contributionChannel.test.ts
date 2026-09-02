import { describe, expect, it } from "vitest";
import type { RemoteContribution } from "@tabverse/tab-contracts";
import { createContributionChannel } from "./contributionChannel";

const contribution: RemoteContribution<number, { readonly add: number }> = {
  protocol: { name: "counter", minVersion: 4, maxVersion: 4 },
  state: {
    snapshot: async () => ({ epoch: "unused", snapshotRevision: 0n, lastFrameSeq: 0n, state: 0 }),
    subscribe: async () => ({ dispose: () => {} }),
  },
  client: {
    fold: (state, frame) => state + frame.add,
    render: () => null,
  },
  intents: [],
  fallback: "read-only",
};

describe("contribution viewer channel", () => {
  it("acknowledges contiguous frames, confirms duplicates without folding, and resnapshots on gaps", async () => {
    const states: unknown[] = [];
    const acks: Array<[string, string, bigint]> = [];
    const resnapshots: Array<[string, string | undefined]> = [];
    const channel = createContributionChannel({
      resolve: async () => ({
        contribution: contribution as RemoteContribution,
        dispose: () => {},
      }),
      sendAck: (...args) => acks.push(args),
      requestSnapshot: (tabId, epoch) => resnapshots.push([tabId, epoch]),
      onState: (_tabId, _kind, state) => states.push(state),
    });

    await channel.consume({
      type: "contributionSnapshot",
      tabId: "counter-1",
      kind: "counter",
      epoch: "epoch-1",
      snapshotRevision: 1,
      lastFrameSeq: 0,
      state: 10,
    });
    const one = {
      type: "contributionFrame" as const,
      tabId: "counter-1",
      kind: "counter",
      epoch: "epoch-1",
      frameSeq: 1,
      payload: { add: 2 },
    };
    await channel.consume(one);
    await channel.consume(one);
    await channel.consume({ ...one, frameSeq: 3 });

    expect(states).toEqual([10, 12]);
    expect(acks).toEqual([
      ["counter-1", "epoch-1", 0n],
      ["counter-1", "epoch-1", 1n],
      ["counter-1", "epoch-1", 1n],
    ]);
    expect(resnapshots).toEqual([["counter-1", "epoch-1"]]);
    await channel.resume();
    expect(acks.at(-1)).toEqual(["counter-1", "epoch-1", 1n]);
    expect(resnapshots.at(-1)).toEqual(["counter-1", undefined]);
    await channel.dispose();
  });
});
