import DOMPurify from "dompurify";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";

const FORBIDDEN_TAGS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "form",
  "input",
  "textarea",
  "select",
  "option",
  "button",
  "meta",
  "base",
  "style",
];
const RESOURCE_PREFILTER_TAGS = new Set([...FORBIDDEN_TAGS, "link"]);

function prefilterResourceElements(html: string): string {
  const fragment = parseFragment(html);
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if (!("childNodes" in node)) return;
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index];
      if (RESOURCE_PREFILTER_TAGS.has(child.nodeName)) {
        node.childNodes.splice(index, 1);
      } else {
        visit(child);
      }
    }
  };
  visit(fragment);
  return serialize(fragment);
}

const ADDRESS_ATTRIBUTES = ["href", "src", "poster"] as const;

function documentBase(url: string): string {
  const parsed = new URL(url);
  const dir = parsed.pathname.slice(0, parsed.pathname.lastIndexOf("/") + 1);
  return `${parsed.protocol}//${parsed.host}${dir}`;
}

function remoteAddress(
  raw: string,
  attribute: string,
  documentUrl: string,
  resolveProxyUrl: (target: string) => string,
): string | null {
  const value = raw.trim();
  if (value === "" || value.startsWith("#")) return raw;
  if (/^(?:mailto|tel):/i.test(value) && attribute === "href") return raw;
  if (
    /^data:image\/(?:avif|gif|jpeg|png|webp);/i.test(value) &&
    attribute !== "href"
  ) {
    return raw;
  }
  try {
    const target = new URL(value, documentUrl);
    return /^https?:$/.test(target.protocol)
      ? resolveProxyUrl(target.href)
      : null;
  } catch {
    return null;
  }
}

function safeCss(
  css: string,
  documentUrl: string,
  resolveProxyUrl: (target: string) => string,
): string {
  if (/(?:expression\s*\(|behavior\s*:|-moz-binding|javascript\s*:)/i.test(css))
    return "";
  const withoutImports = css.replace(/@import\s+(?:url\()?[^;]+;?/gi, "");
  return withoutImports.replace(
    /url\(\s*(["']?)(.*?)\1\s*\)/gi,
    (_all, quote: string, value: string) => {
      const rewritten = remoteAddress(
        value,
        "style",
        documentUrl,
        resolveProxyUrl,
      );
      return rewritten === null
        ? 'url("")'
        : `url(${quote}${rewritten}${quote})`;
    },
  );
}

/**
 * Turn a Host-fetched page into a static Viewer document. The sanitizer runs
 * before URL rewriting, then a restrictive CSP and an empty iframe sandbox
 * provide independent backstops.
 */
export function mirroredDocument(
  html: string,
  documentUrl: string,
  resolveProxyUrl: (target: string) => string,
): string {
  // parse5 has no browser or network side effects. It removes resource-bearing
  // elements before DOMPurify interprets the remaining markup; DOMPurify then
  // owns the complete security sanitization pass.
  const clean = DOMPurify.sanitize(prefilterResourceElements(html), {
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: [
      "action",
      "formaction",
      "srcdoc",
      "ping",
      "background",
      "xlink:href",
    ],
  });
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${clean}</body></html>`,
    "text/html",
  );

  for (const element of Array.from(doc.querySelectorAll("*"))) {
    if (FORBIDDEN_TAGS.includes(element.tagName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
    }
    for (const attribute of ADDRESS_ATTRIBUTES) {
      const raw = element.getAttribute(attribute);
      if (raw === null) continue;
      const rewritten = remoteAddress(
        raw,
        attribute,
        documentUrl,
        resolveProxyUrl,
      );
      if (rewritten === null) element.removeAttribute(attribute);
      else element.setAttribute(attribute, rewritten);
    }
    const srcset = element.getAttribute("srcset");
    if (srcset !== null) {
      const rewritten = srcset
        .split(",")
        .map((candidate) => {
          const [raw, ...descriptor] = candidate.trim().split(/\s+/);
          const address = remoteAddress(
            raw ?? "",
            "srcset",
            documentUrl,
            resolveProxyUrl,
          );
          return address === null ? "" : [address, ...descriptor].join(" ");
        })
        .filter(Boolean)
        .join(", ");
      if (rewritten === "") element.removeAttribute("srcset");
      else element.setAttribute("srcset", rewritten);
    }
    const style = element.getAttribute("style");
    if (style !== null) {
      element.setAttribute(
        "style",
        safeCss(style, documentUrl, resolveProxyUrl),
      );
    }
  }
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    style.textContent = safeCss(
      style.textContent ?? "",
      documentUrl,
      resolveProxyUrl,
    );
  }
  for (const link of Array.from(doc.querySelectorAll("link"))) {
    if (
      (link.getAttribute("rel") ?? "").trim().toLowerCase() !== "stylesheet"
    ) {
      link.remove();
    }
  }

  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content =
    "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "font-src 'self' data:; media-src 'self'; script-src 'none'; connect-src 'none'; " +
    "frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'";
  const base = doc.createElement("base");
  base.href = resolveProxyUrl(documentBase(documentUrl));
  doc.head.prepend(base);
  doc.head.prepend(csp);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
