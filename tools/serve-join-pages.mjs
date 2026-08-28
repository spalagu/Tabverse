#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.env.PORT ?? 4177);
const base = "/Tabverse/join/";
const outName = process.env.TABVERSE_JOIN_OUT_DIR || "dist-pages-test";
if (!/^dist-[a-z0-9-]+$/.test(outName)) {
  throw new Error(`refusing unexpected output directory: ${outName}`);
}
const root = resolve(outName);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith(base)) {
    response.writeHead(404).end("Not Found");
    return;
  }
  const requested = url.pathname.slice(base.length) || "index.html";
  const path = normalize(join(root, requested));
  if (!path.startsWith(`${root}/`) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404).end("Not Found");
    return;
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream",
  });
  createReadStream(path).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Join Pages fixture serving at http://127.0.0.1:${port}${base}`);
});
