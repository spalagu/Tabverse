import type { BrowserTabViewRequest } from "@tabverse/tab-browser";
import type { FilesTabViewRequest } from "@tabverse/tab-files";
import type { RemoteTabViewRequest } from "@tabverse/tab-remote";
import type { SettingsTabViewRequest } from "@tabverse/tab-settings";
import type { TerminalTabViewRequest } from "@tabverse/tab-terminal";

export interface DesktopViewBindings {
  readonly terminal: (request: TerminalTabViewRequest) => unknown;
  readonly files: (request: FilesTabViewRequest) => unknown;
  readonly browser: (request: BrowserTabViewRequest) => unknown;
  readonly remote: (request: RemoteTabViewRequest) => unknown;
  readonly settings: (request: SettingsTabViewRequest) => unknown;
}

const descriptorBindings: DesktopViewBindings = {
  terminal: (request) => request,
  files: (request) => request,
  browser: (request) => request,
  remote: (request) => request,
  settings: (request) => request,
};

let bindings = descriptorBindings;

export function installDesktopViewBindings(next: DesktopViewBindings): void {
  bindings = Object.freeze({ ...next });
}

export function desktopViewBindings(): DesktopViewBindings {
  return bindings;
}
