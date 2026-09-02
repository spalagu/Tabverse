import { beforeEach, describe, expect, it } from "vitest";
import { sessionSnapshot, useStore, withPresetGroups } from "../../../src/state/store";
import {
  applyMirrorSnapshot,
  configureRemoteTabContributions,
  useRemoteMirrorStore,
} from "@tabverse/runtime-remote/app-mirror";
import { createRemoteTestContributions } from "@tabverse/test-runtime";

describe("field repro: the host's own snapshot round-trips groups", () => {
  beforeEach(() => configureRemoteTabContributions(createRemoteTestContributions()));
  it("sessionSnapshot output, fed to the mirror, keeps the tree", () => {
    // Host side: build a real grouped state the way the host store holds it.
    useStore.setState({
      tabs: [
        { id: "t1", type: "terminal", title: "zsh", groupId: "g1" } as never,
        { id: "t2", type: "terminal", title: "bash", groupId: "g2" } as never,
      ],
      groups: withPresetGroups([
        { id: "g1", name: "Work", colorIndex: 0, collapsed: false },
        { id: "g2", name: "Sub", colorIndex: 1, collapsed: false, parentId: "g1" },
      ]),
      activeTabId: "t1",
    });
    const snap = sessionSnapshot(useStore.getState());
    // What the wire would carry:
    // Presets are deliberately absent from the snapshot (no tabs in them);
    // the restore chain re-seeds them, so the wire only owes the custom tree.
    expect(snap.groups!.length).toBeGreaterThanOrEqual(2);
    expect(snap.groups!.find((g) => g.name === "Sub")).toBeDefined();

    // Mirror side:
    const ok = applyMirrorSnapshot(snap);
    expect(ok).toBe(true);
    const m = useRemoteMirrorStore.getState();
    expect(m.groups.find((g) => g.name === "Sub")?.parentId).toBe("g1");
    expect(m.tabs.find((t) => t.id === "t1")?.groupId).toBe("g1");
  });
});
