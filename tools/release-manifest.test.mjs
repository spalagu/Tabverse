import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReleaseManifest,
  expectedReleaseAssets,
} from "./release-manifest.mjs";

const temporaryDirectories = [];

function fixture(version = "1.2.3") {
  const directory = mkdtempSync(join(tmpdir(), "tabverse-release-manifest-"));
  temporaryDirectories.push(directory);
  for (const { name } of expectedReleaseAssets(version)) {
    writeFileSync(join(directory, name), `fixture:${name}`);
  }
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("dual-runtime release manifest", () => {
  it("keeps six default Wry assets and one macOS ARM64 CEF-suffixed asset", () => {
    const expected = expectedReleaseAssets("1.2.3");
    const installers = expected.filter((asset) => asset.kind === "installer");
    expect(installers.filter((asset) => asset.runtime === "wry")).toHaveLength(
      6,
    );
    expect(installers.filter((asset) => asset.runtime === "cef")).toEqual([
      {
        name: "Tabverse_1.2.3_aarch64-cef.dmg",
        kind: "installer",
        runtime: "cef",
        target: "aarch64-apple-darwin",
      },
    ]);
    expect(
      installers
        .filter((asset) => asset.runtime === "wry")
        .every((asset) => !asset.name.includes("-cef")),
    ).toBe(true);
  });

  it("binds every installer and SBOM digest to one tag and full commit", () => {
    const directory = fixture();
    const manifest = createReleaseManifest(directory, {
      version: "1.2.3",
      tag: "v1.2.3",
      commit: "a".repeat(40),
    });
    expect(manifest.assets).toHaveLength(10);
    expect(manifest.defaultRuntime).toBe("wry");
    expect(manifest.optionalRuntime).toBe("cef");
    expect(
      manifest.assets.every((asset) => /^[0-9a-f]{64}$/.test(asset.sha256)),
    ).toBe(true);
  });

  it("refuses missing, extra, mistagged, and abbreviated release inputs", () => {
    const missing = fixture();
    rmSync(join(missing, "Tabverse_1.2.3_aarch64-cef.dmg"));
    expect(() =>
      createReleaseManifest(missing, {
        version: "1.2.3",
        tag: "v1.2.3",
        commit: "b".repeat(40),
      }),
    ).toThrow("frozen dual-runtime matrix");

    const extra = fixture();
    writeFileSync(join(extra, "Tabverse_1.2.3_windows-arm64-cef.exe"), "no");
    expect(() =>
      createReleaseManifest(extra, {
        version: "1.2.3",
        tag: "v1.2.3",
        commit: "b".repeat(40),
      }),
    ).toThrow("frozen dual-runtime matrix");

    const complete = fixture();
    expect(() =>
      createReleaseManifest(complete, {
        version: "1.2.3",
        tag: "v1.2.4",
        commit: "short",
      }),
    ).toThrow("does not match version");
    expect(() =>
      createReleaseManifest(complete, {
        version: "1.2.3",
        tag: "v1.2.3",
        commit: "short",
      }),
    ).toThrow("full lowercase Git SHA");
  });
});
