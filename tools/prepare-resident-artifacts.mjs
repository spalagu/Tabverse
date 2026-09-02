import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";
const signingKeyHex = process.env.TABVERSE_RESIDENT_SIGNING_KEY_HEX;
if (signingKeyHex !== undefined && signingKeyHex !== "" && !/^[0-9a-fA-F]{64}$/.test(signingKeyHex)) {
  throw new Error("TABVERSE_RESIDENT_SIGNING_KEY_HEX must contain exactly 32 bytes");
}
if ((!signingKeyHex || signingKeyHex === "") && process.env.CI === "true" && release) {
  throw new Error(
    "release CI requires TABVERSE_RESIDENT_SIGNING_KEY_HEX; refusing an ephemeral trust root",
  );
}
const cargoArgs = ["build", "-p", "tabverse-resident", "--bins"];
if (release) cargoArgs.push("--release");
const buildTarget = process.env.TABVERSE_BUILD_TARGET;
if (buildTarget) cargoArgs.push("--target", buildTarget);
const cargoEnvironment = { ...process.env };
delete cargoEnvironment.TABVERSE_RESIDENT_SIGNING_KEY_HEX;
const built = spawnSync("cargo", cargoArgs, {
  cwd: root,
  env: cargoEnvironment,
  stdio: "inherit",
});
if (built.status !== 0) process.exit(built.status ?? 1);

// A cross-target verifier cannot necessarily execute on the CI runner (for
// example Windows x64 producing Windows ARM64). Build the verifier for the
// host while keeping every artifact that ships in the bundle on buildTarget.
if (buildTarget) {
  const verifierArgs = [
    "build",
    "-p",
    "tabverse-resident",
    "--bin",
    "tabverse-resident-bundle-verify",
  ];
  if (release) verifierArgs.push("--release");
  const hostVerifier = spawnSync("cargo", verifierArgs, {
    cwd: root,
    env: cargoEnvironment,
    stdio: "inherit",
  });
  if (hostVerifier.status !== 0) process.exit(hostVerifier.status ?? 1);
}

const windowsTarget = buildTarget?.includes("windows") ?? process.platform === "win32";
const suffix = windowsTarget ? ".exe" : "";
const binary = (name) =>
  join(root, "target", ...(buildTarget ? [buildTarget] : []), profile, `${name}${suffix}`);
const hostSuffix = process.platform === "win32" ? ".exe" : "";
const hostBinary = (name) => join(root, "target", profile, `${name}${hostSuffix}`);
const output = join(root, "src-tauri", "resources", "resident");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
writeFileSync(join(output, ".gitkeep"), "");

let privateKey;
if (signingKeyHex !== undefined && signingKeyHex !== "") {
  const seed = Buffer.from(signingKeyHex, "hex");
  privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
} else {
  // Development builds use a one-build key. Release CI supplies the seed as
  // an environment secret; neither path writes private key material to disk.
  privateKey = generateKeyPairSync("ed25519").privateKey;
}
const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
const publicHex = publicDer.subarray(publicDer.length - 32).toString("hex");

const supervisor = binary("tabverse-resident-supervisor");
const launcher = binary("tabverse-resident-launcher");
const worker = binary("tabverse-resident-worker");
const verifier = buildTarget
  ? hostBinary("tabverse-resident-bundle-verify")
  : binary("tabverse-resident-bundle-verify");
for (const path of [supervisor, launcher, worker, verifier]) {
  if (!existsSync(path)) throw new Error(`resident binary missing: ${path}`);
}

const control = join(output, "control");
mkdirSync(control, { recursive: true });
copyFileSync(supervisor, join(control, `tabverse-resident-supervisor${suffix}`));
copyFileSync(launcher, join(control, `tabverse-resident-launcher${suffix}`));

const definitions = [
  {
    kind: "terminal",
    pluginId: "tabverse.tab.terminal",
    permissions: [
      { capability: "terminal.runtime", reason: "Keep terminal sessions running outside the GUI" },
    ],
  },
  {
    kind: "remote",
    pluginId: "tabverse.tab.remote",
    permissions: [
      { capability: "remote.runtime", reason: "Keep the selected remote session connected outside the GUI" },
    ],
  },
  {
    kind: "browser-network",
    pluginId: "tabverse.tab.browser",
    permissions: [
      { capability: "browser.host-network", reason: "Keep host-network request routing available outside the GUI" },
    ],
  },
];

const digest = createHash("sha256").update(readFileSync(worker)).digest();
const artifactHash = digest.toString("hex");
const entrypoint = `tabverse-resident-worker${suffix}`;
const u64 = (value) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
};
const u16 = (value) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
};
const field = (value) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([u64(bytes.length), bytes]);
};
const trusted = {};
const packagedWorkers = [];
for (const definition of definitions) {
  const descriptor = {
    pluginId: definition.pluginId,
    pluginVersion: "1.0.0",
    artifactHash,
    entrypoint,
    permissions: definition.permissions,
    protocolRange: { min: 1, max: 2 },
    signature: "",
  };
  const message = Buffer.concat([
    Buffer.from("tabverse-resident-artifact/v1\0"),
    field(descriptor.pluginId),
    field(descriptor.pluginVersion),
    field(descriptor.artifactHash),
    field(descriptor.entrypoint),
    field(JSON.stringify(descriptor.permissions)),
    u16(descriptor.protocolRange.min),
    u16(descriptor.protocolRange.max),
    digest,
  ]);
  descriptor.signature = sign(null, message, privateKey).toString("hex");
  const directory = join(output, definition.kind);
  mkdirSync(directory, { recursive: true });
  const packagedWorker = join(directory, entrypoint);
  copyFileSync(worker, packagedWorker);
  packagedWorkers.push(packagedWorker);
  writeFileSync(join(directory, "descriptor.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  trusted[definition.pluginId] = [publicHex];
}
writeFileSync(
  join(control, "trusted-keys.json"),
  `${JSON.stringify({ schemaVersion: 1, plugins: trusted }, null, 2)}\n`,
);
const verified = spawnSync(verifier, [output], { cwd: root, stdio: "inherit" });
if (verified.status !== 0) process.exit(verified.status ?? 1);

// linuxdeploy mutates nested ELF resources while building an AppImage, which
// would invalidate the signed worker hash. Store Linux workers as base64 text
// in the package and materialize the original signed bytes before use.
if (!windowsTarget && process.platform === "linux") {
  for (const packagedWorker of packagedWorkers) {
    writeFileSync(`${packagedWorker}.b64`, readFileSync(packagedWorker).toString("base64"));
    rmSync(packagedWorker);
  }
}
