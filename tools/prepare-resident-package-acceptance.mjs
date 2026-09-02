import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerTemp = resolve(requiredEnvironment("RUNNER_TEMP"));
const githubEnvironment = requiredEnvironment("GITHUB_ENV");
const installRoot = join(runnerTemp, "tabverse-resident-package-install");
const resourcesRoot = join(runnerTemp, "tabverse-resident-package-resources");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

if (args.has("--set-version")) {
  setAcceptanceVersion(args.get("--set-version"));
  process.exit(0);
}

if (process.argv.includes("--cleanup")) {
  cleanup();
  process.exit(0);
}

const phase = args.get("--phase");
const version = args.get("--version");
if (!/^v[12]$/.test(phase ?? "") || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error("usage: prepare-resident-package-acceptance.mjs --phase v1|v2 --version X.Y.Z");
}

const installation = installPackage(phase, version);
const resident = findResidentResources(installation.installedRoot);
verifyInstalledResidentArtifacts(resident);
const destination = join(resourcesRoot, phase);
safeRemove(destination);
mkdirSync(dirname(destination), { recursive: true });
cpSync(resident, destination, { recursive: true, dereference: true });
materializeEncodedResidentArtifacts(destination);
const packageSha256 = sha256(installation.packagePath);
writeFileSync(
  join(destination, ".package-acceptance.json"),
  `${JSON.stringify({ version, packageSha256 }, null, 2)}\n`,
);
const variable = `TABVERSE_RESIDENT_PACKAGE_${phase.toUpperCase()}`;
appendFileSync(githubEnvironment, `${variable}=${destination}\n`);
console.log(JSON.stringify({
  schema: "tabverse-resident-package-install/v1",
  phase,
  version,
  platform: process.platform,
  packageRoot: installation.installedRoot,
  packageSha256,
  residentResources: destination,
}));

function installPackage(currentPhase, currentVersion) {
  if (process.platform === "darwin") {
    const image = findBundle("dmg", ".dmg", currentVersion);
    const mount = join(runnerTemp, `tabverse-resident-dmg-${currentPhase}`);
    safeRemove(mount);
    mkdirSync(mount, { recursive: true });
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, image]);
    try {
      const app = findOne(mount, (path) => path.endsWith(".app"));
      const installed = join(installRoot, "Tabverse.app");
      safeRemove(installed);
      mkdirSync(installRoot, { recursive: true });
      run("ditto", [app, installed]);
      return { installedRoot: installed, packagePath: image };
    } finally {
      run("hdiutil", ["detach", mount]);
      safeRemove(mount);
    }
  }

  if (process.platform === "win32") {
    const installer = findBundle("nsis", ".exe", currentVersion);
    if (currentPhase === "v1") safeRemove(installRoot);
    mkdirSync(installRoot, { recursive: true });
    run(installer, ["/S", `/D=${installRoot}`]);
    return { installedRoot: installRoot, packagePath: installer };
  }

  if (process.platform === "linux") {
    const image = findBundle("appimage", ".AppImage", currentVersion);
    mkdirSync(installRoot, { recursive: true });
    const installed = join(installRoot, "Tabverse.AppImage");
    copyFileSync(image, installed);
    chmodSync(installed, 0o700);
    const extraction = join(runnerTemp, `tabverse-resident-appimage-${currentPhase}`);
    safeRemove(extraction);
    mkdirSync(extraction, { recursive: true });
    run(installed, ["--appimage-extract"], extraction);
    return { installedRoot: join(extraction, "squashfs-root"), packagePath: image };
  }

  throw new Error(`unsupported package acceptance platform: ${process.platform}`);
}

function setAcceptanceVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error("--set-version requires X.Y.Z");
  }
  for (const relative of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json"]) {
    const path = join(repository, relative);
    const document = JSON.parse(readFileSync(path, "utf8"));
    document.version = version;
    if (relative === "package-lock.json") document.packages[""].version = version;
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  }
  const cargoPath = join(repository, "src-tauri/Cargo.toml");
  const cargo = readFileSync(cargoPath, "utf8");
  const updated = cargo.replace(
    /(^\[package\]\n(?:.*\n)*?^version\s*=\s*)"[^"]+"/m,
    `$1"${version}"`,
  );
  if (updated === cargo) throw new Error("src-tauri/Cargo.toml package version was not updated");
  writeFileSync(cargoPath, updated);
}

