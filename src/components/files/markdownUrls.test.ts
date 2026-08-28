import { describe, expect, it } from "vitest";
import { hasExplicitOrigin, resolveLocalPath } from "./markdownUrls";

describe("hasExplicitOrigin", () => {
  it("recognizes scheme-qualified and protocol-relative references", () => {
    expect(hasExplicitOrigin("https://x.test/a.png")).toBe(true);
    expect(hasExplicitOrigin("HTTP://x.test/a.png")).toBe(true);
    expect(hasExplicitOrigin("data:image/png;base64,AA==")).toBe(true);
    expect(hasExplicitOrigin("mailto:a@b.c")).toBe(true);
    expect(hasExplicitOrigin("//cdn.test/a.png")).toBe(true);
  });

  it("leaves plain paths — the rewrite candidates — unmatched", () => {
    expect(hasExplicitOrigin("img/a.png")).toBe(false);
    expect(hasExplicitOrigin("./a.png")).toBe(false);
    expect(hasExplicitOrigin("../a.png")).toBe(false);
    expect(hasExplicitOrigin("/abs/a.png")).toBe(false);
    // A Windows-style "C:" would match the scheme grammar, but a colon in
    // the first segment is exactly what makes it not a relative path.
  });
});

describe("resolveLocalPath", () => {
  const dir = "/Users/me/notes/";

  it("joins a plain relative reference onto the file's directory", () => {
    expect(resolveLocalPath(dir, "img/a.png")).toBe("/Users/me/notes/img/a.png");
    expect(resolveLocalPath(dir, "./a.png")).toBe("/Users/me/notes/a.png");
  });

  it("collapses .. segments and clamps them at the root", () => {
    expect(resolveLocalPath(dir, "../shared/a.png")).toBe(
      "/Users/me/shared/a.png"
    );
    expect(resolveLocalPath(dir, "../../../../../a.png")).toBe("/a.png");
  });

  it("keeps absolute local paths as-is", () => {
    expect(resolveLocalPath(dir, "/tmp/a.png")).toBe("/tmp/a.png");
  });

  it("drops query and fragment, which mean nothing to the file protocol", () => {
    expect(resolveLocalPath(dir, "a.png?v=2#top")).toBe("/Users/me/notes/a.png");
  });

  it("decodes percent escapes into the real filename", () => {
    expect(resolveLocalPath(dir, "my%20img.png")).toBe(
      "/Users/me/notes/my img.png"
    );
  });

  it("returns null when nothing local is named", () => {
    expect(resolveLocalPath(dir, "")).toBeNull();
    expect(resolveLocalPath(dir, "#heading")).toBeNull();
    expect(resolveLocalPath(dir, "?query")).toBeNull();
  });
});
