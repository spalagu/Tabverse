import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const manifests = [
  "package.json",
  "packages/remote-client/package.json",
  "packages/runtime-contracts/package.json",
  "packages/runtime-desktop/package.json",
  "packages/runtime-remote/package.json",
  "packages/test-runtime/package.json",
  "packages/workbench/package.json",
];

const packageLock = json("package-lock.json");
const tauriConfig = json("src-tauri/tauri.conf.json");
const cargoToml = text("src-tauri/Cargo.toml");
const cargoLock = text("Cargo.lock");
const versions = Object.fromEntries(manifests.map((path) => [path, json(path).version]));
versions["package-lock.json"] = packageLock.version;
versions["package-lock.json packages root"] = packageLock.packages?.[""]?.version;
versions["src-tauri/tauri.conf.json"] = tauriConfig.version;
versions["src-tauri/Cargo.toml"] = rootPackageVersion(cargoToml);
versions["Cargo.lock tabverse package"] = lockedPackageVersion(cargoLock, "tabverse");

const distinct = new Set(Object.values(versions));
if (distinct.size !== 1 || distinct.has(undefined)) {
  throw new Error(`release versions disagree: ${JSON.stringify(versions)}`);
}

const [version] = distinct;
const event = process.env.GITHUB_EVENT_NAME ?? "local";
const refType = process.env.GITHUB_REF_TYPE;
if (event === "push" && refType === "tag") {
  const tag = process.env.GITHUB_REF_NAME;
  const sha = process.env.GITHUB_SHA;
  if (!tag || !sha) throw new Error("release tag and commit SHA are required");
  if (tag !== `v${version}`) {
    throw new Error(`release tag ${tag} does not match application version ${version}`);
  }
  run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
}

console.log(
  JSON.stringify({
    schema: "tabverse-release-source/v1",
    status: "passed",
    event,
    refType: refType ?? null,
    version,
    versions,
  }),
);

function text(relative) {
  return readFileSync(resolve(repository, relative), "utf8");
}

function json(relative) {
  return JSON.parse(text(relative));
}

function rootPackageVersion(source) {
  let inPackage = false;
  for (const line of source.split("\n")) {
    if (line.startsWith("[")) {
      inPackage = line === "[package]";
      continue;
    }
    if (inPackage) {
      const match = /^version\s*=\s*"([^"]+)"$/.exec(line);
      if (match) return match[1];
    }
  }
}

function lockedPackageVersion(source, packageName) {
  let name;
  let version;
  for (const line of [...source.split("\n"), "[[package]]"]) {
    if (line === "[[package]]") {
      if (name === packageName) return version;
      name = undefined;
      version = undefined;
      continue;
    }
    const nameMatch = /^name\s*=\s*"([^"]+)"$/.exec(line);
    if (nameMatch) name = nameMatch[1];
    const versionMatch = /^version\s*=\s*"([^"]+)"$/.exec(line);
    if (versionMatch) version = versionMatch[1];
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repository, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}
