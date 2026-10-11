import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.ts", // not *.spec/*.test: those are picked up by bun test
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    browserName: "chromium",
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  webServer: {
    command: "bun src/server/server.ts",
    url: "http://localhost:3100/healthz",
    env: { PORT: "3100", METRICS_FILE: "data/e2e-metrics.jsonl", NODE_ENV: process.env.E2E_NODE_ENV ?? "development" },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
