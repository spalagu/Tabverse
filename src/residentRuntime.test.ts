import { beforeEach, describe, expect, it } from "vitest";
import type { ResidentAttachReplay } from "@tabverse/tab-contracts";
import { reconcileResidentRemoteTabs } from "./residentRuntime";
import { reconcileResidentTerminalTabs } from "./residentRuntime";
import { findLeaf } from "./paneTree";
import { useStore } from "./state/store";

function replay(
  kind: string,
  tabId: string,
  checkpoint: unknown,
): ResidentAttachReplay {
  return {
    runtime: {
      runtimeId: `runtime-${tabId}`,
      tabId,
      kind,
      generation: 1,
      pluginVersion: "1.0.0",
      artifactSlot: "fixture@1.0.0/hash",
      leaseId: "lease",
    },
    checkpointSeq: 0,
    checkpoint,
    events: [],
  };
}

describe("resident startup reconciliation", () => {
  beforeEach(() => {
    useStore.setState({ tabs: [], activeTabId: null });
  });

  it("restores a missing Remote tab from its live Supervisor checkpoint", () => {
    const restored = reconcileResidentRemoteTabs([
      replay("remote", "remote-1", {
        id: "remote-1",
        type: "remote",
        title: "Office network",
        joinTicket: "secret-ticket",
        residentPolicy: "inherit",
      }),
    ]);
    expect(restored).toEqual(["remote-1"]);
    expect(useStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: "remote-1",
        type: "remote",
        joinTicket: "secret-ticket",
        residentPolicy: "inherit",
      }),
    ]);
  });

  it("does not duplicate a restored tab or replace the user's active tab", () => {
    const local = useStore.getState().addTab({ type: "terminal", id: "local-1" });
    const live = replay("remote", "remote-1", {
      id: "remote-1",
      type: "remote",
      joinTicket: "secret-ticket",
    });
    reconcileResidentRemoteTabs([live]);
    reconcileResidentRemoteTabs([live]);
    expect(useStore.getState().tabs.filter((tab) => tab.id === "remote-1")).toHaveLength(1);
    expect(useStore.getState().activeTabId).toBe(local);
  });

  it("rejects mismatched, ticketless and non-Remote checkpoints", () => {
    const restored = reconcileResidentRemoteTabs([
      replay("terminal", "terminal-1", { id: "terminal-1", type: "terminal" }),
      replay("remote", "remote-1", { id: "other", type: "remote", joinTicket: "x" }),
      replay("remote", "remote-2", { id: "remote-2", type: "remote" }),
    ]);
    expect(restored).toEqual([]);
    expect(useStore.getState().tabs).toEqual([]);
  });

  it("maps resident Terminal sessions back to their exact split panes", async () => {
    useStore.setState({
      tabs: [{
        id: "terminal-1",
        type: "terminal",
        title: "Terminal",
        groupId: null,
        panes: {
          kind: "split",
          id: "split",
          vertical: false,
          ratios: [0.5, 0.5],
          children: [
            { kind: "leaf", id: "pane-a" },
            { kind: "leaf", id: "pane-b" },
          ],
        },
      }],
      activeTabId: "terminal-1",
    });
    const live = replay("terminal", "terminal-1", {
      id: "terminal-1",
      type: "terminal",
    });
    await reconcileResidentTerminalTabs([live], async () => [
      { id: new Array(16).fill(0x11), ownerKey: "pane-a", cwd: null, attached: false },
      { id: new Array(16).fill(0x22), ownerKey: "pane-b", cwd: null, attached: false },
    ]);
    const tab = useStore.getState().tabs[0];
    expect(findLeaf(tab.panes!, "pane-a")?.attachSessionId).toBe("11".repeat(16));
    expect(findLeaf(tab.panes!, "pane-b")?.attachSessionId).toBe("22".repeat(16));
  });

  it("re-materializes a missing resident Terminal and attaches its sole session", async () => {
    const live = replay("terminal", "terminal-1", {
      id: "terminal-1",
      type: "terminal",
      title: "Build",
      cwd: "/workspace",
      residentPolicy: "on",
    });
    await reconcileResidentTerminalTabs([live], async () => [
      { id: new Array(16).fill(0x33), ownerKey: "terminal-1", cwd: "/workspace", attached: false },
    ]);
    expect(useStore.getState().tabs[0]).toEqual(expect.objectContaining({
      id: "terminal-1",
      type: "terminal",
      attachSessionId: "33".repeat(16),
      residentPolicy: "on",
    }));
  });
});
