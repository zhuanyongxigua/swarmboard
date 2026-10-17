// Keep deterministic service tests separate from browser and live-host acceptance.
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/{unit,integration,api,mcp}/**/*.test.ts'],
  testTimeout: 15000,
  coverage: {
    provider: 'v8',
    include: ['src/**/*.ts'],
    // Entrypoints are exercised as real subprocesses; V8's in-process report cannot collect their child-process coverage.
    exclude: ['src/index.ts', 'src/stdio.ts'],
    reporter: ['text', 'json-summary', 'html'],
    thresholds: {
      lines: 80, functions: 80, branches: 65, statements: 80,
      'src/codex-session.ts': { lines: 95, functions: 90, branches: 70, statements: 90 },
      'src/event-runtime.ts': { lines: 88, functions: 80, branches: 70, statements: 80 },
    }
  }
}});
