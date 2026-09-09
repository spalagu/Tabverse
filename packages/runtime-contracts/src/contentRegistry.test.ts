import { describe, expect, it } from "vitest";
import { CONTENT_REGISTRY, ContentRegistry } from "./contentRegistry";

describe("ContentRegistry", () => {
  it.each([
    ["README.md", "markdown", "markdown"],
    ["/work/config.YAML", "yaml", "structured-text"],
    ["C:\\work\\data.sqlite3", "sqlite", "sqlite"],
    ["photo.HEIC", "image", "image"],
    ["report.xlsx", "office", "office"],
    ["bundle.tar.gz", "archive", "archive"],
    ["Dockerfile", "source-code", "code"],
  ])("routes %s to %s", (path, id, handler) => {
    expect(CONTENT_REGISTRY.resolvePath(path)).toMatchObject({ id, handler });
  });

  it("leaves unknown content explicit", () => {
    expect(CONTENT_REGISTRY.resolvePath("payload.unknown-v3")).toBeUndefined();
  });

  it("normalizes extension lookup", () => {
    expect(CONTENT_REGISTRY.resolveExtension(".JSON")?.id).toBe("json");
  });

  it("rejects ambiguous catalogs", () => {
    expect(
      () =>
        new ContentRegistry({
          schemaVersion: 1,
          types: [
            { id: "a", extensions: ["x"], handler: "text", view: true, edit: true },
            { id: "b", extensions: ["X"], handler: "code", view: true, edit: true },
          ],
        }),
    ).toThrow("belongs to both a and b");
  });
});
