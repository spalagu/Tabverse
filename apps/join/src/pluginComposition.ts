import {
  createPluginComposition,
  type PluginComposition,
} from "@tabverse/plugin-composition";
import type { CatalogStore } from "@tabverse/plugin-kernel";
import type { InstalledPlugin } from "@tabverse/tab-contracts";
import {
  createRemoteBrowserRuntimePlugin,
  createRemoteFilesRuntimePlugin,
  createRemoteTerminalRuntimePlugin,
} from "@tabverse/runtime-remote";
import { createBrowserPlugin } from "@tabverse/tab-browser";
import { createTerminalPlugin } from "@tabverse/tab-terminal";
import { createFilesPlugin } from "@tabverse/tab-files";
import { configureRemoteTabContributions } from "@tabverse/runtime-remote/app-mirror";
import { joinViewBindings } from "./viewBindings";

export interface JoinPluginCompositionOptions {
  readonly extraPlugins?: readonly InstalledPlugin[];
  readonly store?: CatalogStore;
}

/** Join composition root: Remote and Settings are intentionally local-only. */
export function createJoinPluginComposition(
  options: JoinPluginCompositionOptions = {},
): PluginComposition {
  const views = joinViewBindings();
  const terminalRuntime = createRemoteTerminalRuntimePlugin(
    views.terminal,
  );
  const filesRuntime = createRemoteFilesRuntimePlugin(views.files);
  const browserRuntime = createRemoteBrowserRuntimePlugin(views.browser);
  return createPluginComposition({
    plugins: [
      terminalRuntime,
      createTerminalPlugin({ runtimePluginId: terminalRuntime.manifest.id }),
      filesRuntime,
      createFilesPlugin({ runtimePluginId: filesRuntime.manifest.id }),
      browserRuntime,
      createBrowserPlugin({ runtimePluginId: browserRuntime.manifest.id }),
      ...(options.extraPlugins ?? []),
    ],
    store: options.store,
  });
}

let productionComposition: PluginComposition | undefined;
let remoteProjectionSubscribed = false;

export function joinPluginComposition(): PluginComposition {
  productionComposition ??= createJoinPluginComposition();
  return productionComposition;
}

export function startJoinPluginComposition(): Promise<PluginComposition> {
  const composition = joinPluginComposition();
  return composition.start().then(async () => {
    const refresh = async () => {
      configureRemoteTabContributions(await composition.tabContributions());
    };
    await refresh();
    if (!remoteProjectionSubscribed) {
      remoteProjectionSubscribed = true;
      composition.subscribe(() => {
        void refresh().catch((error: unknown) => {
          console.error("Failed to refresh Join remote Tab contributions", error);
        });
      });
    }
    return composition;
  });
}
