import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server is consumed both by `tauri dev` (desktop shell) and by a plain
// browser (mock backend) for UI work, so keep the port stable.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// The settings registry, derived from src-tauri/src/config.rs and injected
// into the page so the browser demo has the same values the desktop reads
// from the file. Serve-only, and inert under `tauri dev`; see the plugin.
import { demoConfig } from "./tools/vite-demo-config.mjs";

// The footer used to carry a hand-typed version string, which is a second
// place for the same fact and drifted the moment the real one changed.
const appVersion = JSON.parse(readFileSync("./package.json", "utf8")).version;
const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // The desktop application owns only its HTML and bootstrapping boundary.
  // Shared/legacy renderer modules remain at repository root until they have
  // been moved into named packages; see the Workbench migration logbook.
  root: "apps/desktop",
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react(), demoConfig()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: { input: at("apps/desktop/index.html") },
    outDir: at("dist"),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
