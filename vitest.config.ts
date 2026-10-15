// Keep deterministic service tests separate from browser and live-host acceptance.
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/{unit,integration,api,mcp}/**/*.test.ts'],
  testTimeout: 15000,
  coverage: {
    provider: 'v8',
    include: ['src/**/*.ts'],
    exclude: ['src/index.ts'],
    reporter: ['text', 'json-summary', 'html'],
    thresholds: { lines: 80, functions: 80, branches: 65, statements: 80 }
  }
}});
