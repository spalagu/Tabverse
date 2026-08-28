import type { ReactNode } from "react";
import type { HostRpc } from "./hostRpc";
import { BrowserPane, type HostFetch } from "./BrowserPane";
import { FilesPane } from "./FilesPane";
import { SettingsPane } from "./SettingsPane";
import {
  RemoteAgentPane,
  type RemoteAgentPaneProps,
} from "./agent/RemoteAgentPane";
import {
  TerminalViewer,
  type TerminalViewerProps,
} from "./terminal/TerminalViewer";
import {
  WorkbenchTabHost,
  defineTabViewRenderers,
  type WorkbenchTabViewModel,
} from "./tabView";
import { STR } from "./strings";

/** Host facts used by the shared remote views, independent of mirror stores. */
export interface RemoteWorkbenchTabModel extends WorkbenchTabViewModel {
  readonly cwd?: string;
  readonly url?: string;
}

export interface RemoteWorkbenchTabViewContext {
  readonly terminal: TerminalViewerProps;
  readonly agent: RemoteAgentPaneProps;
  readonly files: {
    readonly path: string | null;
    readonly dir: string | null;
    readonly rpc: HostRpc;
    readonly readOnly: boolean;
  };
  readonly settings: {
    readonly rpc: HostRpc;
    readonly readOnly: boolean;
  };
  readonly browser: {
    readonly fetchViaHost: HostFetch;
    readonly resolveProxyUrl: (target: string) => string;
  };
}

function unavailable(line: ReactNode): ReactNode {
  return <div className="app-share-content">{line}</div>;
}

const REMOTE_TAB_RENDERERS = defineTabViewRenderers<
  RemoteWorkbenchTabModel,
  RemoteWorkbenchTabViewContext
>({
  terminal: ({ context }) => <TerminalViewer {...context.terminal} />,
  files: ({ context }) => <FilesPane {...context.files} />,
  browser: ({ tab, context }) =>
    tab.url ? (
      <BrowserPane
        url={tab.url}
        fetchViaHost={context.browser.fetchViaHost}
        resolveProxyUrl={context.browser.resolveProxyUrl}
      />
    ) : (
      unavailable(STR.remote.web.appShareLive)
    ),
  agent: ({ context }) => <RemoteAgentPane {...context.agent} />,
  remote: () => unavailable(STR.remote.web.appShareLive),
  settings: ({ context }) => <SettingsPane {...context.settings} />,
});

/**
 * The shared Workbench owner for every tab rendered from an app-share mirror.
 * Join supplies transport-backed ports and host facts; it does not select or
 * compose tab view components itself.
 */
export function RemoteWorkbenchTabView({
  tab,
  context,
  fallback = STR.remote.web.appShareLive,
}: {
  readonly tab: RemoteWorkbenchTabModel | null;
  readonly context: RemoteWorkbenchTabViewContext;
  readonly fallback?: ReactNode;
}) {
  if (tab === null) return unavailable(fallback);
  return (
    <WorkbenchTabHost
      tab={tab}
      active
      context={context}
      renderers={REMOTE_TAB_RENDERERS}
    />
  );
}
