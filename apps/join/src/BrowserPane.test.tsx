import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserPane } from "@tabverse/workbench/browser-pane";
import { proxyUrlFor } from "@tabverse/remote-client/proxy-fetch";
import { STR } from "@tabverse/workbench/strings";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = (node: ReactNode) => {
  act(() => {
    root.render(node);
  });
};

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const htmlDoc =
  "<html><head><title>Wiki</title></head><body><h1>Intranet wiki</h1></body></html>";

const okHtml = (): Promise<Response> =>
  Promise.resolve(
    new Response(htmlDoc, {
      status: 200,
      headers: { "content-type": "text/html" },
    })
  );

describe("BrowserPane", () => {
  it("mirrored: an HTML answer renders in a sandboxed srcdoc frame, its base aimed at the proxy endpoint", async () => {
    mount(
      createElement(BrowserPane, {
        url: "http://intranet.local/wiki/Home",
        fetchViaHost: okHtml,
        resolveProxyUrl: proxyUrlFor,
      })
    );
    await flush();

    const frame = host.querySelector<HTMLIFrameElement>(".browser-pane-frame");
    expect(frame).not.toBeNull();
    // Scripts may not run; same origin is kept so relative URLs load
    // against the join origin rather than dying on a CORS wall.
    expect(frame!.getAttribute("sandbox")).toBe("allow-same-origin");
    // The document's directory, mirrored onto the endpoint path the
    // page's fetch patch (and, later, the SW arm) answers.
    expect(frame!.getAttribute("srcdoc")).toContain(
      '<base href="/__tabverse_proxy/http/intranet.local/wiki/">'
    );
    expect(frame!.getAttribute("srcdoc")).toContain("<h1>Intranet wiki</h1>");
    expect(host.querySelector(".browser-pane-chip")).not.toBeNull();
    // A document without a head still gets the base — synthetically.
    mount(
      createElement(BrowserPane, {
        url: "http://intranet.local/bare",
        resolveProxyUrl: proxyUrlFor,
        fetchViaHost: async () =>
          new Response("<p>bare</p>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      })
    );
    await flush();
    const bare = host.querySelector<HTMLIFrameElement>(".browser-pane-frame");
    expect(bare!.getAttribute("srcdoc")).toContain("<head><base href=");
  });

  it("unmirrored by refusal: the annotation, the transport's words, and the original URL as a plain link — never a frame", async () => {
    const asked: string[] = [];
    mount(
      createElement(BrowserPane, {
        // http, not https: an https target is refused BEFORE the fetch
        // now (the proxy's kernel is plain HTTP), which is the test below.
        url: "http://members.example/wiki",
        fetchViaHost: (url) => {
          asked.push(url);
          return Promise.reject(
            new Error("the request named no forwardable host")
          );
        },
      })
    );
    await flush();

    expect(asked).toEqual(["http://members.example/wiki"]);
    const pane = host.querySelector(".browser-pane-unmirrored");
    expect(pane).not.toBeNull();
    expect(pane!.textContent).toContain(
      STR.remote.web.browserPane.unmirroredLabel
    );
    expect(pane!.textContent).toContain(
      STR.remote.web.browserPane.unmirroredWhy
    );
    expect(pane!.textContent).toContain("the request named no forwardable host");
    const link = host.querySelector<HTMLAnchorElement>(".browser-pane-link");
    expect(link!.getAttribute("href")).toBe("http://members.example/wiki");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toContain("noopener");
    expect(host.querySelector(".browser-pane-frame")).toBeNull();
  });

  it("an https target rides the host's proxy like any other — TLS is the host's, not this page's", async () => {
    const asked: string[] = [];
    mount(
      createElement(BrowserPane, {
        url: "https://gitlab.example/dashboard",
        fetchViaHost: (url) => {
          asked.push(url);
          return okHtml();
        },
      })
    );
    await flush();
    // No up-front refusal anymore: the host terminates TLS (remote_proxy's
    // reqwest half), so the pane asks the proxy and mirrors what came back.
    expect(asked).toEqual(["https://gitlab.example/dashboard"]);
    expect(host.querySelector(".browser-pane-frame")).not.toBeNull();
  });

  it("unmirrored by answer: an HTTP error or a non-document says which, with the same link", async () => {
    mount(
      createElement(BrowserPane, {
        url: "http://intranet.local/forbidden",
        fetchViaHost: async () => new Response("no", { status: 403 }),
      })
    );
    await flush();
    let pane = host.querySelector(".browser-pane-unmirrored");
    expect(pane!.textContent).toContain(
      STR.remote.web.browserPane.unmirroredStatus({ status: "403" })
    );

    mount(
      createElement(BrowserPane, {
        url: "http://intranet.local/report.pdf",
        fetchViaHost: async () =>
          new Response("%PDF-1.4", {
            status: 200,
            headers: { "content-type": "application/pdf" },
          }),
      })
    );
    await flush();
    pane = host.querySelector(".browser-pane-unmirrored");
    expect(pane!.textContent).toContain(
      STR.remote.web.browserPane.unmirroredType
    );
    expect(host.querySelector(".browser-pane-frame")).toBeNull();
  });

  it("loading: while the host's network has not answered, the pane says so and mounts no frame", async () => {
    mount(
      createElement(BrowserPane, {
        url: "http://intranet.local/slow",
        fetchViaHost: () => new Promise<Response>(() => {}),
      })
    );
    expect(host.querySelector(".browser-pane-loading")).not.toBeNull();
    expect(host.querySelector(".browser-pane-frame")).toBeNull();
    expect(host.querySelector(".browser-pane-unmirrored")).toBeNull();
  });

  it("a URL change refetches, and a pane that has moved on drops the late answer", async () => {
    const asked: string[] = [];
    const pane = (url: string) =>
      createElement(BrowserPane, {
        url,
        resolveProxyUrl: proxyUrlFor,
        fetchViaHost: (u) => {
          asked.push(u);
          return okHtml();
        },
      });
    mount(pane("http://intranet.local/one"));
    await flush();
    mount(pane("http://intranet.local/two"));
    await flush();
    expect(asked).toEqual(["http://intranet.local/one", "http://intranet.local/two"]);
    const frame = host.querySelector<HTMLIFrameElement>(".browser-pane-frame");
    // The second document's base — the first answer never landed on a
    // pane that had already moved to the second URL.
    expect(frame!.getAttribute("srcdoc")).toContain(
      '<base href="/__tabverse_proxy/http/intranet.local/">'
    );
  });
});
