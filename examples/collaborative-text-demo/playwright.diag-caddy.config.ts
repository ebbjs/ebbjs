import { defineConfig, devices } from "@playwright/test";

const CADDY_URL = process.env.EBB_CADDY_URL ?? "https://vps.tail9b3b6.ts.net:8443";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /diag-105-caddy\.spec\.mjs/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    headless: true,
    baseURL: CADDY_URL,
    ignoreHTTPSErrors: true,
    trace: "off",
    video: "off",
    screenshot: "off",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
