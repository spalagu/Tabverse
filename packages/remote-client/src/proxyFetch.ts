
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
export function proxyUrlFor(target: string): string {
  const u = new URL(target);
  const scheme = u.protocol.slice(0, -1);
  if (scheme !== "http" && scheme !== "https") {
    throw new Error(`the proxy carries http requests only, not ${u.protocol}`);
  }
  return `${PROXY_PATH_PREFIX}${scheme}/${u.host}${u.pathname}${u.search}`;
}
/**
 * The host-side URL a request to this path is aimed at, or null when the
 * path is not under the endpoint (or names no http scheme). Origin is
 * deliberately NOT checked here — the fetch patch below owns the
 * same-origin gate — so the mapping stays pure path arithmetic and the
 * same function reads back what proxyUrlFor wrote, from any origin.
 */
export function targetFromProxyUrl(url: URL): string | null {
  if (!url.pathname.startsWith(PROXY_PATH_PREFIX)) return null;
  const rest = url.pathname.slice(PROXY_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const scheme = rest.slice(0, slash);
  if (scheme !== "http" && scheme !== "https") return null;
  return `${scheme}://${rest.slice(slash + 1)}${url.search}`;
}

/** One independently multiplexed HTTP stream exposed by the wasm seam. */
export interface HttpDataStream {
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
    init?: RequestInit
  ): Promise<Response>;
  /** Reject every operation belonging to the ended connection. */
  failAll(reason: string): void;
}

export function createProxyClient(
  open: OpenHttpDataStream,
  contextId: () => string = () => "remote-browser",
): ProxyClient {
  const waiting = new Set<(error: Error) => void>();
  let generation = 0;

  function requestViaProxy(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const req = new Request(input, init);
    const requestGeneration = generation;
    return new Promise<Response>((resolve, reject) => {
      waiting.add(reject);
      void (async () => {
        try {
          const headers: HeaderPair[] = [];
          req.headers.forEach((value, name) => headers.push({ name, value }));
          const stream = await open(contextId(), req.method, req.url, headers);
          if (requestGeneration !== generation) throw new Error("the session ended");
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
          const nullBody = [204, 205, 304].includes(start.head.status);
          const body = nullBody
            ? null
            : new ReadableStream<Uint8Array>({
                async pull(controller) {
                  try {
                    const chunk = await stream.readResponseChunk(64 * 1024);
                    if (chunk.length === 0) controller.close();
                    else controller.enqueue(chunk);
                  } catch (error) {
                    controller.error(error);
                  }
                },
              });
          resolve(new Response(body, { status: start.head.status, headers: headersOut }));
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
    const target = targetFromProxyUrl(url);
    return target === null
      ? original(input, init)
      : client.requestViaProxy(target, init);
  };
  globalThis.fetch = patched;
  return () => {
    globalThis.fetch = original;
  };
}
