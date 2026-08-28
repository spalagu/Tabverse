import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProxyClient,
  installProxyFetchPatch,
  PROXY_PATH_PREFIX,
  PROXY_TIMEOUT_MS,
  proxyUrlFor,
  targetFromProxyUrl,
} from "@tabverse/remote-client/proxy-fetch";

/** One sent ProxyReq, as the wasm seam would carry it. */
interface Sent {
  id: number;
  head: string;
  body: string | undefined;
}

function rig() {
  const sent: Sent[] = [];
  const client = createProxyClient((id, head, body) =>
    sent.push({ id, head, body })
  );
  return { sent, client };
}

/** Let the request build (its body read is a real microtask chain). */
const settleMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("createProxyClient round trip", () => {
  it("a GET document exchange: absolute-form request head, Response from the answer head", async () => {
    const { sent, client } = rig();
    const pending = client.requestViaProxy("http://intranet.example/dir/page?q=1");
    await settleMicrotasks();
    expect(sent).toHaveLength(1);
    // The head the host's proxy parses: absolute target, the authority
    // in Host, no body on a GET.
    expect(sent[0].head.startsWith(
      "GET http://intranet.example/dir/page?q=1 HTTP/1.1\r\n"
    )).toBe(true);
    expect(sent[0].head).toContain("Host: intranet.example");
    expect(sent[0].body).toBeUndefined();

    // The frame body is base64 now (the host encodes bytes, text and
    // binary alike); the assertion's document rides the same way.
    client.settle(
      sent[0].id,
      "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n",
      btoa("<html><body>wiki</body></html>")
    );
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<html><body>wiki</body></html>");
  });

  it("a POST carries its body and a byte-accurate Content-Length", async () => {
    const { sent, client } = rig();
    const pending = client.requestViaProxy("http://intranet.example/form", {
      method: "POST",
      body: "search=wär",
      headers: { "x-joiner": "page" },
    });
    await settleMicrotasks();
    expect(sent[0].head).toContain("POST http://intranet.example/form HTTP/1.1");
    expect(sent[0].head).toContain("x-joiner: page");
    // "wär" is 5 bytes as UTF-8, 4 as characters; the whole body
    // "search=wär" is 11 bytes where it is 10 characters — the wire
    // counts bytes.
    expect(sent[0].head).toContain("Content-Length: 11");
    expect(sent[0].body).toBe("search=wär");
    client.settle(sent[0].id, "HTTP/1.1 204 No Content\r\n");
    const res = await pending;
    expect(res.status).toBe(204);
    // A null-body status must not explode on the Response constructor.
    expect(await res.text()).toBe("");
  });

  it("every request takes a fresh id, and a settle for an unknown id is dropped", async () => {
    const { sent, client } = rig();
    const first = client.requestViaProxy("http://a/");
    const second = client.requestViaProxy("http://b/");
    await settleMicrotasks();
    expect(sent[1].id).not.toBe(sent[0].id);

    // An answer that correlates with nothing (already timed out, or
    // another client's) must be silence, not a throw.
    client.settle(sent[0].id + 5000, "HTTP/1.1 200 OK");
    client.settle(sent[0].id, "HTTP/1.1 200 OK");
    client.settle(sent[1].id, "HTTP/1.1 200 OK");
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
  });

  it("a malformed answer head rejects that one request, not the session", async () => {
    const { sent, client } = rig();
    const pending = client.requestViaProxy("http://garbled/");
    await settleMicrotasks();
    client.settle(sent[0].id, "not an http head at all");
    await expect(pending).rejects.toThrow("not an HTTP head");
  });
});

describe("createProxyClient failure paths", () => {
  it("a request nobody answers rejects at the budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { client } = rig();
      const pending = client.requestViaProxy("http://slow.example/");
      const expectation = expect(pending).rejects.toThrow(
        `proxied fetch of slow.example timed out after ${PROXY_TIMEOUT_MS}ms`
      );
      await vi.advanceTimersByTimeAsync(PROXY_TIMEOUT_MS);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("the host's error arm — an rpcResult with the same id — rejects with its words, and only claims its own ids", async () => {
    const { sent, client } = rig();
    const pending = client.requestViaProxy("https://refused.example/");
    await settleMicrotasks();
    // The host runs a refused ProxyReq as an rpcResult, not a proxyRes
    // (app_share.rs's error arm) — the frame the page dispatch offers
    // the client before the sinks.
    const claimed = client.consumeRpcResult({
      type: "rpcResult",
      id: sent[0].id,
      err: "the request named no forwardable host",
    });
    expect(claimed).toBe(true);
    await expect(pending).rejects.toThrow(
      "the request named no forwardable host"
    );

    // Frames that are not this client's to claim fall through: another
    // family's rpcResult, a proxyRes for a dead id, anything else.
    expect(client.consumeRpcResult({ type: "rpcResult", id: 1, err: "x" })).toBe(false);
    expect(client.consumeRpcResult({ type: "proxyRes", id: sent[0].id })).toBe(false);
    expect(client.consumeRpcResult({ type: "actionApplied" })).toBe(false);
  });

  it("failAll rejects every waiter once, and the session's answers find silence", async () => {
    const { sent, client } = rig();
    const a = client.requestViaProxy("http://a/");
    const b = client.requestViaProxy("http://b/");
    await settleMicrotasks();
    client.failAll("the session ended");
    await expect(a).rejects.toThrow("the session ended");
    await expect(b).rejects.toThrow("the session ended");
    // A late frame for a failed waiter must not throw into the void.
    client.settle(sent[0].id, "HTTP/1.1 200 OK");
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