function findBundle(kind, extension, version) {
  const directory = join(repository, "target", "release", "bundle", kind);
  const matches = walk(directory).filter(
    (path) => path.endsWith(extension) && basename(path).includes(version),
  );
  if (matches.length !== 1) {
    throw new Error(`expected one ${kind} package for ${version}, found ${matches.length}`);
  }
  return matches[0];
}

function findResidentResources(root) {
  const keys = walk(root).filter(
    (path) => basename(path) === "trusted-keys.json" && basename(dirname(path)) === "control",
  );
  if (keys.length !== 1) {
    throw new Error(`expected one installed resident trust root, found ${keys.length}`);
  }
  const resident = dirname(dirname(keys[0]));
  for (const relative of [
    "control/trusted-keys.json",
    `control/tabverse-resident-supervisor${process.platform === "win32" ? ".exe" : ""}`,
    `control/tabverse-resident-launcher${process.platform === "win32" ? ".exe" : ""}`,
    "terminal/descriptor.json",
    "remote/descriptor.json",
  ]) {
    if (!existsSync(join(resident, relative))) {
      throw new Error(`installed resident resource is missing: ${relative}`);
    }
  }
  return resident;
}

function verifyInstalledResidentArtifacts(resident) {
  for (const kind of ["terminal", "remote", "browser-network"]) {
    const descriptorPath = join(resident, kind, "descriptor.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    if (
      typeof descriptor.artifactHash !== "string"
      || !/^[0-9a-f]{64}$/i.test(descriptor.artifactHash)
      || typeof descriptor.entrypoint !== "string"
      || descriptor.entrypoint.length === 0
    ) {
      throw new Error(`installed resident descriptor is invalid: ${kind}`);
    }
    const artifact = join(resident, kind, descriptor.entrypoint);
    const encodedArtifact = `${artifact}.b64`;
    if (!existsSync(artifact) && !existsSync(encodedArtifact)) {
      throw new Error(`installed resident artifact is missing: ${kind}/${descriptor.entrypoint}`);
    }
    const bytes = existsSync(artifact)
      ? readFileSync(artifact)
      : Buffer.from(readFileSync(encodedArtifact, "utf8"), "base64");
    if (sha256Bytes(bytes) !== descriptor.artifactHash.toLowerCase()) {
      throw new Error(`installed resident artifact hash mismatch: ${kind}`);
    }
  }
}

function materializeEncodedResidentArtifacts(resident) {
  for (const kind of ["terminal", "remote", "browser-network"]) {
    const descriptor = JSON.parse(readFileSync(join(resident, kind, "descriptor.json"), "utf8"));
    const artifact = join(resident, kind, descriptor.entrypoint);
    const encodedArtifact = `${artifact}.b64`;
    if (!existsSync(artifact) && existsSync(encodedArtifact)) {
      writeFileSync(artifact, Buffer.from(readFileSync(encodedArtifact, "utf8"), "base64"));
      chmodSync(artifact, 0o700);
    }
  }
}

function cleanup() {
  if (process.platform === "win32" && existsSync(installRoot)) {
    const uninstallers = walk(installRoot).filter((path) => /^uninstall.*\.exe$/i.test(basename(path)));
    for (const uninstaller of uninstallers.slice(0, 1)) {
      const result = spawnSync(uninstaller, ["/S"], { stdio: "inherit", timeout: 120_000 });
      if (result.error && result.error.code !== "ENOENT") throw result.error;
    }
  }
  safeRemove(installRoot);
  safeRemove(resourcesRoot);
  for (const phase of ["v1", "v2"]) {
    safeRemove(join(runnerTemp, `tabverse-resident-appimage-${phase}`));
    safeRemove(join(runnerTemp, `tabverse-resident-dmg-${phase}`));
  }
}

function walk(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  return result;
}

function findOne(root, predicate) {
  const matches = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (predicate(path)) matches.push(path);
        else pending.push(path);
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(`expected one installed app directory, found ${matches.length}`);
  }
  return matches[0];
}

function run(command, commandArgs, cwd = repository) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    timeout: 20 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

function safeRemove(path) {
  const resolved = resolve(path);
  if (resolved === runnerTemp || !resolved.startsWith(`${runnerTemp}${sep}`)) {
    throw new Error(`refusing to remove path outside RUNNER_TEMP: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

function sha256(path) {
  return sha256Bytes(readFileSync(path));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
