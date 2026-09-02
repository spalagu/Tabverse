import type { TabContribution } from "@tabverse/tab-contracts";

/** Dynamic RemoteContribution fixtures; tests must not smuggle a product kind table back in. */
export function createRemoteTestContributions(
  kinds: readonly string[] = ["terminal", "files", "browser"],
): readonly TabContribution<unknown>[] {
  return kinds.map((kind, index) => ({
    manifest: {
      kind,
      version: 1,
      stateVersion: 1,
      presentation: {
        label: kind,
        hint: `${kind} fixture`,
        icon: kind,
        order: index,
        groupLabel: kind,
      },
    },
    view: { render: () => null, requiredServices: [] },
    state: { parse: (input) => input, migrate: (input) => input },
    remote: {
      protocol: { name: `${kind}-fixture`, minVersion: 1, maxVersion: 1 },
      state: {
        snapshot: async () => ({
          epoch: "fixture",
          snapshotRevision: 0n,
          lastFrameSeq: 0n,
          state: {},
        }),
        subscribe: async () => ({ dispose: () => {} }),
      },
      client: { fold: (state) => state, render: () => null },
      intents: [],
      fallback: "unsupported",
    },
    permissions: [],
    fallback: "placeholder",
  }));
}
