import { describe, expect, it } from "vitest";
import { mirroredDocument } from "./remoteDocument";

const proxy = (target: string) => `/proxy/${encodeURIComponent(target)}`;

const ATTACK_CORPUS = [
  "<script>globalThis.pwned=1</script>",
  '<img src="/ok.png" onerror="globalThis.pwned=2">',
  '<svg onload="globalThis.pwned=3"></svg>',
  '<a href="javascript:globalThis.pwned=4">bad</a>',
  '<a href="data:text/html,<script>globalThis.pwned=5</script>">bad</a>',
  '<iframe src="https://evil.test/"></iframe>',
  '<object data="https://evil.test/a"></object>',
  '<embed src="https://evil.test/a">',
  '<form action="https://evil.test/"><p>form</p></form>',
  '<input type="password" value="secret-placeholder">',
  "<textarea>secret-placeholder</textarea>",
  "<select><option>secret-placeholder</option></select>",
  '<button formaction="https://evil.test/">send</button>',
  '<meta http-equiv="refresh" content="0;url=https://evil.test/">',
  '<base href="https://evil.test/">',
  '<link rel="preload" href="https://evil.test/payload">',
  '<div style="width:expression(globalThis.pwned=17)">bad</div>',
  '<style>@import "https://evil.test/a.css";p{color:red}</style>',
  '<img srcset="javascript:globalThis.pwned=19 1x">',
  "<template><script>globalThis.pwned=20</script></template>",
] as const;

describe("Remote Browser static document sanitizer", () => {
  it("blocks all 20 script, navigation, nested-content, and credential-form vectors", () => {
    expect(ATTACK_CORPUS).toHaveLength(20);
    for (const [index, attack] of ATTACK_CORPUS.entries()) {
      const html = mirroredDocument(
        `<html><head></head><body><p id="marker">case-${index + 1}</p>${attack}</body></html>`,
        "https://intranet.test/wiki/Home",
        proxy,
      );
      const doc = new DOMParser().parseFromString(html, "text/html");
      expect(doc.body.textContent).toContain(`case-${index + 1}`);
      expect(
        doc.querySelector(
          "script,iframe,frame,frameset,object,embed,portal,form,input,textarea,select,option,button",
        ),
      ).toBeNull();
      expect(doc.querySelectorAll("base")).toHaveLength(1);
      expect(doc.querySelector("base")?.getAttribute("href")).toContain(
        "/proxy/",
      );
      expect(
        doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'),
      ).toHaveLength(1);
      expect(doc.querySelector('link:not([rel="stylesheet"])')).toBeNull();
      for (const element of Array.from(doc.querySelectorAll("*"))) {
        for (const attribute of Array.from(element.attributes)) {
          expect(attribute.name.toLowerCase().startsWith("on")).toBe(false);
          expect(/javascript:|data:text\/html/i.test(attribute.value)).toBe(
            false,
          );
        }
      }
      expect(doc.documentElement.outerHTML).not.toMatch(
        /@import|expression\s*\(|-moz-binding/i,
      );
    }
  });

  it("keeps static content and rewrites HTML and srcset resources to the Host proxy", () => {
    const html = mirroredDocument(
      '<h1>Wiki</h1><img src="icons/a.png" srcset="/a.png 1x, https://cdn.test/b.png 2x">' +
        '<a href="../next">next</a><style>.x{background:url(/bg.png)}</style>',
      "https://intranet.test/wiki/Home",
      proxy,
    );
    expect(html).toContain("Wiki");
    expect(html).toContain(
      encodeURIComponent("https://intranet.test/wiki/icons/a.png"),
    );
    expect(html).toContain(encodeURIComponent("https://intranet.test/a.png"));
    expect(html).toContain(encodeURIComponent("https://cdn.test/b.png"));
    expect(html).toContain(encodeURIComponent("https://intranet.test/next"));
    expect(html).not.toContain("bg.png");
  });

  it("rejects malformed style markup without regex pre-sanitization", () => {
    const html = mirroredDocument(
      '<style<style/onload="globalThis.pwned=1">unsafe</style><p>kept</p>',
      "https://intranet.test/wiki/Home",
      proxy,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("style")).toBeNull();
    expect(doc.documentElement.outerHTML).not.toContain("onload");
    expect(doc.body.textContent).toContain("kept");
  });
});
