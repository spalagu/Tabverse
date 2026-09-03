import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const baselineImage = option("--baseline-wry");
const candidateWryImage = option("--candidate-wry");
const candidateCefImage = option("--candidate-cef");
const stateFixture = option("--state-fixture");
const baselineTag = option("--baseline-tag");
const output = option("--output");
const maxCefDeltaMiB = Number(option("--max-cef-delta-mib") ?? "325");

if (
  !baselineImage ||
  !candidateWryImage ||
  !candidateCefImage ||
  !stateFixture ||
  !baselineTag ||
  !Number.isFinite(maxCefDeltaMiB)
) {
  throw new Error(
    "--baseline-wry, --candidate-wry, --candidate-cef, --state-fixture, --baseline-tag, and a valid --max-cef-delta-mib are required",
  );
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${args.join(" ")}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function appMetadata(app) {
  const contents = join(app, "Contents");
  const plist = join(contents, "Info.plist");
  const plistValue = (key) =>
    run("plutil", ["-extract", key, "raw", "-o", "-", plist], true);
  const executableName = plistValue("CFBundleExecutable");
  const frameworks = join(contents, "Frameworks");
  const entries = (() => {
    try {
      return readdirSync(frameworks);
    } catch {
      return [];
    }
  })();
  const hasCef = entries.includes("Chromium Embedded Framework.framework");
  const helpers = entries.filter((name) =>
    name.startsWith(`${executableName} Helper`),
  );
  if (hasCef !== (helpers.length === 5)) {
    throw new Error(
      `incomplete CEF payload in ${basename(app)}: framework=${hasCef}, helpers=${helpers.length}`,
    );
  }
  const kib = Number(run("du", ["-sk", app], true).split(/\s+/)[0]);
  return {
    identifier: plistValue("CFBundleIdentifier"),
    version: plistValue("CFBundleShortVersionString"),
    runtime: hasCef ? "cef" : "wry",
    cefHelpers: helpers.length,
    appBytes: kib * 1024,
  };
}

const root = mkdtempSync(join(tmpdir(), "tabverse-runtime-rollback-"));
const mounts = [];

function mountImage(imageArgument) {
  const image = resolve(imageArgument);
  const mount = mkdtempSync(join(root, "mount-"));
  run("hdiutil", [
    "attach",
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mount,
    image,
  ]);
  mounts.push(mount);
  const appName = readdirSync(mount).find((name) => name.endsWith(".app"));
  if (!appName) throw new Error(`${basename(image)} contains no application`);
  return { image: basename(image), app: join(mount, appName) };
}

try {
  const baseline = mountImage(baselineImage);
  const candidateWry = mountImage(candidateWryImage);
  const candidateCef = mountImage(candidateCefImage);
  const artifacts = [
    { ...baseline, ...appMetadata(baseline.app) },
    { ...candidateWry, ...appMetadata(candidateWry.app) },
    { ...candidateCef, ...appMetadata(candidateCef.app) },
  ];
  if (
    artifacts[0].runtime !== "wry" ||
    artifacts[1].runtime !== "wry" ||
    artifacts[2].runtime !== "cef"
  ) {
    throw new Error(
      "runtime sequence must be baseline Wry, candidate Wry, CEF",
    );
  }
  if (new Set(artifacts.map(({ identifier }) => identifier)).size !== 1) {
    throw new Error(
      "Wry and CEF packages do not share one application identity",
    );
  }
  if (artifacts[1].version !== artifacts[2].version) {
    throw new Error("candidate Wry and CEF package versions differ");
  }
  const cefDeltaBytes = artifacts[2].appBytes - artifacts[1].appBytes;
  if (cefDeltaBytes > maxCefDeltaMiB * 1024 * 1024) {
    throw new Error(
      `CEF app delta ${cefDeltaBytes} exceeds ${maxCefDeltaMiB} MiB`,
    );
  }

  const fixtureBytes = readFileSync(resolve(stateFixture));
  const fixture = JSON.parse(fixtureBytes);
  if (
    ![1, 2].includes(fixture.version) ||
    !Array.isArray(fixture.tabs) ||
    !fixture.tabs.some((tab) => tab.kind === "browser")
  ) {
    throw new Error("state fixture is not a restorable Browser session");
  }
  const appData = join(
    root,
    "Library",
    "Application Support",
    artifacts[0].identifier,
  );
  const session = join(appData, "session.json");
  const cefProfileMarker = join(
    appData,
    "browser-profiles",
    "default",
    "profile.marker",
  );
  mkdirSync(join(appData, "browser-profiles", "default"), { recursive: true });
  cpSync(resolve(stateFixture), session, { recursive: false });
  writeFileSync(cefProfileMarker, "cef-profile-must-survive-wry-rollback\n", {
    flag: "wx",
  });
  const fixtureHash = hash(fixtureBytes);
  const profileHash = hash(readFileSync(cefProfileMarker));
  const installRoot = join(root, "Applications");
  mkdirSync(installRoot, { recursive: true });
  const installedApp = join(installRoot, basename(baseline.app));
  const sequence = [artifacts[0], artifacts[1], artifacts[2], artifacts[1]];
  const observed = [];
  for (const artifact of sequence) {
    rmSync(installedApp, { recursive: true, force: true });
    cpSync(artifact.app, installedApp, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const installed = appMetadata(installedApp);
    if (hash(readFileSync(session)) !== fixtureHash) {
      throw new Error(`session changed while installing ${artifact.image}`);
    }
    if (hash(readFileSync(cefProfileMarker)) !== profileHash) {
      throw new Error(`CEF profile changed while installing ${artifact.image}`);
    }
    observed.push({ image: artifact.image, runtime: installed.runtime });
  }
  const result = {
    schema: "tabverse-runtime-rollback/v1",
    baselineTag,
    identifier: artifacts[0].identifier,
    candidateVersion: artifacts[1].version,
    maxCefDeltaMiB,
    cefDeltaBytes,
    stateSha256: fixtureHash,
    cefProfilePreserved: true,
    sequence: observed,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (output) writeFileSync(resolve(output), json);
  process.stdout.write(json);
} finally {
  for (const mount of mounts.reverse()) {
    spawnSync("hdiutil", ["detach", mount], { stdio: "inherit" });
  }
  rmSync(root, { recursive: true, force: true });
}
