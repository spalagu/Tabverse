import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { hasExplicitOrigin, resolveLocalPath } from "./markdownUrls";

export interface MarkdownViewProps {
  path: string;
  text: string;
  urlForPath: (path: string) => string;
}

export function MarkdownView({ path, text, urlForPath }: MarkdownViewProps) {
  const html = useMemo(
    () => renderMarkdown(path, text, urlForPath),
    [path, text, urlForPath]
  );
  return (
    <div className="md-view">
      <article
        className="md-article"
        // Backstop for anything clickable the sanitizer let through
        // (absolute http links keep their href for the tooltip): a click
        // inside the preview must never navigate the app's webview.
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest("a")) e.preventDefault();
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function renderMarkdown(
  path: string,
  text: string,
  urlForPath: (path: string) => string
): string {
  const dir = path.slice(0, path.lastIndexOf("/") + 1) || "/";
  const raw = marked.parse(text, { async: false, gfm: true });

  // Sanitize first, then rewrite only the inert result. Keeping the rewrite
  // out of DOMPurify's global hook registry prevents concurrent previews from
  // changing one another's policy.
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(raw);
  for (const node of template.content.querySelectorAll("img, a")) {
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src");
      if (src && !hasExplicitOrigin(src)) {
        // Relative image: resolve against the file's directory and load it
        // through the app's file protocol. Absolute http(s)/data URLs pass
        // through untouched.
        const abs = resolveLocalPath(dir, src);
        if (abs) node.setAttribute("src", urlForPath(abs));
        else node.removeAttribute("src");
      }
    } else if (node.tagName === "A") {
      const href = node.getAttribute("href");
      if (href && !hasExplicitOrigin(href)) {
        // Local link: keep the text, drop the navigation. The target stays
        // readable in the tooltip, so the link still documents where it
        // points without turning the preview into a file browser.
        node.removeAttribute("href");
        node.setAttribute("title", href);
        node.classList.add("md-inert-link");
      }
    }
  }
  return template.innerHTML;
}
