import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const [imageArgument, runtime, architecture, mode] = process.argv.slice(2);
if (
  !imageArgument ||
  !["wry", "cef"].includes(runtime) ||
  !architecture ||
  ![undefined, "--preflight"].includes(mode)
) {
  throw new Error(
    "usage: verify-macos-release.mjs <dmg> <wry|cef> <architecture> [--preflight]",
  );
}
const releaseQualified = mode !== "--preflight";
const image = resolve(imageArgument);
const mount = mkdtempSync(join(tmpdir(), "tabverse-release-mount-"));
let attached = false;

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed for ${basename(image)}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

try {
  run("hdiutil", [
    "attach",
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mount,
    image,
  ]);
  attached = true;
  const appName = readdirSync(mount).find((name) => name.endsWith(".app"));
  if (!appName) throw new Error("DMG contains no application bundle");
  const app = join(mount, appName);
  const plist = join(app, "Contents", "Info.plist");
  const config = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  const plistValue = (key) =>
    run("plutil", ["-extract", key, "raw", "-o", "-", plist], true);
  const identifier = plistValue("CFBundleIdentifier");
  const version = plistValue("CFBundleShortVersionString");
  const executable = join(
    app,
    "Contents",
    "MacOS",
    plistValue("CFBundleExecutable"),
  );
  const executableName = basename(executable);
  if (identifier !== config.identifier || version !== config.version) {
    throw new Error(
      `bundle identity drift: ${JSON.stringify({ identifier, version })}`,
    );
  }
  const architectures = run("lipo", ["-archs", executable], true).split(/\s+/);
  if (!architectures.includes(architecture)) {
    throw new Error(`bundle does not contain ${architecture}`);
  }
  const cefFramework = join(
    app,
    "Contents",
    "Frameworks",
    "Chromium Embedded Framework.framework",
  );
  const hasCef = (() => {
    try {
      return readdirSync(join(app, "Contents", "Frameworks")).some(
        (name) => name === "Chromium Embedded Framework.framework",
      );
    } catch {
      return false;
    }
  })();
  const expectedCefHelpers = [
    `${executableName} Helper.app`,
    `${executableName} Helper (Alerts).app`,
    `${executableName} Helper (GPU).app`,
    `${executableName} Helper (Plugin).app`,
    `${executableName} Helper (Renderer).app`,
  ].sort();
  const cefHelpers = (() => {
    try {
      return readdirSync(join(app, "Contents", "Frameworks"))
        .filter((name) => name.startsWith(`${executableName} Helper`))
        .sort();
    } catch {
      return [];
    }
  })();
  if (
    (runtime === "cef") !== hasCef ||
    (runtime === "cef" &&
      JSON.stringify(cefHelpers) !== JSON.stringify(expectedCefHelpers)) ||
    (runtime === "wry" && cefHelpers.length > 0)
  ) {
    throw new Error(`runtime payload mismatch: expected ${runtime}`);
  }
  const cefCredits = join(app, "Contents", "Resources", "CEF-CREDITS.html.gz");
  const hasCefCredits = (() => {
    try {
      const text = gunzipSync(readFileSync(cefCredits)).toString("utf8");
      return text.includes("Chromium") && text.includes("Licenses");
    } catch {
      return false;
    }
  })();
  if ((runtime === "cef") !== hasCefCredits) {
    throw new Error(`CEF license payload mismatch: expected ${runtime}`);
  }
  const residentRoot = join(
    app,
    "Contents",
    "Resources",
    "resources",
    "resident",
  );
  const residentFiles = [
    "browser-network/descriptor.json",
    "browser-network/tabverse-resident-worker",
    "control/tabverse-resident-launcher",
    "control/tabverse-resident-supervisor",
    "control/trusted-keys.json",
    "remote/descriptor.json",
    "remote/tabverse-resident-worker",
    "terminal/descriptor.json",
    "terminal/tabverse-resident-worker",
  ];
  for (const relativePath of residentFiles) {
    try {
      if (statSync(join(residentRoot, relativePath)).size === 0) {
        throw new Error("empty");
      }
    } catch {
      throw new Error(`Resident payload is missing or empty: ${relativePath}`);
    }
  }
  for (const helper of cefHelpers) {
    const helperExecutable = join(
      app,
      "Contents",
      "Frameworks",
      helper,
      "Contents",
      "MacOS",
      helper.slice(0, -4),
    );
    const helperArchitectures = run(
      "lipo",
      ["-archs", helperExecutable],
      true,
    ).split(/\s+/);
    if (!helperArchitectures.includes(architecture)) {
      throw new Error(`${helper} does not contain ${architecture}`);
    }
  }
  if (releaseQualified) {
    if (hasCef)
      run("codesign", ["--verify", "--deep", "--strict", cefFramework]);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    const signature = run("codesign", ["-dv", "--verbose=4", app], true);
    if (/Signature=adhoc|TeamIdentifier=not set/.test(signature)) {
      throw new Error(
        "application is ad-hoc signed instead of Developer ID signed",
      );
    }
    run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    run("xcrun", ["stapler", "validate", app]);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", image]);
  }
  process.stdout.write(
    `${JSON.stringify({
      schema: "tabverse-macos-release/v1",
      image: basename(image),
      runtime,
      architecture,
      identifier,
      version,
      cefHelpers: cefHelpers.length,
      cefCredits: hasCefCredits,
      residentFiles: residentFiles.length,
      releaseQualified,
      notarized: releaseQualified,
    })}\n`,
  );
} finally {
  if (attached) {
    spawnSync("hdiutil", ["detach", mount], { stdio: "inherit" });
  }
  rmSync(mount, { recursive: true, force: true });
}
