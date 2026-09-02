import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCatalogStore } from "@tabverse/plugin-kernel";
import { TERMINAL_PLUGIN_ID } from "@tabverse/tab-terminal";
import { SETTINGS_PLUGIN_ID } from "@tabverse/tab-settings";
import { BROWSER_PLUGIN_ID } from "@tabverse/tab-browser";
import { createDesktopPluginComposition } from "./pluginComposition";
import { useStore } from "./state/store";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

afterEach(() => {
  useStore.setState({ tabs: [], activeTabId: null, appShare: null });
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  mocks.invoke.mockReset();
});

describe("Desktop PluginCatalog lifecycle policy", () => {
  it("blocks active shares, retains inactive Tab state and protects Settings", async () => {
    const store = new MemoryCatalogStore();
    const composition = createDesktopPluginComposition({ store });
    await composition.start();
    const tabId = useStore.getState().addTab({ type: "terminal", title: "Kept terminal" });
    useStore.setState((state) => ({
      tabs: state.tabs.map((tab) => tab.id === tabId ? {
        ...tab,
        share: {
          shareId: "share-1",
          ticket: "redacted-fixture",
          joinLink: "https://fixture.invalid/#redacted",
          access: "steer",
          viewers: [],
          ttlSecs: 60,
          startedAt: 1,
        },
      } : tab),
    }));

    await expect(composition.disable(TERMINAL_PLUGIN_ID)).rejects.toMatchObject({
      code: "PLUGIN_BLOCKED",
      details: { blockers: [{ type: "remote-share", id: "share-1", detail: tabId }] },
    });

    useStore.setState((state) => ({
      tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, share: undefined } : tab),
    }));
    await composition.disable(TERMINAL_PLUGIN_ID);
    await composition.uninstall(TERMINAL_PLUGIN_ID);
    expect((await store.load()).retainedState[TERMINAL_PLUGIN_ID].payload).toMatchObject({
      schema: "tabverse-plugin-state/v1",
      tabs: [{ id: tabId, kind: "terminal", title: "Kept terminal" }],
    });
    await expect(
      composition.createInstance("terminal", "after-uninstall"),
    ).rejects.toMatchObject({ code: "UNKNOWN_TAB_KIND" });
    expect(
      (await composition.tabContributions()).some(
        (contribution) => contribution.manifest.kind === "terminal",
      ),
    ).toBe(false);

    await expect(composition.disable(SETTINGS_PLUGIN_ID)).rejects.toMatchObject({
      code: "PLUGIN_BLOCKED",
      details: { blockers: [{ type: "external", id: "settings-control-plane" }] },
    });
    useStore.setState({
      appShare: {
        shareId: "app-share-1",
        ticket: "redacted-fixture",
        joinLink: "https://fixture.invalid/#redacted",
        access: "steer",
        viewers: [],
        ttlSecs: 60,
        startedAt: 1,
      },
    });
    await expect(composition.disable(BROWSER_PLUGIN_ID)).rejects.toMatchObject({
      code: "PLUGIN_BLOCKED",
      details: {
        blockers: [{ type: "remote-share", id: "app-share-1", detail: "whole-app-share" }],
      },
    });
    await composition.dispose();
  });

  it("maps a Supervisor runtime back to its plugin before lifecycle mutation", async () => {
    const composition = createDesktopPluginComposition({ store: new MemoryCatalogStore() });
    await composition.start();
    const tabId = useStore.getState().addTab({ type: "terminal" });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mocks.invoke.mockImplementation(async (command: string) => command === "resident_list" ? [{
      runtimeId: "runtime-1",
      tabId,
      kind: "terminal",
      generation: 1,
      pluginVersion: "1.0.0",
      artifactSlot: "slot-1",
      leaseId: "lease-1",
    }] : undefined);

    await expect(composition.disable(TERMINAL_PLUGIN_ID)).rejects.toMatchObject({
      code: "PLUGIN_BLOCKED",
      details: {
        blockers: [{ type: "resident-runtime", id: "runtime-1", detail: tabId }],
      },
    });
    await composition.dispose();
  });
});
