import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const distributionArgument = option("--distribution");
const outputArgument = option("--output");
if (!distributionArgument || !outputArgument) {
  throw new Error("--distribution and --output are required");
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distribution = resolve(distributionArgument);
const framework = join(distribution, "Chromium Embedded Framework.framework");
const credits = join(distribution, "CREDITS.html");
if (!statSync(framework).isDirectory()) {
  throw new Error(`CEF framework is missing from ${distribution}`);
}
if (!statSync(credits).isFile() || statSync(credits).size < 1_000_000) {
  throw new Error(`CEF third-party credits are missing from ${distribution}`);
}
const creditsText = readFileSync(credits, "utf8");
if (!creditsText.includes("Chromium") || !creditsText.includes("Licenses")) {
  throw new Error(
    "CEF third-party credits do not contain the expected license index",
  );
}

const generated = join(root, "target", "cef-release-resources");
mkdirSync(generated, { recursive: true });
const bundledCredits = join(generated, "CEF-CREDITS.html.gz");
writeFileSync(
  bundledCredits,
  gzipSync(Buffer.from(creditsText), { level: 9, mtime: 0 }),
);
const cefPath = join(root, "target", "cef-release-cache");
const cachedDistribution = join(cefPath, "151.3.12", "cef_macos_aarch64");
mkdirSync(dirname(cachedDistribution), { recursive: true });
rmSync(cachedDistribution, { recursive: true, force: true });
symlinkSync(distribution, cachedDistribution, "dir");
const config = {
  build: { beforeBuildCommand: "npm run build" },
  bundle: {
    resources: {
      [join(root, "src-tauri", "resources", "resident")]: "resources/resident",
      [bundledCredits]: "CEF-CREDITS.html.gz",
    },
  },
};
const output = resolve(outputArgument);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ schema: "tabverse-cef-release-input/v1", cefPath, cefCreditsSourceBytes: statSync(credits).size, cefCreditsGzipBytes: statSync(bundledCredits).size, output })}\n`,
);
