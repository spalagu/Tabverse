
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
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith("/__tabverse_proxy/")) {
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
    const timer = setTimeout(
      () => resolve(new Response("proxy timeout", { status: 504 })),
      30_000,
    );
    channel.port1.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      const d = e.data as { status: number; contentType: string; bodyB64: string };
      const bytes =
        d.bodyB64.length > 0
          ? Uint8Array.from(atob(d.bodyB64), (c) => c.charCodeAt(0))
          : undefined;
      resolve(
        new Response(bytes, {
          status: d.status,
          headers: d.contentType ? { "content-type": d.contentType } : {},
        }),
      );
    };
    page.postMessage({ type: "tabverse-proxy-fetch", url: request.url }, [
      channel.port2,
    ]);
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
