// Desktop clients launch this local MCP service directly; subscription credentials stay in the official harness.
import { accessSync, constants, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.js';
import { defaultDatabasePath, defaultWidgetPath } from './paths.js';
import { Store } from './store.js';
import { EventRuntime } from './event-runtime.js';
import { WorkerStore } from './worker-store.js';
import { PipelineEvents } from './pipeline-events.js';

export interface StdioOptions { dbPath?: string; widgetPath?: string }

export async function startStdioServer(options: StdioOptions = {}) {
  const widgetPath = options.widgetPath ?? defaultWidgetPath();
  accessSync(widgetPath, constants.R_OK);
  const databasePath = options.dbPath ?? defaultDatabasePath();
  const store = new Store(databasePath);
  const runtime = process.env.SWARMBOARD_DISABLE_RUNTIME === '1' ? undefined : new EventRuntime(store, { databasePath, serverEntry: fileURLToPath(import.meta.url), autoPool: true });
  runtime?.start();
  const poolMember = process.env.SWARMBOARD_POOL_MEMBER === '1';
  const workerId = process.env.SWARMBOARD_WORKER_ID;
  const peerState = poolMember && workerId ? new WorkerStore(databasePath + '.runtime.sqlite') : undefined;
  let updateCursor = peerState && workerId ? (peerState.get(workerId).deliveryCursor ?? peerState.get(workerId).cursor) : 0;
  const mayAct = () => {
    const pool = peerState?.pool();
    if (!pool?.enabled || !workerId || !pool.memberIds.includes(workerId) || !peerState!.get(workerId).enabled) return false;
    const tasks = store.taskStates().filter(t => !pool.taskIds.length || pool.taskIds.includes(t.id));
    return tasks.some(t => !['done', 'canceled'].includes(t.status));
  };
  const sharedUpdates = () => {
    const pool = peerState?.pool(); if (!pool) return undefined;
    const events = store.readEntries({ after: updateCursor, limit: 100 }); updateCursor = events.cursor;
    const items = events.items.filter(e => e.agentId !== workerId && (!e.taskId || !pool.taskIds.length || pool.taskIds.includes(e.taskId)) && (!e.recipientId || e.recipientId === workerId));
    const compact = items.map(e => ({ ...e, detail: e.detail.slice(0, 1000), detailTruncated: e.detail.length > 1000 }));
    return { control: mayAct() ? 'continue-if-useful' : 'stop-after-safe-boundary', organization: { memberIds: pool.memberIds, size: pool.size, maxSize: pool.maxSize }, items: compact, hasMore: events.hasMore };
  };
  const server = createMcpServer(store, widgetPath, runtime, { poolMember, ...(peerState ? { sharedUpdates, mayAct, peers: peerState, workerId, ci: new PipelineEvents(store, peerState) } : {}) });
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await runtime?.close(); await server.close(); } finally { peerState?.close(); store.close(); }
  })();
  try { await server.connect(transport); }
  catch (error) { await close(); throw error; }
  return { server, store, runtime, close };
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    // macOS /var aliases /private/var; compare canonical paths without starting the service on import.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

async function startEventDaemon() {
  const databasePath = defaultDatabasePath();
  const store = new Store(databasePath);
  const runtime = new EventRuntime(store, { databasePath, serverEntry: fileURLToPath(import.meta.url), keepAlive: true, autoPool: true });
  runtime.start();
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= (async () => { try { await runtime.close(); } finally { store.close(); } })() };
}

if (isEntrypoint()) {
  try {
    const daemon = process.argv.includes('--event-runtime');
    const running = daemon ? await startEventDaemon() : await startStdioServer();
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.stdin.off('end', stop);
      process.stdin.off('close', stop);
      void running.close().catch(error => { console.error('Swarmboard shutdown failed:', error); process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (!daemon) { process.stdin.once('end', stop); process.stdin.once('close', stop); }
  } catch (error) {
    console.error('Unable to start Swarmboard desktop MCP:', error);
    process.exitCode = 1;
  }
}
