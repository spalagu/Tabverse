
/**
 * The same-origin path that stands for "the host's network". A URL under
 * this prefix names its target by mirroring it after the scheme segment:
 *
 *   /__tabverse_proxy/http/intranet.example/dir/page?q=1
 *
 * Path-form (not ?url=) on purpose: relative resolution against a
 * <base href> pointing here rewrites a document's relative subresource
 * paths onto the endpoint — `x.js` beside `/…/dir/page` resolves to
 * `/…/dir/x.js`, root-absolute `/x.js` to `/…/http/intranet.example/x.js`
 * — which a query-parameter form cannot do.
 */
export const PROXY_PATH_PREFIX = "/__tabverse_proxy/";
const PROXY_PATH_SEGMENT = "__tabverse_proxy/";

/** Same-origin root beneath which every virtual Browser URL lives. */
export function proxyPathRoot(basePath = "/"): string {
  let start = 0;
  let end = basePath.length;
  while (start < end && basePath[start] === "/") start += 1;
  while (end > start && basePath[end - 1] === "/") end -= 1;
  const scopedBase = start === end ? "" : `/${basePath.slice(start, end)}`;
  return `${scopedBase}/${PROXY_PATH_SEGMENT}`;
}

/**
 * The endpoint path standing for one host-side URL, origin-relative so
 * it is valid as a fetch input, an anchor href or a <base href> on any
 * origin the join page itself is served from (Pages site, single-file
 * artifact, dev server). Non-http(s) schemes are the caller's error:
 * the host's proxy would refuse them anyway.
 * Path-form (not ?url=) on purpose: relative resolution against a
 * <base href> pointing here rewrites a document's directory-relative
 * subresource paths onto the endpoint — `x.js` beside `/…/dir/page`
 * resolves to `/…/dir/x.js`. Two escapes are inherent to URL semantics
 * and stated rather than hidden: a ROOT-absolute `/x.js` resolves
 * against the join origin's root (off the endpoint, unproxied), and a
 * protocol-relative `//host/x` resolves against the join page's own
 * scheme (cross-origin, unproxied). A query-parameter form could not
 * even do the directory-relative case.
 */
export function proxyUrlFor(
  target: string,
  basePath = "/",
  contextId?: string,
): string {
  const u = new URL(target);
  const scheme = u.protocol.slice(0, -1);
  if (scheme !== "http" && scheme !== "https") {
    throw new Error(`the proxy carries http requests only, not ${u.protocol}`);
  }
  const context = contextId === undefined ? "" : `${encodeURIComponent(contextId)}/`;
  return `${proxyPathRoot(basePath)}${context}${scheme}/${u.host}${u.pathname}${u.search}`;
}

export interface ProxyRoute {
  contextId: string | null;
  target: string;
}

/** Decode both current context-scoped paths and legacy unscoped test paths. */
export function proxyRouteFromUrl(url: URL): ProxyRoute | null {
  const marker = `/${PROXY_PATH_SEGMENT}`;
  const markerAt = url.pathname.indexOf(marker);
  if (markerAt < 0) return null;
  const rest = url.pathname.slice(markerAt + marker.length);
  const parts = rest.split("/");
  const scoped = parts[0] !== "http" && parts[0] !== "https";
  const schemeAt = scoped ? 1 : 0;
  const scheme = parts[schemeAt];
  if (scheme !== "http" && scheme !== "https") return null;
  const authorityAndPath = parts.slice(schemeAt + 1).join("/");
  if (authorityAndPath === "") return null;
  let contextId: string | null = null;
  if (scoped) {
    try {
      contextId = decodeURIComponent(parts[0]);
    } catch {
      return null;
    }
    if (contextId === "") return null;
  }
  return {
    contextId,
    target: `${scheme}://${authorityAndPath}${url.search}`,
  };
}
/**
 * The host-side URL a request to this path is aimed at, or null when the
 * path is not under the endpoint (or names no http scheme). Origin is
 * deliberately NOT checked here — the fetch patch below owns the
 * same-origin gate — so the mapping stays pure path arithmetic and the
 * same function reads back what proxyUrlFor wrote, from any origin.
 */
export function targetFromProxyUrl(url: URL): string | null {
  return proxyRouteFromUrl(url)?.target ?? null;
}

/** One independently multiplexed HTTP stream exposed by the wasm seam. */
export interface HttpDataStream {
  cancel(): void;
  writeRequestChunk(bytes: Uint8Array): Promise<void>;
  finishRequest(): void;
  responseStart(): Promise<
    | { type: "response"; head: { status: number; finalUrl: string; headers: HeaderPair[] } }
    | { type: "error"; error: { code: string; message: string; retryable: boolean } }
  >;
  readResponseChunk(limit: number): Promise<Uint8Array>;
}

export interface HeaderPair {
  name: string;
  value: string;
}

export type OpenHttpDataStream = (
  contextId: string,
  method: string,
  url: string,
  headers: HeaderPair[],
) => Promise<HttpDataStream>;

/** The client the page keeps for the session's lifetime. */
export interface ProxyClient {
  /** One fetch through the host's network. Rejection is transport,
   * refused target, or dead session — an HTTP error
   * status is a resolved Response, the same split window.fetch has. */
  requestViaProxy(
    input: string | URL | Request,
    init?: RequestInit,
    requestContextId?: string,
  ): Promise<Response>;
  /** Reject every operation belonging to the ended connection. */
  failAll(reason: string): void;
}

