import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WRY_ASSETS = [
  ["x64.dmg", "x86_64-apple-darwin"],
  ["aarch64.dmg", "aarch64-apple-darwin"],
  ["windows-x64.exe", "x86_64-pc-windows-msvc"],
  ["windows-arm64.exe", "aarch64-pc-windows-msvc"],
  ["linux-x64.AppImage", "x86_64-unknown-linux-gnu"],
  ["linux-arm64.AppImage", "aarch64-unknown-linux-gnu"],
];

export function expectedReleaseAssets(version) {
  return [
    ...WRY_ASSETS.map(([suffix, target]) => ({
      name: `Tabverse_${version}_${suffix}`,
      kind: "installer",
      runtime: "wry",
      target,
    })),
    {
      name: `Tabverse_${version}_aarch64-cef.dmg`,
      kind: "installer",
      runtime: "cef",
      target: "aarch64-apple-darwin",
    },
    {
      name: `Tabverse_${version}_source-npm.cdx.json`,
      kind: "sbom",
      runtime: "shared",
      target: "source",
    },
    {
      name: `Tabverse_${version}_aarch64-wry.cdx.json`,
      kind: "sbom",
      runtime: "wry",
      target: "aarch64-apple-darwin",
    },
    {
      name: `Tabverse_${version}_aarch64-cef.cdx.json`,
      kind: "sbom",
      runtime: "cef",
      target: "aarch64-apple-darwin",
    },
  ];
}

export function createReleaseManifest(directory, { version, tag, commit }) {
  if (tag !== `v${version}`) {
    throw new Error(`release tag ${tag} does not match version ${version}`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("release commit must be a full lowercase Git SHA");
  }
  const expected = expectedReleaseAssets(version);
  const expectedNames = expected.map(({ name }) => name).sort();
  const actualNames = readdirSync(directory)
    .filter((name) => name !== "RELEASE-MANIFEST.json" && name !== "SHA256SUMS")
    .sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `release assets disagree with the frozen dual-runtime matrix: ${JSON.stringify({ expected: expectedNames, actual: actualNames })}`,
    );
  }
  const assets = expected
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((asset) => {
      const path = resolve(directory, asset.name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`release asset is not a regular file: ${asset.name}`);
      }
      return {
        ...asset,
        bytes: stat.size,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    });
  return {
    schema: "tabverse-release-manifest/v1",
    repository: "spalagu/Tabverse",
    version,
    tag,
    commit,
    defaultRuntime: "wry",
    optionalRuntime: "cef",
    assets,
  };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const directory = option("--directory");
  const version = option("--version");
  const tag = option("--tag");
  const commit = option("--commit");
  const output = option("--output");
  if (!directory || !version || !tag || !commit || !output) {
    throw new Error(
      "--directory, --version, --tag, --commit, and --output are required",
    );
  }
  const manifest = createReleaseManifest(resolve(directory), {
    version,
    tag,
    commit,
  });
  writeFileSync(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ schema: manifest.schema, assets: manifest.assets.length, tag, commit })}\n`,
  );
}
