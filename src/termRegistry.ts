/**
 * Live terminal instances by tab id. Lets app-level features (sharing, future
 * command palette actions) reach into a mounted terminal without threading
 * refs through the component tree.
 */
import type { TerminalSessionApi } from "@tabverse/workbench/terminal/session-registration";

export type TermApi = TerminalSessionApi;

const registry = new Map<string, TermApi>();

export function termKey(tabId: string, paneId?: string): string {
  return paneId === undefined || paneId === tabId ? tabId : `${tabId}:${paneId}`;
}

export function registerTerm(tabId: string, api: TermApi, paneId?: string) {
  registry.set(termKey(tabId, paneId), api);
  // Dev-only handle so UI tests can drive a terminal without synthesising key
  // events, which xterm ignores unless they come from a real keyboard.
  if (import.meta.env.DEV) {
    (window as unknown as { __tabverse?: unknown }).__tabverse = {
      terms: registry,
      run: (cmd: string, id?: string) => {
        const api = id ? registry.get(id) : [...registry.values()][0];
        api?.runCommand(cmd);
      },
    };
  }
}

export function unregisterTerm(tabId: string, paneId?: string) {
  registry.delete(termKey(tabId, paneId));
}

export function getTerm(tabId: string): TermApi | undefined {
  return registry.get(tabId);
}

/** One pane's terminal, for a caller that knows which pane it means. */
export function getPaneTerm(tabId: string, paneId?: string): TermApi | undefined {
  return registry.get(termKey(tabId, paneId));
}
