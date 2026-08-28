import type { WasmApi } from "./wasmApi";
import __wbg_init, { joinShare } from "../../../crates/tabverse-web/pkg/tabverse_web.js";
import wasmUrl from "../../../crates/tabverse-web/pkg/tabverse_web_bg.wasm?url";

let ready: Promise<WasmApi> | undefined;

/** Pages-build remote loader; substituted for wasmLoader.ts by the alias in
 * vite.pages.config.ts. */
export async function loadWasm(): Promise<WasmApi> {
  if (!ready) {
    ready = (async () => {
      await __wbg_init({ module_or_path: wasmUrl });
      return { joinShare: joinShare as WasmApi["joinShare"] };
    })();
  }
  return ready;
}
