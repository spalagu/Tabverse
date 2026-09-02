import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
const sha = process.env.GITHUB_SHA ?? process.argv[3];
if (!tag || !sha) {
  throw new Error("release tag and commit SHA are required");
}

const packageJson = json("package.json");
const packageLock = json("package-lock.json");
const tauriConfig = json("src-tauri/tauri.conf.json");
const cargoToml = text("src-tauri/Cargo.toml");
const cargoLock = text("Cargo.lock");
const versions = {
  "package.json": packageJson.version,
  "package-lock.json": packageLock.version,
  "package-lock.json packages root": packageLock.packages?.[""]?.version,
  "src-tauri/tauri.conf.json": tauriConfig.version,
  "src-tauri/Cargo.toml": matchVersion(cargoToml, /^\[package\]\n(?:.*\n)*?^version\s*=\s*"([^"]+)"/m),
  "Cargo.lock tabverse package": matchVersion(cargoLock, /^\[\[package\]\]\nname\s*=\s*"tabverse"\nversion\s*=\s*"([^"]+)"/m),
};
const distinct = new Set(Object.values(versions));
if (distinct.size !== 1 || distinct.has(undefined)) {
  throw new Error(`release versions disagree: ${JSON.stringify(versions)}`);
}
const [version] = distinct;
if (tag !== `v${version}`) {
  throw new Error(`release tag ${tag} does not match application version ${version}`);
}

const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
  cwd: repository,
  stdio: "inherit",
});
if (ancestry.status !== 0) {
  throw new Error(`release commit ${sha} is not part of origin/main`);
}

console.log(JSON.stringify({ schema: "tabverse-release-source/v1", status: "passed", tag, sha, version, versions }));

function text(relative) {
  return readFileSync(resolve(repository, relative), "utf8");
}

function json(relative) {
  return JSON.parse(text(relative));
}

function matchVersion(source, pattern) {
  return pattern.exec(source)?.[1];
}
