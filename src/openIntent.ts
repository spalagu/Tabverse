import {
  OPEN_INTENT_ROUTER,
  pathOpenIntent,
  type OpenIntent,
} from "@tabverse/runtime-contracts";
import type { Tab } from "./state/store";

export const OPEN_INTENT_EVENT = "tabverse-open-intent";

export type OpenIntentTab = Partial<Tab> & { type: Tab["type"] };

/** The one product routing point from an ingress intent to a Tabverse tab. */
export function tabForOpenIntent(intent: OpenIntent): OpenIntentTab | null {
  const route = OPEN_INTENT_ROUTER.route(intent);
  switch (route.kind) {
    case "content":
      return { type: "files", openPath: route.path };
    case "browser":
      return { type: "browser", url: route.url };
    case "terminal":
      return { type: "terminal", runOnStart: terminalCommand(route.url) };
    case "external":
      return null;
  }
}

export function requestPathOpen(path: string): void {
  window.dispatchEvent(
    new CustomEvent<OpenIntent>(OPEN_INTENT_EVENT, {
      detail: pathOpenIntent(path),
    }),
  );
}

function terminalCommand(raw: string): string {
  const url = new URL(raw);
  const scheme = url.protocol.slice(0, -1);
  const target = `${url.username ? `${url.username}@` : ""}${url.hostname}`;
  const quoted = `'${target.replaceAll("'", `'\\''`)}'`;
  if (scheme === "ssh" && url.port) return `ssh -p ${url.port} ${quoted}`;
  if (scheme === "telnet" && url.port) return `telnet ${quoted} ${url.port}`;
  return `${scheme} ${quoted}`;
}
