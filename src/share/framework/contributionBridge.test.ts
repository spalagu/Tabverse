import { describe, expect, it, vi } from "vitest";
import { createDesktopPluginComposition } from "../../pluginComposition";
import { createContributionBridge } from "./contributionBridge";

describe("contribution host bridge", () => {
  it("projects only remote-capable tabs, sends minimal state, and deduplicates intents", async () => {
    const composition = createDesktopPluginComposition();
    const calls: Array<[string, Record<string, unknown>]> = [];
    const executeIntent = vi.fn(async () => "done");
    const bridge = createContributionBridge({
      composition,
      invoke: async (command, args) => {
        calls.push([command, args]);
        return null;
      },
      executeIntent,
    });

    const terminal = {
      id: "terminal-1",
      type: "terminal",
      title: "Shell",
      cwd: "/workspace",
      share: { ticket: "must-not-cross-the-wire" },
    };
    await bridge.sync(
      [
        terminal,
        { id: "files-1", type: "files", title: "Files", cwd: "/workspace" },
        { id: "browser-1", type: "browser", title: "Web", url: "https://example.test" },
        { id: "settings-1", type: "settings", title: "Settings" },
      ],
      terminal.id,
    );

    const snapshots = calls.filter(([command]) =>
      command === "app_share_contribution_snapshot"
    );
    expect(snapshots).toHaveLength(3);
    expect(snapshots.map(([, args]) => args.kind).sort()).toEqual([
      "browser",
      "files",
      "terminal",
    ]);
    expect(JSON.stringify(snapshots)).not.toContain("must-not-cross-the-wire");

    await bridge.sync(
      [{ ...terminal, cwd: "/next" }],
      terminal.id,
    );
    expect(
      calls.some(
        ([command, args]) =>
          command === "app_share_contribution_frame" &&
          args.tabId === terminal.id,
      ),
    ).toBe(true);

    await bridge.handleAck({
      viewer: 7,
      tabId: terminal.id,
      epoch: calls.find(
        ([command, args]) =>
          command === "app_share_contribution_frame" &&
          args.tabId === terminal.id,
      )![1].epoch as string,
      frameSeq: 1,
    });
    await bridge.sync([{ ...terminal, cwd: "/third" }], terminal.id);
    await bridge.handleResnapshot({
      viewer: 7,
      tabId: terminal.id,
      epoch: calls.find(
        ([command, args]) =>
          command === "app_share_contribution_frame" &&
          args.tabId === terminal.id,
      )![1].epoch as string,
    });
    expect(
      calls.some(
        ([command, args]) =>
          command === "app_share_contribution_frame" &&
          args.viewer === 7 &&
          args.frameSeq === "2",
      ),
    ).toBe(true);

    const intent = {
      viewer: 7,
      access: "steer" as const,
      tabId: terminal.id,
      attachmentId: "attachment-7",
      attachmentGeneration: 1,
      intentId: "intent-1",
      name: "terminal.input",
      args: "pwd\n",
    };
    await bridge.handleIntent(intent);
    await bridge.handleIntent(intent);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(
      calls.filter(([command]) => command === "app_share_intent_result"),
    ).toHaveLength(2);

    await bridge.dispose();
    await composition.dispose();
  });
});
