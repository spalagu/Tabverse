import { describe, expect, it } from "vitest";
import type { TabContribution } from "@tabverse/tab-contracts";
import { tabDefinitionsFromContributions } from "./tabs";

function contribution(
  kind: string,
  order: number,
  remote = false,
): TabContribution<unknown> {
  return {
    manifest: {
      kind,
      version: 1,
      stateVersion: 1,
      presentation: { label: kind, hint: `${kind} hint`, icon: kind, order },
    },
    view: { render: () => null, requiredServices: [] },
    state: { parse: (input) => input, migrate: (input) => input },
    remote: remote ? {
      protocol: { name: `${kind}-remote`, minVersion: 1, maxVersion: 1 },
      state: {
        snapshot: async () => ({ epoch: "e", snapshotRevision: 0n, lastFrameSeq: 0n, state: {} }),
        subscribe: async () => ({ dispose: () => {} }),
      },
      client: { fold: (state) => state, render: () => null },
      intents: [],
      fallback: "unsupported",
    } : undefined,
    permissions: [],
    fallback: "placeholder",
  };
}

describe("Workbench Tab contribution projection", () => {
  it("sorts enabled contributions without a built-in kind table", () => {
    const definitions = tabDefinitionsFromContributions([
      contribution("later", 20),
      contribution("first", 10),
    ]);
    expect(definitions.map(({ type }) => type)).toEqual(["first", "later"]);
  });

  it("projects RemoteTabSet from the same contribution metadata", () => {
    const definitions = tabDefinitionsFromContributions([
      contribution("local", 10),
      contribution("shareable", 20, true),
    ], { remoteOnly: true });
    expect(definitions.map(({ type }) => type)).toEqual(["shareable"]);
  });
});
