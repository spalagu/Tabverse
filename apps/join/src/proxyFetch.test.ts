import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProxyClient,
  installProxyFetchPatch,
  PROXY_PATH_PREFIX,
  proxyUrlFor,
  targetFromProxyUrl,
  type HeaderPair,
  type HttpDataStream,
} from "@tabverse/remote-client/proxy-fetch";

interface Opened {
  contextId: string;
  method: string;
  url: string;
  headers: HeaderPair[];
  requestChunks: Uint8Array[];
  finished: boolean;
}

function rig(body = "hello", status = 200) {
  const opened: Opened[] = [];
  const encoded = new TextEncoder().encode(body);
  const client = createProxyClient(async (contextId, method, url, headers) => {
    const record: Opened = { contextId, method, url, headers, requestChunks: [], finished: false };
    opened.push(record);
    let read = false;
    const stream: HttpDataStream = {
      cancel() {},
      async writeRequestChunk(bytes) { record.requestChunks.push(bytes); },
      finishRequest() { record.finished = true; },
      async responseStart() {
        return { type: "response", head: { status, finalUrl: url, headers: [{ name: "content-type", value: "text/plain" }] } };
      },
      async readResponseChunk() {
        if (read) return new Uint8Array();
        read = true;
        return encoded;
      },
    };
    return stream;
  }, () => "browser-tab-7");
  return { opened, client };
}

describe("createProxyClient data streams", () => {
  it("carries request metadata and streams raw response bytes", async () => {
    const { opened, client } = rig("wiki");
    const response = await client.requestViaProxy("http://intranet.example/wiki?q=1");
    expect(opened[0]).toMatchObject({ contextId: "browser-tab-7", method: "GET", url: "http://intranet.example/wiki?q=1", finished: true });
    expect(await response.text()).toBe("wiki");
  });

  it("streams a UTF-8 request body without base64 or whole-body framing", async () => {
    const { opened, client } = rig("", 204);
    const response = await client.requestViaProxy("http://intranet.example/form", {
      method: "POST", body: "search=wär", headers: { "x-joiner": "page" },
    });
    expect(response.status).toBe(204);
    expect(new TextDecoder().decode(opened[0].requestChunks[0])).toBe("search=wär");
    expect(opened[0].headers).toContainEqual({ name: "x-joiner", value: "page" });
  });

  it("surfaces a bounded response-start error", async () => {
    const client = createProxyClient(async () => ({
      cancel() {},
      async writeRequestChunk() {}, finishRequest() {},
      async responseStart() { return { type: "error" as const, error: { code: "denied", message: "steer access required", retryable: false } }; },
      async readResponseChunk() { return new Uint8Array(); },
    }));
    await expect(client.requestViaProxy("https://refused.example/")).rejects.toThrow("steer access required");
  });

  it("failAll ends in-flight work but does not poison the next connection generation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const client = createProxyClient(async (_context, _method, url) => {
      calls += 1;
      if (calls === 1) await blocked;
      let read = false;
      return {
        cancel() {},
        async writeRequestChunk() {}, finishRequest() {},
        async responseStart() { return { type: "response" as const, head: { status: 200, finalUrl: url, headers: [] } }; },
        async readResponseChunk() { if (read) return new Uint8Array(); read = true; return new TextEncoder().encode("ok"); },
      };
    });
    const oldRequest = client.requestViaProxy("http://old/");
    client.failAll("connection lost");
    await expect(oldRequest).rejects.toThrow("connection lost");
    release();
    expect(await (await client.requestViaProxy("http://new/")).text()).toBe("ok");
  });

  it("follows a Host-resolved redirect on a fresh authorized stream", async () => {
    const opened: string[] = [];
    const client = createProxyClient(async (_context, _method, url) => {
      opened.push(url);
      const redirected = opened.length === 1;
      let read = false;
      return {
        cancel() {},
        async writeRequestChunk() {},
        finishRequest() {},
        async responseStart() {
          return {
            type: "response" as const,
            head: {
              status: redirected ? 302 : 200,
              finalUrl: url,
              headers: redirected
                ? [{ name: "location", value: "/login" }]
                : [{ name: "content-type", value: "text/html" }],
            },
          };
        },
        async readResponseChunk() {
          if (read) return new Uint8Array();
          read = true;
          return new TextEncoder().encode("signed in");
        },
      };
    });
    const response = await client.requestViaProxy("http://intranet.local/start");
    expect(opened).toEqual([
      "http://intranet.local/start",
      "http://intranet.local/login",
    ]);
    expect(response.redirected).toBe(true);
    expect(response.url).toBe("http://intranet.local/login");
    expect(await response.text()).toBe("signed in");
  });

  it("resets both stream halves when its AbortSignal fires", async () => {
    let cancelled = false;
    let rejectStart!: (error: Error) => void;
    const client = createProxyClient(async () => ({
      cancel() {
        cancelled = true;
        rejectStart(new DOMException("The operation was aborted", "AbortError"));
      },
      async writeRequestChunk() {},
      finishRequest() {},
      responseStart: () => new Promise((_resolve, reject) => { rejectStart = reject; }),
      async readResponseChunk() { return new Uint8Array(); },
    }));
    const abort = new AbortController();
    const pending = client.requestViaProxy("http://intranet.local/slow", {
      signal: abort.signal,
    });
    await Promise.resolve();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
});

