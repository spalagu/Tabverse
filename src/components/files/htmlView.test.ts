import { describe, expect, it } from "vitest";
import { absolutize } from "./HtmlView";

const BASE = "tabverse-file://localhost/docs/";

describe("addresses in a previewed document", () => {
  it("leaves a fragment alone, so clicking it scrolls instead of navigating", () => {
    const out = absolutize('<a href="#chapter-5">5</a>', BASE);
    expect(out).toContain('href="#chapter-5"');
    expect(out).not.toContain("/docs/#chapter-5");
  });

  it("resolves a relative address against the file's own directory", () => {
    const out = absolutize('<img src="img/x.png">', BASE);
    expect(out).toContain('src="tabverse-file://localhost/docs/img/x.png"');
  });

  it("does not touch an address that already has a scheme", () => {
    const out = absolutize(
      '<a href="https://example.test/x">x</a><img src="data:image/gif;base64,AA">',
      BASE
    );
    expect(out).toContain('href="https://example.test/x"');
    expect(out).toContain('src="data:image/gif;base64,AA"');
  });

  it("resolves every candidate a responsive image lists, with its descriptor", () => {
    const out = absolutize('<img srcset="a.png 1x, b.png 2x">', BASE);
    expect(out).toContain("tabverse-file://localhost/docs/a.png 1x");
    expect(out).toContain("tabverse-file://localhost/docs/b.png 2x");
  });
});
