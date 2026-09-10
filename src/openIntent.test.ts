import { describe, expect, it, vi } from "vitest";
import { pathOpenIntent, urlOpenIntent } from "@tabverse/runtime-contracts";
import {
  OPEN_INTENT_EVENT,
  requestPathOpen,
  tabForOpenIntent,
} from "./openIntent";

describe("Tabverse OpenIntent ingress", () => {
  it("opens content and browser intents as native tabs", () => {
    expect(tabForOpenIntent(pathOpenIntent("/work/README.md"))).toEqual({
      type: "files",
      openPath: "/work/README.md",
    });
    expect(tabForOpenIntent(urlOpenIntent("https://example.com"))).toEqual({
      type: "browser",
      url: "https://example.com",
    });
  });

  it("turns remote shell URLs into one-shot terminal commands", () => {
    expect(tabForOpenIntent(urlOpenIntent("ssh://me@host:2222"))).toEqual({
      type: "terminal",
      runOnStart: "ssh -p 2222 'me@host'",
    });
    expect(tabForOpenIntent(urlOpenIntent("telnet://host:23"))).toEqual({
      type: "terminal",
      runOnStart: "telnet 'host' 23",
    });
  });

  it("does not claim unknown URL schemes", () => {
    expect(tabForOpenIntent(urlOpenIntent("mailto:user@example.com"))).toBeNull();
  });

  it("publishes downloaded paths through the shared ingress event", () => {
    const receive = vi.fn();
    window.addEventListener(OPEN_INTENT_EVENT, receive, { once: true });
    requestPathOpen("/downloads/report.pdf");
    expect((receive.mock.calls[0][0] as CustomEvent).detail).toEqual({
      kind: "path",
      path: "/downloads/report.pdf",
    });
  });
});
