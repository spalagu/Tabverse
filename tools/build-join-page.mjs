#!/usr/bin/env node
/**
 * Assemble the standalone remote-control page (offline fallback).
 *
 * Output is ONE html file with the JavaScript, CSS and the WebAssembly module
 * all inlined. Inlining the wasm as base64 (rather than fetching a .wasm
 * sibling) is what lets the page run from `file://` — a fetch would be blocked
 * by the origin rules, and requiring a web server would defeat the point of
 * "nothing to install, nothing to host". The hosted twin is the Pages build
 * (vite.pages.config.ts), which fetches the wasm by content-hashed URL.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viteOut = join(root, "apps", "join", ".offline-build");
const wasmPkg = join(root, "crates", "tabverse-web", "pkg");
const outFile = join(root, "dist-web", "tabverse-remote.html");

function read(path) {
  if (!existsSync(path)) {
    console.error(`missing ${path}`);
    process.exit(1);
  }
  return readFileSync(path);
}

// 1. The Vite intermediate build of apps/join/index.html, with its JS and CSS already inlined by
//    vite-plugin-singlefile. PWA links point at files a single-file artifact
//    does not carry; strip them rather than ship dangling references.
const page = read(join(viteOut, "index.html"))
  .toString()
  .replace(/^\s*<link rel="(?:manifest|icon|apple-touch-icon)"[^>]*>\n?/gm, "");

// 2. wasm-bindgen output: the JS glue plus the module itself.
const glue = read(join(wasmPkg, "tabverse_web.js")).toString();
const wasmB64 = read(join(wasmPkg, "tabverse_web_bg.wasm")).toString("base64");

// wasm-bindgen's ESM glue ends with a default export that fetches the .wasm.
// We keep the glue verbatim and feed it bytes instead of a URL.
const loader = `
<script type="module">
// Inlined WebAssembly module — see tools/build-join-page.mjs for why.
const WASM_B64 = "${wasmB64}";
function wasmBytes() {
  const bin = atob(WASM_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
${glue.replace(/^export\s+default\s+/m, "const __wbg_init = ")}
let ready;
window.__tabverseWasm = async () => {
  if (!ready) {
    ready = (async () => {
      await __wbg_init({ module_or_path: wasmBytes() });
      return { joinShare };
    })();
  }
  return ready;
};
</script>
`;

const html = page.replace("</body>", `${loader}</body>`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);

const mb = (html.length / 1024 / 1024).toFixed(1);
console.log(`wrote ${outFile} (${mb} MB, self-contained)`);
