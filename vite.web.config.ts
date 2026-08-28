import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Builds apps/join/index.html into a single file (JS + CSS inlined) — the offline
// fallback artifact, from the same React source as the Pages build. The
// WebAssembly module is added afterwards by tools/build-join-page.mjs, which
// base64-inlines it so the page also works from file://.
export default defineConfig({
  root: "apps/join",
  plugins: [react(), viteSingleFile()],
  define: { __JOIN_PAGES_BUILD__: "false" },
  build: {
    rollupOptions: { input: at("apps/join/index.html") },
    // Keep Vite's intermediate HTML inside its app root. The assembler emits
    // the published single-file artifact at repository-root dist-web/.
    outDir: at("apps/join/.offline-build"),
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 100_000_000,
  },
});
