import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAppFrame } from "@tabverse/remote-client/app-frame";
import { resetHostClip } from "@tabverse/remote-client/clipboard";
import {
  REMOTE_MIRROR_ACTION_NAMES,
  applyMirrorAction,
  applyMirrorSnapshot,
  configureRemoteTabContributions,
  mirrorSinks,
  resetRemoteMirror,
  useRemoteMirrorStore,
} from "@tabverse/runtime-remote/app-mirror";
import { createRemoteTestContributions } from "@tabverse/test-runtime";
import { MIRROR_ACTIONS } from "./mirrorActions";

const snapshot = () => ({
  version: 1,
  tabs: [
    {
      id: "terminal",
      type: "terminal",
      title: "zsh",
      groupId: "work",
      lastActiveAt: 10,
    },
    {
      id: "browser",
      type: "browser",
      title: "Docs",
      groupId: null,
      url: "https://example.com",
      lastActiveAt: 20,
    },
    {
      id: "files",
      type: "files",
      title: "Files",
      groupId: "nested",
      cwd: "/workspace",
      lastActiveAt: 30,
    },
  ],
  groups: [
    { id: "work", name: "Work", colorIndex: 1, collapsed: false },
    {
      id: "nested",
      name: "Nested",
      colorIndex: 2,
      collapsed: false,
      parentId: "work",
    },
  ],
  activeTabId: "browser",
  filesOpenPath: { files: "/workspace/readme.md", missing: "/missing" },
  filesOpenDir: { files: "/workspace/src", missing: "/missing" },
});

beforeEach(() => {
  configureRemoteTabContributions(createRemoteTestContributions());
  resetRemoteMirror();
  resetHostClip();
});

describe("remote app mirror snapshots", () => {
  it("lands validated host-renderable state and filters stale file overlays", () => {
    expect(applyMirrorSnapshot(snapshot())).toBe(true);
    const state = useRemoteMirrorStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual([
      "terminal",
      "browser",
      "files",
    ]);
    expect(state.groups.find((group) => group.id === "nested")?.parentId).toBe(
      "work",
    );
    expect(state.groups.slice(0, 3).map((group) => group.id)).toEqual([
      "preset-terminal",
      "preset-files",
      "preset-browser",
    ]);
    expect(state.activeTabId).toBe("browser");
    expect(state.filesOpenPath).toEqual({ files: "/workspace/readme.md" });
    expect(state.filesOpenDir).toEqual({ files: "/workspace/src" });
  });

  it("refuses unknown snapshot versions without replacing the last good state", () => {
    expect(applyMirrorSnapshot(snapshot())).toBe(true);
    expect(applyMirrorSnapshot({ ...snapshot(), version: 3 })).toBe(false);
    expect(applyMirrorSnapshot(null)).toBe(false);
    expect(applyMirrorSnapshot({ version: 1, tabs: "invalid" })).toBe(false);
    expect(useRemoteMirrorStore.getState().activeTabId).toBe("browser");
  });

  it("falls back to the first valid tab when the active id is absent", () => {
    expect(
      applyMirrorSnapshot({ ...snapshot(), activeTabId: "missing" }),
    ).toBe(true);
    expect(useRemoteMirrorStore.getState().activeTabId).toBe("terminal");
  });

  it("viewer registry refuses Settings, Remote and retired Agent rows", () => {
    expect(applyMirrorSnapshot({
      ...snapshot(),
      tabs: [
        ...snapshot().tabs,
        { id: "settings-private", type: "settings", title: "PRIVATE_SETTINGS" },
        { id: "remote-private", type: "remote", title: "PRIVATE_REMOTE" },
        { id: "agent-private", type: "agent", title: "PRIVATE_AGENT" },
      ],
      activeTabId: "settings-private",
    })).toBe(true);
    const state = useRemoteMirrorStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual([
      "terminal",
      "browser",
      "files",
    ]);
    expect(state.activeTabId).toBe("terminal");
    expect(JSON.stringify(state)).not.toContain("PRIVATE_");
  });
});

describe("remote app mirror actions", () => {
  it("implements exactly the action names the desktop host broadcasts", () => {
    expect([...REMOTE_MIRROR_ACTION_NAMES].sort()).toEqual(
      Object.keys(MIRROR_ACTIONS).sort(),
    );
  });

  it("applies the state-bearing action sequence without desktop store code", () => {
    applyMirrorSnapshot(snapshot());
    expect(applyMirrorAction("activateTab", { id: "terminal", now: 40 })).toBe(
      true,
    );
    expect(
      applyMirrorAction("renameTab", { id: "terminal", title: "Remote shell" }),
    ).toBe(true);
    expect(applyMirrorAction("toggleGroupCollapsed", "work")).toBe(true);
    expect(
      applyMirrorAction("setFilesOpenPath", {
        tabId: "files",
        path: "/workspace/new.md",
      }),
    ).toBe(true);
    expect(
      applyMirrorAction("addTab", {
        id: "new-files",
        type: "files",
        title: "New files",
        groupId: null,
        lastActiveAt: 50,
      }),
    ).toBe(true);

    const state = useRemoteMirrorStore.getState();
    expect(state.tabs[0].id).toBe("new-files");
    expect(state.tabs.find((tab) => tab.id === "terminal")?.title).toBe(
      "Remote shell",
    );
    expect(state.groups.find((group) => group.id === "work")?.collapsed).toBe(
      true,
    );
    expect(state.filesOpenPath.files).toBe("/workspace/new.md");
    expect(state.activeTabId).toBe("new-files");
  });

  it("guards malformed and unknown actions", () => {
    applyMirrorSnapshot(snapshot());
    expect(applyMirrorAction("activateTab", 42)).toBe(true);
    expect(applyMirrorAction("not-on-the-wire", null)).toBe(false);
    expect(useRemoteMirrorStore.getState().activeTabId).toBe("browser");
  });
});

describe("remote app mirror frame sinks", () => {
  it("routes snapshots, actions and clipboard frames", () => {
    const writeText = vi.fn((): Promise<void> => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const sinks = mirrorSinks();
    expect(
      dispatchAppFrame({ type: "appSnapshot", state: snapshot() }, sinks),
    ).toBe(true);
    expect(
      dispatchAppFrame(
        { type: "actionApplied", name: "activateTab", args: "terminal" },
        sinks,
      ),
    ).toBe(true);
    expect(
      dispatchAppFrame({ type: "clipSync", seq: 9, text: "copied" }, sinks),
    ).toBe(true);
    expect(useRemoteMirrorStore.getState().activeTabId).toBe("terminal");
    expect(writeText).toHaveBeenCalledWith("copied");
    expect(dispatchAppFrame({ type: "output", data: "ignored" }, sinks)).toBe(
      false,
    );
  });
});
