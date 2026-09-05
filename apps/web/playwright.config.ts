import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://127.0.0.1:3109", trace: "retain-on-failure" },
  webServer: [
    { command: "node tests/api-server.mjs", url: "http://127.0.0.1:8129/health", reuseExistingServer: false },
    { command: "npm run dev -- --hostname 127.0.0.1 --port 3109", url: "http://127.0.0.1:3109", reuseExistingServer: false,
      env: { NEXT_PUBLIC_API_BASE: "http://127.0.0.1:8129", ONEMOTION_API_BASE: "http://127.0.0.1:8129" }, timeout: 120000 },
  ],
});
