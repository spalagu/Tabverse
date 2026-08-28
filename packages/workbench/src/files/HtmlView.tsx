import { useMemo } from "react";
import DOMPurify from "dompurify";
import { STR } from "../strings";

export interface HtmlViewProps {
  path: string;
  text: string;
  onOpenInBrowser: () => void;
  urlForPath: (path: string) => string;
}

export function HtmlView({
  path,
  text,
  onOpenInBrowser,
  urlForPath,
}: HtmlViewProps) {
  const source = useMemo(
    () => buildPreviewDocument(path, text, urlForPath),
    [path, text, urlForPath]
  );
  const name = path.split("/").pop() ?? path;

  return (
    <div className="html-view">
      <div className="html-view-bar">
        <span className="html-view-note">
          {STR.files.html.staticNote}
          {source.fallbackSrcdoc ? STR.files.html.fallbackNote : ""}
        </span>
        <div className="html-view-spacer" />
        <button className="btn" onClick={onOpenInBrowser}>
          {STR.files.html.openInBrowser}
        </button>
      </div>
      <iframe
        className="html-view-frame"
        sandbox=""
        src={source.url}
        srcDoc={source.fallbackSrcdoc}
        title={name}
      />
    </div>
  );
}

/**
 * How the frame should be given the document.
 *
 * `url` is the normal way. `fallbackSrcdoc` exists for a document too large
 * to carry in an address, where rendering it without working anchors beats
 * not rendering it — and that is said in the note above the frame rather
 * than left to be discovered.
 */
interface PreviewSource {
  url?: string;
  fallbackSrcdoc?: string;
}

/// Past this, an address stops being a reasonable way to carry a document.
/// Chosen as "larger than any hand-written page in this repository", not
/// from a platform limit.
const MAX_ADDRESS_BYTES = 2 * 1024 * 1024;

function buildPreviewDocument(
  path: string,
  text: string,
  urlForPath: (path: string) => string
): PreviewSource {
  const dir = path.slice(0, path.lastIndexOf("/") + 1) || "/";

  // <link> is not in DOMPurify's default allowlist; re-admit only the
  // stylesheet flavor so a page's relative CSS renders. Every other rel
  // (preload, prefetch, icon…) has no business in a static preview.
  const dropNonStylesheetLinks = (
    node: Node,
    data: { tagName: string }
  ) => {
    if (data.tagName !== "link") return;
    const el = node as Element;
    if (typeof el.getAttribute !== "function") return;
    if ((el.getAttribute("rel") ?? "").trim().toLowerCase() !== "stylesheet") {
      el.remove();
    }
  };

  DOMPurify.addHook("uponSanitizeElement", dropNonStylesheetLinks);
  let clean: string;
  try {
    clean = DOMPurify.sanitize(text, {
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ["link"],
    });
  } finally {
    // Per-call hook: it must not leak into the other users of the
    // DOMPurify singleton (markdown/docx/xlsx previews).
    DOMPurify.removeHook("uponSanitizeElement", dropNonStylesheetLinks);
  }

  const html = absolutize(clean, urlForPath(dir));
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  return url.length <= MAX_ADDRESS_BYTES
    ? { url }
    : { fallbackSrcdoc: html };
}

/** Attributes that can carry an address worth resolving. */
const ADDRESS_ATTRIBUTES = ["href", "src", "poster"] as const;

/// Exported for the test that guards the fragment case: the sanitizer's
/// whole-document mode cannot run in the test environment, and the bug
/// lived here rather than in it.
export function absolutize(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const resolve = (value: string): string | null => {
    const raw = value.trim();
    // The whole point: a fragment stays a fragment, so the browser scrolls
    // instead of navigating.
    if (raw === "" || raw.startsWith("#")) return null;
    // Already absolute, or a scheme of its own (data:, mailto:, http:).
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
    try {
      return new URL(raw, baseUrl).href;
    } catch {
      return null;
    }
  };

  for (const el of Array.from(doc.querySelectorAll("[href], [src], [srcset], [poster]"))) {
    for (const attr of ADDRESS_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value === null) continue;
      const resolved = resolve(value);
      if (resolved !== null) el.setAttribute(attr, resolved);
    }
    // A responsive image carries several addresses in one attribute, each
    // followed by its descriptor.
    const srcset = el.getAttribute("srcset");
    if (srcset !== null) {
      el.setAttribute(
        "srcset",
        srcset
          .split(",")
          .map((candidate) => {
            const parts = candidate.trim().split(/\s+/);
            if (parts.length === 0) return candidate;
            const resolved = resolve(parts[0]);
            if (resolved === null) return candidate;
            return [resolved, ...parts.slice(1)].join(" ");
          })
          .join(", ")
      );
    }
  }

  return doc.documentElement.outerHTML;
}
