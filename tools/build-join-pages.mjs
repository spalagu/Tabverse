#!/usr/bin/env node
/**
 * Post-build check for the MULTI-FILE join page (Pages target).
 *
 * The build itself is all vite's (vite.pages.config.ts): assets are emitted
 * with content hashes, the wasm rides wasm-bindgen's own URL path, the
 * service worker lands un-hashed at the root. What vite cannot promise is
 * that the pieces the deploy depends on actually came out — a missing wasm
 * or a hashless filename would surface as a broken page (or an uncacheable
 * one) only after publish. This script fails the build instead.
 *
 * Run after: npx vite build --config vite.pages.config.ts
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outName = process.env.TABVERSE_JOIN_OUT_DIR || "dist-pages";
if (!/^dist-[a-z0-9-]+$/.test(outName)) {
  console.error(`refusing unexpected output directory: ${outName}`);
  process.exit(1);
}
const out = join(root, outName);

const fail = (msg) => {
  console.error(`${outName} check failed: ${msg}`);
  process.exit(1);
};

if (!existsSync(out)) fail(`${outName}/ missing — run the Vite Pages build first`);

// The un-hashed shell: entry, worker, manifest, icons.
for (const f of [
  "index.html",
  "sw.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
]) {
  if (!existsSync(join(out, f))) fail(`missing ${f}`);
}

// Exactly one wasm asset, content-hashed: the hash in the filename is the
// whole cache-invalidation story (sw.js caches assets/* forever).
const assets = readdirSync(join(out, "assets"));
const wasm = assets.filter((f) => f.endsWith(".wasm"));
if (wasm.length !== 1) fail(`expected exactly one .wasm asset, got [${wasm}]`);
if (!/-[A-Za-z0-9_-]{8,}\.wasm$/.test(wasm[0]))
  fail(`wasm filename carries no content hash: ${wasm[0]}`);

// The page must reference hashed assets under the Pages base; a bare
// "/assets/…" would 404 on spalagu.github.io/Tabverse/join/.
const index = readFileSync(join(out, "index.html"), "utf8");
if (!index.includes("/Tabverse/join/assets/"))
  fail("index.html does not reference /Tabverse/join/assets/ — base misconfigured");

// The glue must load the wasm by its hashed URL (the ?url import made it a
// constant in the bundle).
const jsFiles = assets.filter((f) => f.endsWith(".js"));
const bundled = jsFiles
  .map((f) => readFileSync(join(out, "assets", f), "utf8"))
  .join("\n");
if (!bundled.includes(wasm[0]))
  fail(`no bundle references the wasm asset ${wasm[0]}`);

const testHarness = process.env.TABVERSE_JOIN_TEST_HARNESS === "1";
for (const marker of ["__replayFrame", "__replayActions"]) {
  if (testHarness && !bundled.includes(marker)) {
    fail(`browser-test build is missing ${marker}`);
  }
  if (!testHarness && bundled.includes(marker)) {
    fail(`production build contains browser-test marker ${marker}`);
  }
}

// The wasm in crates/tabverse-web/pkg/ is an input to this build, not an
// output of it: vite consumes whatever wasm-bindgen last wrote. A stale pkg
// therefore ships silently — and its failure mode hides, because a page built
// on an old client still connects to a new host, it just negotiates the wrong
// protocol version and lacks the newer methods. Check the contract instead of
// the timestamp: every method the TS seam declares must exist in the glue.
const seamPath = "packages/runtime-remote/src/wasmApi.ts";
const seam = readFileSync(join(root, seamPath), "utf8");
const session = seam.slice(
  seam.indexOf("interface WasmSession"),
  seam.indexOf("interface WasmApi")
);
const declared = [...session.matchAll(/^\s{2}([a-zA-Z]\w*)\(/gm)].map((m) => m[1]);
if (declared.length < 3) fail("could not read WasmSession's methods from wasmApi.ts");
const glue = readFileSync(join(root, "crates/tabverse-web/pkg/tabverse_web.js"), "utf8");
const missing = declared.filter((m) => !new RegExp(`^\\s+${m}\\(`, "m").test(glue));
if (missing.length)
  fail(
    `crates/tabverse-web/pkg/ is stale: the glue has no [${missing}] that ` +
    `${seamPath} declares — rebuild the wasm (see tools/build-web.sh) ` +
      `before building the page`
  );

// The deploy's smoke step polls the live page for this stamp: it is how the
// workflow tells "my build is serving" from "the previous one still is".
// $TABVERSE_BUILD_ID is the git sha in CI, "dev" locally.
const buildId = process.env.TABVERSE_BUILD_ID || "dev";
if (!/^[0-9A-Za-z._-]+$/.test(buildId))
  fail(`refusing TABVERSE_BUILD_ID with unexpected characters: ${buildId}`);
const stamped = index.replace(
  "</head>",
  `<meta name="tabverse-build" content="${buildId}" />\n</head>`
);
if (!stamped.includes(`tabverse-build" content="${buildId}`))
  fail("could not stamp the build id — no </head> in index.html");
writeFileSync(join(out, "index.html"), stamped);

const size = (f) => statSync(join(out, f)).size;
const total = ["index.html", "sw.js", ...assets.map((f) => join("assets", f))]
  .map(size)
  .reduce((a, b) => a + b, 0);
console.log(
  `${outName} ok: ${wasm[0]} (${(size(join("assets", wasm[0])) / 1024 / 1024).toFixed(1)} MB), ` +
    `${assets.length} assets, ${(total / 1024 / 1024).toFixed(1)} MB total, build id ${buildId}`
);
