import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const outDir = process.env.TABVERSE_JOIN_OUT_DIR || "dist-pages";

export default defineConfig({
  root: "apps/join",
  base: "/Tabverse/join/",
  plugins: [react()],
  define: { __JOIN_PAGES_BUILD__: "true" },
  resolve: {
    // Alias the runtime adapter's public loader to its Pages implementation.
    alias: [
      {
        find: /^@tabverse\/runtime-remote\/wasm-loader$/,
        replacement: at("packages/runtime-remote/src/wasmLoader.pages.ts"),
      },
    ],
  },
  build: {
    outDir: at(outDir),
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: at("apps/join/index.html"),
        // The service worker is its own entry: un-hashed and at the root,
        // because its URL is its identity to the browser and its scope.
        sw: at("apps/join/src/sw.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
