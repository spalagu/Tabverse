import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDesktopPluginComposition } from "../../../src/pluginComposition";
import { createJoinPluginComposition } from "../../../apps/join/src/pluginComposition";
import { RemoteClientState, createRemoteTabSet } from "@tabverse/remote-protocol";
import { tabDefinitionsFromContributions } from "@tabverse/workbench/tabs";
import {
  configureRemoteTabContributions,
  remoteTabDefinitions,
} from "@tabverse/runtime-remote/app-mirror";
import {
  REFERENCE_PLUGIN_ID,
  REFERENCE_TAB_KIND,
  createReferenceTabPlugin,
  type ReferencePluginProbe,
} from "@tabverse/test-runtime/reference-tab";

function probe(): ReferencePluginProbe {
  return {
    pluginActivations: 0,
    pluginDisposals: 0,
    instanceActivations: 0,
    instanceDisposals: 0,
    commandRuns: 0,
  };
}

describe("Desktop and Join plugin composition roots", () => {
  it("composes independent built-ins and keeps local-only kinds out of Join", async () => {
    const desktop = createDesktopPluginComposition();
    const joinApp = createJoinPluginComposition();

    const [desktopSnapshot, joinSnapshot] = await Promise.all([
      desktop.start(),
      joinApp.start(),
    ]);

    const sharedKinds = new Set(["terminal", "files", "browser"]);
    expect(
      desktop.manifests.filter((manifest) => manifest.tabs.some((kind) => sharedKinds.has(kind))),
    ).toEqual(
      joinApp.manifests.filter((manifest) => manifest.tabs.some((kind) => sharedKinds.has(kind))),
    );
    expect(desktopSnapshot.plugins["tabverse.tab.settings"]?.state).toBe("enabled");
    expect(joinSnapshot.plugins["tabverse.tab.settings"]).toBeUndefined();
    expect(joinSnapshot.plugins["tabverse.runtime.settings"]).toBeUndefined();
    expect(joinSnapshot.plugins["tabverse.tab.remote"]).toBeUndefined();
    expect(joinSnapshot.plugins["tabverse.runtime.remote"]).toBeUndefined();
    expect(await desktop.diagnostics()).toMatchObject({
      tabKinds: ["browser", "files", "remote", "settings", "terminal"],
    });
    expect(await joinApp.diagnostics()).toMatchObject({
      tabKinds: ["browser", "files", "terminal"],
    });
    expect(createRemoteTabSet(await desktop.tabContributions()).map((tab) => tab.kind)).toEqual([
      "browser",
      "files",
      "terminal",
    ]);
    expect(createRemoteTabSet(await joinApp.tabContributions()).map((tab) => tab.kind)).toEqual([
      "browser",
      "files",
      "terminal",
    ]);
    expect(desktop.manifests.flatMap((manifest) => manifest.tabs)).not.toContain("agent");
    await expect(desktop.createInstance("agent", "retired-agent")).rejects.toMatchObject({
      code: "UNKNOWN_TAB_KIND",
    });

    const desktopTerminal = await desktop.createInstance("terminal", "desktop-terminal");
    const joinTerminal = await joinApp.createInstance("terminal", "join-terminal");
    const desktopFiles = await desktop.createInstance("files", "desktop-files");
    const joinFiles = await joinApp.createInstance("files", "join-files");
    const desktopRemote = await desktop.createInstance("remote", "desktop-remote");
    const desktopSettings = await desktop.createInstance("settings", "desktop-settings");
    expect(desktopSettings.contribution.remote).toBeUndefined();
    expect(desktopSettings.contribution.resident).toBeUndefined();
    await expect(joinApp.createInstance("settings", "join-settings")).rejects.toMatchObject({
      code: "UNKNOWN_TAB_KIND",
    });
    await expect(joinApp.createInstance("remote", "join-remote")).rejects.toMatchObject({
      code: "UNKNOWN_TAB_KIND",
    });
    expect(desktopTerminal.pluginId).toBe("tabverse.tab.terminal");
    expect(joinTerminal.pluginId).toBe("tabverse.tab.terminal");
    const desktopBrowser = await desktop.createInstance("browser", "desktop-browser");
    const joinBrowser = await joinApp.createInstance("browser", "join-browser");
    expect(desktopBrowser.pluginId).toBe("tabverse.tab.browser");
    expect(joinBrowser.pluginId).toBe("tabverse.tab.browser");
    expect(desktopTerminal.contribution.resident).toMatchObject({
      capability: "continuous",
      runtimeKind: "terminal",
    });
    expect(joinTerminal.contribution.resident).toBeUndefined();
    expect(desktopRemote.contribution.resident).toMatchObject({
      capability: "continuous",
      runtimeKind: "remote",
    });
    for (const instance of [desktopFiles, joinFiles]) {
      expect(instance.contribution.resident).toEqual({
        capability: "state-only",
        runtimeKind: "files",
      });
    }
    expect(desktopBrowser.contribution.resident).toMatchObject({
      capability: "state-only",
      runtimeKind: "browser",
      continuousTasks: [{ capability: "continuous", runtimeKind: "browser-network" }],
    });
    expect(joinBrowser.contribution.resident).toEqual({
      capability: "state-only",
      runtimeKind: "browser",
    });
    expect(desktopTerminal.contribution.view.render({
      tabId: desktopTerminal.tabId,
      state: { title: "Terminal" },
      active: true,
      services: desktopTerminal,
    })).toMatchObject({ runtimeKind: "desktop", kind: "terminal" });
    expect(joinTerminal.contribution.view.render({
      tabId: joinTerminal.tabId,
      state: { title: "Terminal" },
      active: true,
      services: joinTerminal,
    })).toMatchObject({ runtimeKind: "remote", kind: "terminal" });

    const remote = desktopTerminal.contribution.remote!;
    const initialSnapshot = await remote.state.snapshot(desktopTerminal.tabId);
    const frames: unknown[] = [];
    const subscription = await remote.state.subscribe(
      desktopTerminal.tabId,
      { epoch: initialSnapshot.epoch, ackedFrameSeq: initialSnapshot.lastFrameSeq },
      (frame) => frames.push(frame),
    );
    const nextTerminalState = {
      title: "Terminal",
      cwd: "/workspace",
      share: { ticket: "must-not-cross-the-wire" },
    };
    desktopTerminal.contribution.view.render({
      tabId: desktopTerminal.tabId,
      state: nextTerminalState,
      active: true,
      services: desktopTerminal,
    });
    expect(frames).toHaveLength(1);
    const client = new RemoteClientState<unknown, unknown>(remote.client.fold);
    client.installSnapshot(initialSnapshot);
    expect(client.receive(frames[0] as Parameters<typeof client.receive>[0])).toBe("applied");
    expect(client.state).toEqual({ title: "Terminal", cwd: "/workspace" });
    await subscription.dispose();

    await Promise.all([
      desktopTerminal.dispose(),
      joinTerminal.dispose(),
      desktopFiles.dispose(),
      joinFiles.dispose(),
      desktopRemote.dispose(),
      desktopSettings.dispose(),
      desktopBrowser.dispose(),
      joinBrowser.dispose(),
    ]);
    await Promise.all([desktop.dispose(), joinApp.dispose()]);
  });

  it("adds one full-surface reference Tab to both roots with no core kind branch", async () => {
    const desktopProbe = probe();
    const joinProbe = probe();
    const desktop = createDesktopPluginComposition({
      extraPlugins: [createReferenceTabPlugin(desktopProbe)],
    });
    const joinApp = createJoinPluginComposition({
      extraPlugins: [createReferenceTabPlugin(joinProbe)],
    });

    await Promise.all([desktop.start(), desktop.start(), joinApp.start()]);
    expect(desktop.manifests.some((manifest) => manifest.id === REFERENCE_PLUGIN_ID)).toBe(true);
    expect(joinApp.manifests.some((manifest) => manifest.id === REFERENCE_PLUGIN_ID)).toBe(true);
    expect(await desktop.diagnostics()).toMatchObject({
      activePlugins: expect.arrayContaining([REFERENCE_PLUGIN_ID]),
      tabKinds: expect.arrayContaining([REFERENCE_TAB_KIND]),
    });
    expect(await joinApp.diagnostics()).toMatchObject({
      activePlugins: expect.arrayContaining([REFERENCE_PLUGIN_ID]),
      tabKinds: expect.arrayContaining([REFERENCE_TAB_KIND]),
    });
    const desktopContributions = await desktop.tabContributions();
    const joinContributions = await joinApp.tabContributions();
    expect(
      tabDefinitionsFromContributions(desktopContributions).map(({ type }) => type),
    ).toContain(REFERENCE_TAB_KIND);
    configureRemoteTabContributions(joinContributions);
    expect(remoteTabDefinitions().map(({ type }) => type)).toContain(REFERENCE_TAB_KIND);

    const desktopTab = await desktop.createInstance(REFERENCE_TAB_KIND, "desktop-reference");
    const joinTab = await joinApp.createInstance(REFERENCE_TAB_KIND, "join-reference");
    const initial = { message: "everything is a tab", count: 1 };
    expect(desktopTab.contribution.state.parse(initial)).toEqual(initial);
    expect(desktopTab.contribution.state.migrate("legacy", 0)).toEqual({
      message: "legacy",
      count: 0,
    });
    expect(desktopTab.contribution.view.render({
      tabId: desktopTab.tabId,
      state: initial,
      active: true,
      services: desktopTab,
    })).toEqual({
      component: "ReferenceTab",
      tabId: "desktop-reference",
      state: initial,
      active: true,
    });
    await expect(
      Promise.resolve(
        desktopTab.contribution.commands?.[0]?.run(desktopTab.tabId, initial),
      ),
    ).resolves.toEqual({ ...initial, count: 2 });
    expect(await desktopTab.contribution.remote?.state.snapshot(desktopTab.tabId))
      .toMatchObject({ state: initial, lastFrameSeq: 0n });
    expect(desktopTab.contribution.remote?.intents.map((intent) => intent.name)).toEqual([
      "fixture.reference.increment",
    ]);
    expect(desktopTab.contribution.remote?.privateStreams?.streams).toEqual([
      { name: "fixture.private", minAccess: "view" },
    ]);
    expect(desktopTab.contribution.resident).toEqual({
      capability: "state-only",
      runtimeKind: "fixture-reference",
    });

    const coreFiles = [
      "packages/runtime-contracts/src/index.ts",
      "packages/workbench/src/tabs.ts",
      "packages/runtime-remote/src/appMirror.ts",
      "src/components/NewTabMenu.tsx",
      "src/components/TabContent.tsx",
    ];
    for (const path of coreFiles) {
      expect(readFileSync(join(process.cwd(), path), "utf8")).not.toContain(
        REFERENCE_TAB_KIND,
      );
    }

    await Promise.all([desktopTab.dispose(), joinTab.dispose()]);
    await Promise.all([desktop.dispose(), joinApp.dispose()]);
    expect(desktopProbe).toEqual({
      pluginActivations: 1,
      pluginDisposals: 1,
      instanceActivations: 1,
      instanceDisposals: 1,
      commandRuns: 1,
    });
    expect(joinProbe).toEqual({
      pluginActivations: 1,
      pluginDisposals: 1,
      instanceActivations: 1,
      instanceDisposals: 1,
      commandRuns: 0,
    });
  });
});
