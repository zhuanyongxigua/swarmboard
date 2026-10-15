// Desktop clients launch this local MCP service directly; subscription credentials stay in the official harness.
import { accessSync, constants, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.js';
import { defaultDatabasePath, defaultWidgetPath } from './paths.js';
import { Store } from './store.js';

export interface StdioOptions { dbPath?: string; widgetPath?: string }

export async function startStdioServer(options: StdioOptions = {}) {
  const widgetPath = options.widgetPath ?? defaultWidgetPath();
  accessSync(widgetPath, constants.R_OK);
  const store = new Store(options.dbPath ?? defaultDatabasePath());
  const server = createMcpServer(store, widgetPath);
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await server.close(); } finally { store.close(); }
  })();
  try { await server.connect(transport); }
  catch (error) { await close(); throw error; }
  return { server, store, close };
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    // macOS /var aliases /private/var; compare canonical paths without starting the service on import.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

if (isEntrypoint()) {
  try {
    const running = await startStdioServer();
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.stdin.off('end', stop);
      process.stdin.off('close', stop);
      void running.close().catch(error => { console.error('Swarmboard shutdown failed:', error); process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
    process.stdin.once('close', stop);
  } catch (error) {
    console.error('Unable to start Swarmboard desktop MCP:', error);
    process.exitCode = 1;
  }
}
