import postcss from "postcss";
import valueParser from "postcss-value-parser";

export type ProxyUrlResolver = (target: string, contextId?: string) => string;

const URL_ATTRIBUTES = [
  "a[href]", "area[href]", "audio[src]", "embed[src]", "form[action]",
  "iframe[src]", "img[src]", "input[src]", "link[href]", "object[data]",
  "script[src]", "source[src]", "track[src]", "video[poster]", "video[src]",
] as const;

const attributeOf = (selector: string): string =>
  selector.slice(selector.indexOf("[") + 1, -1);

function virtualUrl(
  value: string,
  baseUrl: string,
  resolveProxyUrl: ProxyUrlResolver,
  contextId?: string,
): string | null {
  if (value.trim() === "" || value.startsWith("#")) return null;
  try {
    const target = new URL(value, baseUrl);
    return target.protocol === "http:" || target.protocol === "https:"
      ? resolveProxyUrl(target.href, contextId)
      : null;
  } catch {
    return null;
  }
}

function rewriteValue(
  value: string,
  baseUrl: string,
  resolveProxyUrl: ProxyUrlResolver,
  contextId?: string,
): string {
  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
    const child = node.nodes.find((part) => part.type === "string" || part.type === "word");
    if (child === undefined) return;
    const rewritten = virtualUrl(child.value, baseUrl, resolveProxyUrl, contextId);
    if (rewritten !== null) child.value = rewritten;
    return false;
  });
  return parsed.toString();
}

export function rewriteRemoteCss(
  css: string,
  stylesheetUrl: string,
  resolveProxyUrl: ProxyUrlResolver,
  contextId?: string,
): string {
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    return css;
  }
  root.walkDecls((decl) => {
    decl.value = rewriteValue(decl.value, stylesheetUrl, resolveProxyUrl, contextId);
  });
  root.walkAtRules("import", (rule) => {
    const parsed = valueParser(
      rewriteValue(rule.params, stylesheetUrl, resolveProxyUrl, contextId),
    );
    const first = parsed.nodes.find((node) => node.type === "string");
    if (first !== undefined && first.type === "string") {
      const rewritten = virtualUrl(first.value, stylesheetUrl, resolveProxyUrl, contextId);
      if (rewritten !== null) first.value = rewritten;
    }
    rule.params = parsed.toString();
  });
  return root.toString();
}

function documentBase(url: string): string {
  const parsed = new URL(url);
  const dir = parsed.pathname.slice(0, parsed.pathname.lastIndexOf("/") + 1);
  return `${parsed.protocol}//${parsed.host}${dir}`;
}

function scopedProxyRoot(proxyRoot: string, contextId?: string): string {
  const root = new URL(proxyRoot);
  if (root.protocol !== "http:" && root.protocol !== "https:") {
    throw new Error("the Remote Browser proxy root must use http or https");
  }
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  return contextId === undefined
    ? root.href
    : new URL(`${encodeURIComponent(contextId)}/`, root).href;
}

function browserBootstrap(targetBase: string, proxyRoot: string): string {
  return `(() => {
    const targetBase = ${JSON.stringify(targetBase)};
    const proxyRoot = ${JSON.stringify(proxyRoot)};
    const route = (value) => {
      const target = new URL(value, targetBase);
      if (target.protocol !== "http:" && target.protocol !== "https:") return target.href;
      return proxyRoot + target.protocol.slice(0, -1) + "/" + target.host + target.pathname + target.search + target.hash;
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => input instanceof Request
      ? nativeFetch(new Request(route(input.url), input), init)
      : nativeFetch(route(String(input)), init);
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      return nativeOpen.call(this, method, route(String(url)), ...rest);
    };
    if (typeof EventSource === "function") {
      const NativeEventSource = EventSource;
      const RoutedEventSource = function(url, init) {
        return new NativeEventSource(route(String(url)), init);
      };
      RoutedEventSource.prototype = NativeEventSource.prototype;
      Object.defineProperties(RoutedEventSource, {
        CONNECTING: { value: NativeEventSource.CONNECTING },
        OPEN: { value: NativeEventSource.OPEN },
        CLOSED: { value: NativeEventSource.CLOSED }
      });
      window.EventSource = RoutedEventSource;
    }
  })();`;
}

export function rewriteRemoteHtml(
  html: string,
  url: string,
  resolveProxyUrl: ProxyUrlResolver,
  contextId?: string,
  networkProxyRoot?: string,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const selector of URL_ATTRIBUTES) {
    const attribute = attributeOf(selector);
    for (const element of doc.querySelectorAll<HTMLElement>(selector)) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const rewritten = virtualUrl(value, url, resolveProxyUrl, contextId);
      if (rewritten !== null) element.setAttribute(attribute, rewritten);
    }
  }
  for (const element of doc.querySelectorAll<HTMLElement>("[style]")) {
    element.setAttribute(
      "style",
      rewriteRemoteCss(element.getAttribute("style") ?? "", url, resolveProxyUrl, contextId),
    );
  }
  for (const style of doc.querySelectorAll("style")) {
    style.textContent = rewriteRemoteCss(
      style.textContent ?? "",
      url,
      resolveProxyUrl,
      contextId,
    );
  }
  for (const oldBase of doc.querySelectorAll("base")) oldBase.remove();
  for (const oldPolicy of doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')) {
    oldPolicy.remove();
  }
  const base = doc.createElement("base");
  base.href = resolveProxyUrl(documentBase(url), contextId);
  if (networkProxyRoot === undefined) {
    doc.head.prepend(base);
  } else {
    const scopedRoot = scopedProxyRoot(networkProxyRoot, contextId);
    const policy = doc.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = [
      "default-src 'none'",
      `base-uri ${scopedRoot}`,
      `form-action ${scopedRoot}`,
      `script-src 'unsafe-inline' ${scopedRoot}`,
      `style-src 'unsafe-inline' ${scopedRoot}`,
      `img-src data: blob: ${scopedRoot}`,
      `font-src data: ${scopedRoot}`,
      `media-src data: blob: ${scopedRoot}`,
      `connect-src ${scopedRoot}`,
      `frame-src ${scopedRoot}`,
      "object-src 'none'",
      "worker-src 'none'",
    ].join("; ");
    const bootstrap = doc.createElement("script");
    bootstrap.setAttribute("data-tabverse-browser-bootstrap", "");
    bootstrap.textContent = browserBootstrap(url, scopedRoot);
    doc.head.prepend(policy, base, bootstrap);
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

export async function transformRemoteResponse(
  response: Response,
  requestUrl: string,
  resolveProxyUrl: ProxyUrlResolver,
  contextId?: string,
  networkProxyRoot?: string,
): Promise<Response> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = response.url || requestUrl;
  let body: string;
  if (contentType.includes("text/html")) {
    body = rewriteRemoteHtml(
      await response.text(),
      finalUrl,
      resolveProxyUrl,
      contextId,
      networkProxyRoot,
    );
  } else if (contentType.includes("text/css")) {
    body = rewriteRemoteCss(await response.text(), finalUrl, resolveProxyUrl, contextId);
  } else {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const transformed = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  Object.defineProperty(transformed, "url", { value: finalUrl });
  return transformed;
}
