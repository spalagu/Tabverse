import { createContext, useContext, type ReactNode } from "react";
import type { BrowserTabViewRequest } from "@tabverse/tab-browser";
import type { FilesTabViewRequest } from "@tabverse/tab-files";
import type { RemoteTabViewRequest } from "@tabverse/tab-remote";
import type { SettingsTabViewRequest } from "@tabverse/tab-settings";
import type { TerminalTabViewRequest } from "@tabverse/tab-terminal";
import type { Tab } from "./state/store";
import { BrowserView } from "./components/BrowserView";
import { FilesView } from "./components/files/FilesView";
import { FilePeek } from "./components/files/FilePeek";
import { RemoteView } from "./components/RemoteView";
import { SettingsView } from "./components/SettingsView";
import { TerminalPanes } from "./components/TerminalPanes";
import { installDesktopViewBindings } from "./desktopViewBindings";

export interface DesktopTabHostFacts {
  readonly pageCoverable: boolean;
  readonly pageProxyDown: boolean;
  readonly residentRuntimeId?: string;
}

const DesktopTabHostContext = createContext<DesktopTabHostFacts | null>(null);

export function DesktopTabHostFactsProvider({
  value,
  children,
}: {
  readonly value: DesktopTabHostFacts;
  readonly children: ReactNode;
}) {
  return (
    <DesktopTabHostContext.Provider value={value}>
      {children}
    </DesktopTabHostContext.Provider>
  );
}

function useDesktopTabHostFacts(): DesktopTabHostFacts {
  const facts = useContext(DesktopTabHostContext);
  if (facts === null)
    throw new Error("desktop Tab view is outside its plugin host");
  return facts;
}

function DesktopTerminalTab({
  request,
}: {
  readonly request: TerminalTabViewRequest;
}) {
  const { residentRuntimeId } = useDesktopTabHostFacts();
  return (
    <TerminalPanes
      tab={request.state as unknown as Tab}
      active={request.active}
      residentRuntimeId={residentRuntimeId}
    />
  );
}

function DesktopFilesTab({
  request,
}: {
  readonly request: FilesTabViewRequest;
}) {
  const tab = request.state as unknown as Tab;
  return tab.peek === true ? (
    <FilePeek tab={tab} />
  ) : (
    <FilesView tab={tab} active={request.active} />
  );
}

function DesktopBrowserTab({
  request,
}: {
  readonly request: BrowserTabViewRequest;
}) {
  return (
    <BrowserView
      tab={request.state as unknown as Tab}
      active={request.active}
      session={request.session}
    />
  );
}

function DesktopRemoteTab({
  request,
}: {
  readonly request: RemoteTabViewRequest;
}) {
  const { residentRuntimeId } = useDesktopTabHostFacts();
  return (
    <RemoteView
      tab={request.state as unknown as Tab}
      active={request.active}
      residentRuntimeId={residentRuntimeId}
    />
  );
}

function DesktopSettingsTab() {
  const { pageCoverable, pageProxyDown } = useDesktopTabHostFacts();
  return (
    <SettingsView isCoverable={pageCoverable} pageProxyDown={pageProxyDown} />
  );
}

export const renderDesktopTerminalTab = (
  request: TerminalTabViewRequest,
): ReactNode => <DesktopTerminalTab request={request} />;

export const renderDesktopFilesTab = (
  request: FilesTabViewRequest,
): ReactNode => <DesktopFilesTab request={request} />;

export const renderDesktopBrowserTab = (
  request: BrowserTabViewRequest,
): ReactNode => <DesktopBrowserTab request={request} />;

export const renderDesktopRemoteTab = (
  request: RemoteTabViewRequest,
): ReactNode => <DesktopRemoteTab request={request} />;

export const renderDesktopSettingsTab = (
  _request: SettingsTabViewRequest,
): ReactNode => <DesktopSettingsTab />;

export function installDesktopTabViews(): void {
  installDesktopViewBindings({
    terminal: renderDesktopTerminalTab,
    files: renderDesktopFilesTab,
    browser: renderDesktopBrowserTab,
    remote: renderDesktopRemoteTab,
    settings: renderDesktopSettingsTab,
  });
}
