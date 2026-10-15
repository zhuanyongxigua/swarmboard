// Exercise the built application against an isolated SQLite database over real HTTP.
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './test/e2e', fullyParallel: false, workers: 1,
  timeout: 30000, retries: 0,
  use: { baseURL: 'http://127.0.0.1:4318', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node --import tsx test/e2e/server.ts', url: 'http://127.0.0.1:4318', reuseExistingServer: false, timeout: 20000 }
});
