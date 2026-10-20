// Exercise the built application against an isolated SQLite database over real HTTP.
import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.SWARMBOARD_TEST_PORT ?? 4318);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './test/e2e', fullyParallel: false, workers: 1,
  timeout: 30000, retries: 0,
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node --import tsx test/e2e/server.ts', url: baseURL, reuseExistingServer: false, timeout: 20000 }
});