export const MAX_REDIRECTS = 10;

export function createProxyClient(
  open: OpenHttpDataStream,
  contextId: () => string = () => "remote-browser",
): ProxyClient {
  const waiting = new Set<(error: Error) => void>();
  const active = new Set<HttpDataStream>();
  let generation = 0;

  async function perform(
    req: Request,
    requestGeneration: number,
    redirects: number,
    requestContextId: string,
  ): Promise<Response> {
    const headers: HeaderPair[] = [];
    req.headers.forEach((value, name) => headers.push({ name, value }));
    const redirectSource = req.body === null ? req : req.clone();
    const stream = await open(requestContextId, req.method, req.url, headers);
    active.add(stream);
    let bodyOwnsStream = false;
    const abort = () => stream.cancel();
    req.signal.addEventListener("abort", abort, { once: true });
    try {
      if (requestGeneration !== generation) throw new Error("the session ended");
      if (req.signal.aborted) {
        stream.cancel();
        throw new DOMException("The operation was aborted", "AbortError");
      }
      if (req.body !== null) {
        const reader = req.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await stream.writeRequestChunk(value);
          if (requestGeneration !== generation) throw new Error("the session ended");
        }
      }
      stream.finishRequest();
      const start = await stream.responseStart();
      if (requestGeneration !== generation) throw new Error("the session ended");
      if (start.type === "error") throw new Error(start.error.message);
      const headersOut = new Headers();
      for (const pair of start.head.headers) headersOut.append(pair.name, pair.value);

      const location = headersOut.get("location");
      const redirect = [301, 302, 303, 307, 308].includes(start.head.status) && location !== null;
      if (redirect && req.redirect !== "manual") {
        stream.cancel();
        active.delete(stream);
        req.signal.removeEventListener("abort", abort);
        if (req.redirect === "error") throw new TypeError("redirect mode is set to error");
        if (redirects >= MAX_REDIRECTS) throw new TypeError(`redirected more than ${MAX_REDIRECTS} times`);
        const target = new URL(location, start.head.finalUrl || req.url).href;
        const switchToGet = start.head.status === 303 || ((start.head.status === 301 || start.head.status === 302) && req.method === "POST");
        let next = switchToGet
          ? new Request(target, { method: "GET", headers: [...req.headers].filter(([name]) => !["content-length", "content-type"].includes(name.toLowerCase())), redirect: req.redirect, signal: req.signal })
          : new Request(target, redirectSource);
        if (new URL(target).origin !== new URL(req.url).origin) {
          const safe = new Headers(next.headers);
          safe.delete("authorization");
          safe.delete("proxy-authorization");
          safe.delete("cookie");
          next = new Request(next, { headers: safe });
        }
        return perform(next, requestGeneration, redirects + 1, requestContextId);
      }

      const nullBody = [204, 205, 304].includes(start.head.status);
      const body = nullBody
        ? null
        : new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                if (requestGeneration !== generation) throw new Error("the session ended");
                const chunk = await stream.readResponseChunk(64 * 1024);
                if (chunk.length === 0) {
                  active.delete(stream);
                  req.signal.removeEventListener("abort", abort);
                  controller.close();
                } else controller.enqueue(chunk);
              } catch (error) {
                active.delete(stream);
                req.signal.removeEventListener("abort", abort);
                controller.error(error);
              }
            },
            cancel() {
              active.delete(stream);
              req.signal.removeEventListener("abort", abort);
              stream.cancel();
            },
          });
      const response = new Response(body, { status: start.head.status, headers: headersOut });
      Object.defineProperties(response, {
        url: { value: start.head.finalUrl },
        redirected: { value: redirects > 0 },
      });
      bodyOwnsStream = body !== null;
      return response;
    } finally {
      if (!bodyOwnsStream) {
        req.signal.removeEventListener("abort", abort);
        active.delete(stream);
      }
    }
  }

  function requestViaProxy(
    input: string | URL | Request,
    init?: RequestInit,
    requestContextId = contextId(),
  ): Promise<Response> {
    const req = new Request(input, init);
    const requestGeneration = generation;
    return new Promise<Response>((resolve, reject) => {
      waiting.add(reject);
      void (async () => {
        try {
          resolve(await perform(req, requestGeneration, 0, requestContextId));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          waiting.delete(reject);
        }
      })();
    });
  }

  function failAll(reason: string): void {
    generation += 1;
    for (const stream of active) stream.cancel();
    active.clear();
    for (const reject of waiting) reject(new Error(reason));
    waiting.clear();
  }

  return { requestViaProxy, failAll };
}

export function installProxyFetchPatch(
  client: Pick<ProxyClient, "requestViaProxy">,
  href: () => string = () => location.href
): () => void {
  const original = globalThis.fetch;
  const pageOrigin = new URL(href()).origin;
  const patched = (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    let url: URL;
    try {
      const raw = input instanceof Request ? input.url : String(input);
      url = new URL(raw, href());
    } catch {
      // An unparseable target was never proxyable; let the platform's
      // own fetch say so.
      return original(input, init);
    }
    if (url.origin !== pageOrigin) return original(input, init);
    const route = proxyRouteFromUrl(url);
    return route === null
      ? original(input, init)
      : client.requestViaProxy(route.target, init, route.contextId ?? undefined);
  };
  globalThis.fetch = patched;
  return () => {
    globalThis.fetch = original;
  };
}
