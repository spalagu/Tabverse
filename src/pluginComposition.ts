import {
  createPluginComposition,
  type PluginComposition,
} from "@tabverse/plugin-composition";
import type {
  CatalogStore,
  PluginBlocker,
  PluginBlockerProvider,
  StateEnvelopeProvider,
} from "@tabverse/plugin-kernel";
import type { InstalledPlugin } from "@tabverse/tab-contracts";
import {
  createDesktopBrowserRuntimePlugin,
  createDesktopFilesRuntimePlugin,
  createDesktopRemoteRuntimePlugin,
  createDesktopSettingsRuntimePlugin,
  createDesktopTerminalRuntimePlugin,
} from "@tabverse/runtime-desktop";
import { createBrowserPlugin } from "@tabverse/tab-browser";
import { createTerminalPlugin } from "@tabverse/tab-terminal";
import { createFilesPlugin } from "@tabverse/tab-files";
import { createRemotePlugin } from "@tabverse/tab-remote";
import { createSettingsPlugin } from "@tabverse/tab-settings";
import { sessionSnapshot, useStore } from "./state/store";
import { createDesktopPluginCatalogStore } from "./pluginCatalogStore";
import type { ResidentRuntimeRef } from "@tabverse/tab-contracts";
import { desktopViewBindings } from "./desktopViewBindings";

export interface DesktopPluginCompositionOptions {
  readonly extraPlugins?: readonly InstalledPlugin[];
  readonly store?: CatalogStore;
  readonly blockers?: PluginBlockerProvider;
  readonly stateEnvelopes?: StateEnvelopeProvider;
}

const SETTINGS_CONTROL_PLANE = new Set([
  "tabverse.tab.settings",
  "tabverse.runtime.settings",
]);

async function listResidentRuntimes(): Promise<readonly ResidentRuntimeRef[]> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<readonly ResidentRuntimeRef[]>("resident_list");
}

/** Desktop composition root for all five built-in Tab contributions. */
export function createDesktopPluginComposition(
  options: DesktopPluginCompositionOptions = {},
): PluginComposition {
  const views = desktopViewBindings();
  const terminalRuntime = createDesktopTerminalRuntimePlugin(
    views.terminal,
    (tabId, command, input) => {
      const cwd =
        input !== null &&
        typeof input === "object" &&
        !Array.isArray(input) &&
        typeof (input as { cwd?: unknown }).cwd === "string"
          ? (input as { cwd: string }).cwd
          : undefined;
      useStore
        .getState()
        .splitTerminalPane(tabId, command === "terminal.split-vertical", cwd);
    },
  );
  const filesRuntime = createDesktopFilesRuntimePlugin(views.files);
  const settingsRuntime = createDesktopSettingsRuntimePlugin(
    views.settings,
  );
  const browserRuntime = createDesktopBrowserRuntimePlugin(views.browser);
  const remoteRuntime = createDesktopRemoteRuntimePlugin(views.remote);
  const plugins = [
      terminalRuntime,
      createTerminalPlugin({ runtimePluginId: terminalRuntime.manifest.id }),
      filesRuntime,
      createFilesPlugin({ runtimePluginId: filesRuntime.manifest.id }),
      settingsRuntime,
      createSettingsPlugin({ runtimePluginId: settingsRuntime.manifest.id }),
      browserRuntime,
      createBrowserPlugin({ runtimePluginId: browserRuntime.manifest.id }),
      remoteRuntime,
      createRemotePlugin({ runtimePluginId: remoteRuntime.manifest.id }),
      ...(options.extraPlugins ?? []),
    ];
  const kindsForPlugin = (pluginId: string): ReadonlySet<string> =>
    new Set(
      plugins.flatMap((plugin) =>
        plugin.manifest.id === pluginId ||
        plugin.manifest.dependencies.some((dependency) => dependency.id === pluginId)
          ? [...plugin.manifest.tabs]
          : [],
      ),
    );
  const blockers: PluginBlockerProvider = options.blockers ?? (async (pluginId, context) => {
    if (SETTINGS_CONTROL_PLANE.has(pluginId)) {
      return [{
        type: "external",
        id: "settings-control-plane",
        detail: "Settings is the local PluginCatalog control plane",
      }];
    }
    const state = useStore.getState();
    const kinds = kindsForPlugin(pluginId);
    const result: PluginBlocker[] = state.tabs
      .filter((tab) => kinds.has(tab.type) && tab.share !== undefined)
      .map((tab) => ({
        type: "remote-share" as const,
        id: tab.share!.shareId,
        detail: tab.id,
      }));
    if (
      state.appShare !== null &&
      context.tabContributions.some((contribution) => contribution.remote !== undefined)
    ) {
      result.push({
        type: "remote-share",
        id: state.appShare.shareId,
        detail: "whole-app-share",
      });
    }
    for (const runtime of await listResidentRuntimes()) {
      const owner = state.tabs.find((tab) => tab.id === runtime.tabId);
      if (owner !== undefined && kinds.has(owner.type)) {
        result.push({
          type: "resident-runtime",
          id: runtime.runtimeId,
          detail: runtime.tabId,
        });
      }
    }
    return result;
  });
  const stateEnvelopes: StateEnvelopeProvider = options.stateEnvelopes ?? {
    async capture(pluginId) {
      const state = useStore.getState();
      const kinds = kindsForPlugin(pluginId);
      const session = sessionSnapshot(state);
      return {
        schema: "tabverse-plugin-state/v1",
        tabs: session.tabs.filter((tab) => "kind" in tab && kinds.has(tab.kind)),
        archive: state.archive.filter((entry) => kinds.has(entry.type)),
      };
    },
  };
  return createPluginComposition({
    plugins,
    store: options.store ?? createDesktopPluginCatalogStore(),
    blockers,
    stateEnvelopes,
  });
}

let productionComposition: PluginComposition | undefined;

export function desktopPluginComposition(): PluginComposition {
  productionComposition ??= createDesktopPluginComposition();
  return productionComposition;
}

export function startDesktopPluginComposition(): Promise<PluginComposition> {
  const composition = desktopPluginComposition();
  return composition.start().then(() => composition);
}
