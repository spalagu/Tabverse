import { describe, expect, it } from "vitest";
import {
  rewriteRemoteCss,
  rewriteRemoteHtml,
  transformRemoteResponse,
} from "@tabverse/workbench/remote-browser-document";
import { proxyUrlFor } from "@tabverse/remote-client/proxy-fetch";

const resolve = (target: string, contextId?: string) =>
  proxyUrlFor(target, "/Tabverse/join/", contextId);

describe("Remote Browser document transformation", () => {
  it("rewrites CSS url() and both @import forms with a stable context", () => {
    const css = [
      '@import "theme/base.css" screen;',
      '@import url("/shared/print.css") print;',
      '.hero { background: url(../img/hero.png) }',
      '.icon { mask: url("https://cdn.example/icon.svg") }',
      '.inline { background: url(data:image/png;base64,AA==) }',
    ].join("\n");
    const rewritten = rewriteRemoteCss(
      css,
      "https://intranet.local/css/site/main.css",
      resolve,
      "browser-7",
    );

    expect(rewritten).toContain(
      '"/Tabverse/join/__tabverse_proxy/browser-7/https/intranet.local/css/site/theme/base.css"',
    );
    expect(rewritten).toContain(
      'url("/Tabverse/join/__tabverse_proxy/browser-7/https/intranet.local/shared/print.css")',
    );
    expect(rewritten).toContain(
      "url(/Tabverse/join/__tabverse_proxy/browser-7/https/intranet.local/css/img/hero.png)",
    );
    expect(rewritten).toContain(
      'url("/Tabverse/join/__tabverse_proxy/browser-7/https/cdn.example/icon.svg")',
    );
    expect(rewritten).toContain("url(data:image/png;base64,AA==)");
  });

  it("rewrites inline and embedded CSS together with static HTML URLs", () => {
    const html = rewriteRemoteHtml(
      '<style>.logo{background:url("/img/logo.png")}</style>' +
        '<div id="hero" style="background:url(tiles/a.png)"></div>',
      "http://host.local/app/page",
      resolve,
      "browser-a",
    );

    expect(html).toContain(
      '/Tabverse/join/__tabverse_proxy/browser-a/http/host.local/img/logo.png',
    );
    expect(html).toContain(
      '/Tabverse/join/__tabverse_proxy/browser-a/http/host.local/app/tiles/a.png',
    );
  });

  it("isolates scripts and routes dynamic HTTP APIs through this Browser context", () => {
    const html = rewriteRemoteHtml(
      '<meta http-equiv="Content-Security-Policy" content="default-src *">' +
        '<script>window.remotePageRan = true</script>',
      "https://intranet.local/app/page",
      resolve,
      "browser/a",
      "https://join.example/Tabverse/join/__tabverse_proxy/",
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const policy = doc.querySelector<HTMLMetaElement>(
      'meta[http-equiv="Content-Security-Policy"]',
    );
    const bootstrap = doc.querySelector<HTMLScriptElement>(
      "script[data-tabverse-browser-bootstrap]",
    );

    expect(policy?.content).toContain(
      "connect-src https://join.example/Tabverse/join/__tabverse_proxy/browser%2Fa/",
    );
    expect(policy?.content).toContain("default-src 'none'");
    expect(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).toHaveLength(1);
    expect(bootstrap?.textContent).toContain("window.fetch =");
    expect(bootstrap?.textContent).toContain("XMLHttpRequest.prototype.open");
    expect(bootstrap?.textContent).toContain("window.EventSource =");
    expect(html).toContain("window.remotePageRan = true");
  });

  it("transforms only HTML/CSS responses and removes stale body metadata", async () => {
    const transformed = await transformRemoteResponse(
      new Response('<img src="/logo.png">', {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": "21",
          "content-encoding": "gzip",
        },
      }),
      "https://host.local/page",
      resolve,
      "browser-b",
      "https://join.example/Tabverse/join/__tabverse_proxy/",
    );

    expect(await transformed.text()).toContain(
      "/Tabverse/join/__tabverse_proxy/browser-b/https/host.local/logo.png",
    );
    expect(transformed.headers.has("content-length")).toBe(false);
    expect(transformed.headers.has("content-encoding")).toBe(false);

    const binary = new Response(new Uint8Array([0, 1, 2]), {
      headers: { "content-type": "application/octet-stream" },
    });
    expect(await transformRemoteResponse(binary, "https://host.local/file", resolve)).toBe(binary);
  });
});
