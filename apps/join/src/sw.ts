
interface FetchEventLike extends Event {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

interface SwScope {
  location: Location;
  addEventListener(type: "install", cb: (e: Event) => void): void;
  addEventListener(type: "activate", cb: (e: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", cb: (e: FetchEventLike) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
}

interface ExtendableEventLike extends Event {
  waitUntil(p: Promise<unknown>): void;
}

const sw = self as unknown as SwScope;

/** Bump when the caching POLICY changes; content changes need no bump. */
const CACHE = "tabverse-join-v1";

sw.addEventListener("install", () => {
  void sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await sw.clients.claim();
    })()
  );
});

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.includes("/__tabverse_proxy/")) {
    event.respondWith(proxyViaPage(request));
    return;
  }
  if (url.pathname.includes("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
  }
});

/** One proxied subresource: ask the page, or fail as 503/504 honestly. */
async function proxyViaPage(request: Request): Promise<Response> {
  const scope = sw as unknown as {
    clients: {
      matchAll(o: { type: string; includeUncontrolled: boolean }): Promise<
        { postMessage(msg: unknown, transfer: MessagePort[]): void }[]
      >;
    };
  };
  const clients = await scope.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const page = clients[0];
  if (page === undefined) {
    return new Response("no join page is open", { status: 503 });
  }
  return new Promise<Response>((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    let body: ReadableStreamDefaultController<Uint8Array> | null = null;
    let timer = 0;
    const close = () => {
      clearTimeout(timer);
      channel.port1.close();
    };
    const timeout = () => {
      if (settled) {
        body?.error(new Error("proxy timeout"));
      } else {
        settled = true;
        resolve(new Response("proxy timeout", { status: 504 }));
      }
      channel.port1.postMessage({ type: "cancel" });
      close();
    };
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(timeout, 30_000) as unknown as number;
    };
    armTimeout();
    channel.port1.onmessage = (e: MessageEvent) => {
      armTimeout();
      const d = e.data as
        | { type: "start"; status: number; statusText: string; headers: [string, string][] }
        | { type: "chunk"; bytes: ArrayBuffer }
        | { type: "end" }
        | { type: "error"; message: string };
      if (d.type === "start" && !settled) {
        settled = true;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
          },
          cancel() {
            channel.port1.postMessage({ type: "cancel" });
            close();
          },
        });
        resolve(new Response(stream, {
          status: d.status,
          statusText: d.statusText,
          headers: d.headers,
        }));
      } else if (d.type === "chunk" && body !== null) {
        body.enqueue(new Uint8Array(d.bytes));
      } else if (d.type === "end") {
        body?.close();
        close();
      } else if (d.type === "error") {
        if (settled) {
          body?.error(new Error(d.message));
        } else {
          settled = true;
          resolve(new Response(d.message, { status: 502 }));
        }
        close();
      }
    };
    page.postMessage({
      type: "tabverse-proxy-fetch",
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers.entries()),
      hasBody: request.body !== null,
    }, [channel.port2]);
    if (request.body !== null) {
      void (async () => {
        try {
          const reader = request.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            armTimeout();
            const bytes = value.slice().buffer as ArrayBuffer;
            channel.port1.postMessage({ type: "request-chunk", bytes }, [bytes]);
          }
          channel.port1.postMessage({ type: "request-end" });
        } catch (error) {
          channel.port1.postMessage({
            type: "request-error",
            message: error instanceof Error ? error.message : "request body failed",
          });
        }
      })();
    }
  });
}

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) void cache.put(request, response.clone());
  return response;
}

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) void cache.put(request, response.clone());
    return response;
  } catch (e) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw e;
  }
}
