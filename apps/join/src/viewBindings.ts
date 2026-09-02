import type { BrowserTabViewRequest } from "@tabverse/tab-browser";
import type { FilesTabViewRequest } from "@tabverse/tab-files";
import type { TerminalTabViewRequest } from "@tabverse/tab-terminal";

export interface JoinViewBindings {
  readonly terminal: (request: TerminalTabViewRequest) => unknown;
  readonly files: (request: FilesTabViewRequest) => unknown;
  readonly browser: (request: BrowserTabViewRequest) => unknown;
}

let bindings: JoinViewBindings = {
  terminal: (request) => request,
  files: (request) => request,
  browser: (request) => request,
};

export function installJoinViewBindings(next: JoinViewBindings): void {
  bindings = Object.freeze({ ...next });
}

export function joinViewBindings(): JoinViewBindings {
  return bindings;
}
