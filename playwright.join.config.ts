import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/join-browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4177/Tabverse/join/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
  webServer: {
    command: "node tools/serve-join-pages.mjs",
    url: "http://127.0.0.1:4177/Tabverse/join/",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