describe("the endpoint path", () => {
  it("mirrors a target URL after the scheme segment, query included", () => {
    expect(proxyUrlFor("http://intranet.example/dir/page?q=1")).toBe(
      `${PROXY_PATH_PREFIX}http/intranet.example/dir/page?q=1`
    );
    expect(proxyUrlFor("https://host.example:8443/")).toBe(
      `${PROXY_PATH_PREFIX}https/host.example:8443/`
    );
    // The one scheme family the host's proxy refuses is the caller's
    // error to hear, not a mangled URL to send.
    expect(() => proxyUrlFor("ftp://files/")).toThrow("http requests only");
  });

  it("reads a target back out of a proxy path, and nothing out of other paths", () => {
    const read = (path: string) =>
      targetFromProxyUrl(new URL(path, "https://join.example/page"));
    expect(read("/__tabverse_proxy/http/intranet.example/dir/page?q=1")).toBe(
      "http://intranet.example/dir/page?q=1"
    );
    expect(read("/__tabverse_proxy/https/host.example:8443/")).toBe(
      "https://host.example:8443/"
    );
    expect(read("/__tabverse_proxy/ftp/files/")).toBeNull();
    expect(read("/__tabverse_proxy")).toBeNull();
    expect(read("/assets/app.js")).toBeNull();
  });

  it("the pane's <base> rewrites relative subresources onto the endpoint — the point of path form", () => {
    // What a document beside /dir/page resolves against the mirrored
    // document's base, on the join origin:
    const base = new URL(
      proxyUrlFor("http://intranet.example/dir/"),
      "https://join.example/anything"
    );
    expect(targetFromProxyUrl(new URL("logo.png", base))).toBe(
      "http://intranet.example/dir/logo.png"
    );
    // Root-absolute URLs are path form's boundary: URL semantics resolve
    // "/style.css" against the JOIN origin's root, off the endpoint
    // entirely — the request falls through to the browser untouched
    // rather than wandering into the host's network unproxied.
    expect(targetFromProxyUrl(new URL("/style.css", base))).toBeNull();
    // A cross-origin URL the base never touches stays unproxied.
    expect(
      targetFromProxyUrl(new URL("https://direct.example/x", base))
    ).toBeNull();
  });
});

describe("the page fetch patch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("same-origin proxy paths route to the host's network; everything else passes through untouched", async () => {
    const seen: string[] = [];
    const client = {
      requestViaProxy: vi.fn(async (target: string) => {
        seen.push(target);
        return new Response("via the host", { status: 200 });
      }),
    };
    const passthrough = vi.fn(
      (): Promise<Response> => Promise.resolve(new Response("passthrough"))
    );
    globalThis.fetch = passthrough;
    const restore = installProxyFetchPatch(client, () => "https://join.example/page");
    try {
      // Path-relative, absolute-path and Request forms all name the
      // same-origin endpoint and route through the client.
      const a = await fetch("/__tabverse_proxy/http/site.example/doc");
      expect(await a.text()).toBe("via the host");
      const b = await fetch(
        new Request("https://join.example/__tabverse_proxy/http/site.example/other")
      );
      expect(b.ok).toBe(true);
      expect(seen).toEqual([
        "http://site.example/doc",
        "http://site.example/other",
      ]);

      // Off the endpoint: the browser's own fetch answers, unchanged.
      const c = await fetch("/assets/app.js");
      expect(await c.text()).toBe("passthrough");
      const d = await fetch("http://elsewhere.example/x");
      expect(await d.text()).toBe("passthrough");
      expect(seen).toHaveLength(2);
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(passthrough);
    // And after restore the patch is really gone.
    await expect(fetch("/__tabverse_proxy/http/site.example/doc")).resolves
      .toBeDefined();
  });
});
