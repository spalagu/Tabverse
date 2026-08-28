import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { __JOIN_PAGES_BUILD__: "true" },
  resolve: {
    alias: [
      {
        find: /^@xterm\/addon-ligatures$/,
        replacement: fileURLToPath(
          new URL(
            "./node_modules/@xterm/addon-ligatures/lib/addon-ligatures.mjs",
            import.meta.url
          )
        ),
      },
    ],
  },
  test: {
    environment: "happy-dom",
    maxWorkers: 4,
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "apps/join/**/*.test.ts",
      "apps/join/**/*.test.tsx",
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "tools/**/*.test.mjs",
    ],
  },
});
