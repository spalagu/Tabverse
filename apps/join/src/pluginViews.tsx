import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { TabInstanceScope } from "@tabverse/tab-contracts";
import type { PluginComposition } from "@tabverse/plugin-composition";
import type { BrowserTabViewRequest } from "@tabverse/tab-browser";
import type { FilesTabViewRequest } from "@tabverse/tab-files";
import type { TerminalTabViewRequest } from "@tabverse/tab-terminal";
import { BrowserPane } from "@tabverse/workbench/browser-pane";
import { FilesPane } from "@tabverse/workbench/files-pane";
import type { HostRpc } from "@tabverse/workbench/host-rpc";
import {
  TerminalViewer,
  type TerminalViewerProps,
} from "@tabverse/workbench/terminal/viewer";
import { STR } from "@tabverse/workbench/strings";
import type { RemoteMirrorTab } from "@tabverse/runtime-remote/app-mirror";
import { installJoinViewBindings } from "./viewBindings";

export interface JoinTabViewContext {
  readonly terminal: TerminalViewerProps;
  readonly files: {
    readonly openPath: Readonly<Record<string, string>>;
    readonly openDir: Readonly<Record<string, string>>;
    readonly rpc: HostRpc;
    readonly readOnly: boolean;
  };
  readonly browser: {
    readonly requestViaHost: (tabId: string, url: string) => Promise<Response>;
    readonly resolveProxyUrl: (target: string) => string;
  };
}

const JoinTabContext = createContext<JoinTabViewContext | null>(null);

function useJoinTabContext(): JoinTabViewContext {
  const context = useContext(JoinTabContext);
  if (context === null) throw new Error("remote Tab view is outside its plugin host");
  return context;
}

function JoinTerminalTab() {
  return <TerminalViewer {...useJoinTabContext().terminal} />;
}

function JoinFilesTab({ request }: { readonly request: FilesTabViewRequest }) {
  const files = useJoinTabContext().files;
  return (
    <FilesPane
      path={files.openPath[request.tabId] ?? null}
      dir={files.openDir[request.tabId] ?? request.state.cwd ?? null}
      rpc={files.rpc}
      readOnly={files.readOnly}
    />
  );
}

function JoinBrowserTab({ request }: { readonly request: BrowserTabViewRequest }) {
  const { browser } = useJoinTabContext();
  return request.state.url ? (
    <BrowserPane
      url={request.state.url}
      fetchViaHost={(url) => browser.requestViaHost(request.tabId, url)}
      resolveProxyUrl={browser.resolveProxyUrl}
    />
  ) : (
    <div className="app-share-content">{STR.remote.web.appShareLive}</div>
  );
}

export const renderJoinTerminalTab = (_request: TerminalTabViewRequest): ReactNode =>
  <JoinTerminalTab />;

export const renderJoinFilesTab = (request: FilesTabViewRequest): ReactNode =>
  <JoinFilesTab request={request} />;

export const renderJoinBrowserTab = (request: BrowserTabViewRequest): ReactNode =>
  <JoinBrowserTab request={request} />;

export function installJoinTabViews(): void {
  installJoinViewBindings({
    terminal: renderJoinTerminalTab,
    files: renderJoinFilesTab,
    browser: renderJoinBrowserTab,
  });
}

export function JoinPluginTabView({
  tab,
  context,
  composition,
}: {
  readonly tab: RemoteMirrorTab | null;
  readonly context: JoinTabViewContext;
  readonly composition: PluginComposition;
}) {
  const [instance, setInstance] = useState<TabInstanceScope | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: TabInstanceScope | null = null;
    setInstance(null);
    setFailure(null);
    if (tab === null) return;
    void composition.createInstance(tab.type, tab.id).then(async (scope) => {
      if (cancelled) {
        await scope.dispose();
        return;
      }
      created = scope;
      setInstance(scope);
    }).catch((error: unknown) => {
      if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
      if (created !== null) void created.dispose();
    };
  }, [composition, tab?.id, tab?.type]);

  if (tab === null) return <div className="app-share-content">{STR.remote.web.appShareLive}</div>;
  if (failure !== null) {
    return <div className="remote-connecting">Plugin “{tab.type}” unavailable: {failure}</div>;
  }
  if (instance === null) {
    return <div className="remote-connecting">Loading {tab.type} plugin…</div>;
  }
  const output = instance.contribution.view.render({
    tabId: tab.id,
    state: tab,
    active: true,
    services: instance,
  });
  return <JoinTabContext.Provider value={context}>{output as ReactNode}</JoinTabContext.Provider>;
}
