import type { WasmApi } from "./wasmApi";

/**
 * Remote single-file loader: the offline artifact carries the wasm module as base64
 * in a module script that tools/build-join-page.mjs appends to the page, and
 * that script publishes `window.__tabverseWasm`.
 *
 * Module scripts run in document order, so the injected loader is guaranteed
 * to execute after this bundle — but not before the first connect attempt on
 * a `#ticket` load, hence the short wait instead of a bare read.
 *
 * The Pages build never runs this file: vite.pages.config.ts aliases it to
 * wasmLoader.pages.ts, which imports the wasm-bindgen glue directly and
 * fetches the module by its content-hashed URL.
 */
export async function loadWasm(): Promise<WasmApi> {
  for (let i = 0; i < 200 && !window.__tabverseWasm; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const boot = window.__tabverseWasm;
  if (!boot) {
    throw new Error(
      "wasm loader missing — this page was built without its embedded module"
    );
  }
  return boot();
}
