import { create } from "zustand";
import { describe, expect, it } from "vitest";
import { createAppStore, type AppStore } from "../../state/store";
import {
  isRemoteAppActionAllowed,
  remoteAppSnapshot,
} from "./remoteBoundary";

const store = () => create<AppStore>()((set, get) => createAppStore(set, get));

describe("whole-app remote privacy boundary", () => {
  it("removes Settings and unknown Agent references from tabs, groups, active state, splits, and overlays", () => {
    const api = store();
    const terminal = api.getState().addTab({ type: "terminal", title: "Shell" });
    const settings = api.getState().addTab({ type: "settings", title: "PRIVATE_SETTINGS_MARKER" });
    const files = api.getState().addTab({ type: "files", title: "Files" });
    api.setState((state) => ({
      tabs: [
        ...state.tabs.map((tab) =>
          tab.id === terminal
            ? { ...tab, groupId: "remote-parent" }
            : tab.id === settings
              ? { ...tab, groupId: "settings-only" }
              : tab,
        ),
        {
          id: "retired-agent-id",
          type: "agent",
          title: "PRIVATE_AGENT_MARKER",
          groupId: "agent-only",
        } as never,
      ],
      groups: [
        ...state.groups,
        { id: "remote-parent", name: "Remote group", colorIndex: 0, collapsed: false },
        { id: "settings-only", name: "PRIVATE_SETTINGS_GROUP", colorIndex: 0, collapsed: false },
        { id: "agent-only", name: "PRIVATE_AGENT_GROUP", colorIndex: 0, collapsed: false },
      ],
      activeTabId: settings,
      split: {
        ids: [terminal, settings, files],
        ratios: [0.2, 0.3, 0.5],
        vertical: false,
      },
      filesOpenPath: {
        [files]: "/visible.txt",
        [settings]: "/PRIVATE_SETTINGS_PATH",
        "retired-agent-id": "/PRIVATE_AGENT_PATH",
      },
      filesOpenDir: {
        [files]: "/visible",
        [settings]: "/PRIVATE_SETTINGS_DIR",
      },
    }));

    const snapshot = remoteAppSnapshot(api.getState());
    const visibleIds = (snapshot.tabs as Array<{ id: string }>).map((tab) => tab.id);
    expect(new Set(visibleIds)).toEqual(new Set([terminal, files]));
    expect(snapshot.activeTabId).toBe(visibleIds[0]);
    expect((snapshot.split as { ids: string[] }).ids).toEqual([terminal, files]);
    expect(snapshot.filesOpenPath).toEqual({ [files]: "/visible.txt" });
    expect(snapshot.filesOpenDir).toEqual({ [files]: "/visible" });
    const wire = JSON.stringify(snapshot);
    for (const marker of ["settings", "agent", "PRIVATE_"]) {
      expect(wire.toLowerCase()).not.toContain(marker.toLowerCase());
    }
  });

  it("rejects every v3 action that targets Settings or Agent", () => {
    const api = store();
    const terminal = api.getState().addTab({ type: "terminal" });
    const settings = api.getState().addTab({ type: "settings" });
    api.setState((state) => ({
      tabs: [
        ...state.tabs,
        { id: "agent-private", type: "agent", title: "Agent", groupId: null } as never,
      ],
      activeTabId: terminal,
    }));
    const state = api.getState();
    expect(isRemoteAppActionAllowed(state, "activateTab", terminal)).toBe(true);
    for (const args of [
      settings,
      { id: settings },
      { tabId: settings, x: 1, y: 2 },
      "agent-private",
      { id: "agent-private" },
      { type: "settings" },
      { type: "agent" },
    ]) {
      for (const name of ["activateTab", "closeTab", "openMenu", "renameTab", "addTab"]) {
        expect(isRemoteAppActionAllowed(state, name, args)).toBe(false);
      }
    }
  });
});
