// Desktop clients launch this local MCP service directly; subscription credentials stay in the official harness.
import { accessSync, constants, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.js';
import { defaultDatabasePath, defaultWidgetPath } from './paths.js';
import { Store } from './store.js';
import { EventRuntime } from './event-runtime.js';
import { resolveHarness } from './harness/registry.js';
import { WorkerStore } from './worker-store.js';
import { CollaboratorStore, collaboratorRole, readCollaboratorSnapshot } from './collaborators.js';
import { PipelineEvents } from './pipeline-events.js';
import { ExecutionGrants } from './execution-grants.js';

export interface StdioOptions { dbPath?: string; widgetPath?: string }

export async function startStdioServer(options: StdioOptions = {}) {
  const widgetPath = options.widgetPath ?? defaultWidgetPath();
  accessSync(widgetPath, constants.R_OK);
  // Both this service and the event daemon select the session backend through
  // the same configuration seam; an unknown backend is a startup error.
  const backend = resolveHarness();
  const databasePath = options.dbPath ?? defaultDatabasePath();
  const store = new Store(databasePath);
  const collaboratorId = process.env.SWARMBOARD_COLLABORATOR_ID;
  // Management mode exposes host-only tools without watchers, ownership or
  // deliveries, so the human host can configure beside a live organization.
  const managementOnly = process.env.SWARMBOARD_MANAGEMENT_ONLY === '1';
  const sidecar = databasePath === ':memory:' ? ':memory:' : databasePath + '.runtime.sqlite';
  // A collaborator child never runs the event runtime: Swarmboard does not
  // wake external harnesses, and file/database access alone proves no wakeup.
  const collaboratorState = collaboratorId ? new CollaboratorStore(sidecar) : undefined;
  if (collaboratorId) collaboratorState!.get(collaboratorId); // unknown id = startup error
  const role = collaboratorState && collaboratorId ? collaboratorRole(store, collaboratorState, collaboratorId) : undefined;
  const runtime = collaboratorId || process.env.SWARMBOARD_DISABLE_RUNTIME === '1' ? undefined : new EventRuntime(store, { databasePath, serverEntry: fileURLToPath(import.meta.url), backend, autoPool: !managementOnly, managementOnly });
  if (!managementOnly) runtime?.start();
  const poolMember = process.env.SWARMBOARD_POOL_MEMBER === '1';
  const workerId = process.env.SWARMBOARD_WORKER_ID;
  const peerState = poolMember && workerId ? new WorkerStore(sidecar) : undefined;
  // Native pool children need the same read-only admission snapshot the external
  // overview path already gets. Read the sidecar without CREATE TABLE/write or
  // exposing the CollaboratorStore as a collaborator role.
  const overviewAdmissions = poolMember && workerId ? () => readCollaboratorSnapshot(sidecar) : undefined;
  // An external child reads aggregate facts from the existing sidecar without
  // constructing an EventRuntime, owning workers or starting any watcher.
  const overviewPeers = collaboratorState && !runtime && !peerState ? new WorkerStore(sidecar) : undefined;
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
    return { control: mayAct() ? 'continue-if-useful' : 'stop-after-safe-boundary', executionGrants: new ExecutionGrants(store, peerState!).active(), organization: { memberIds: pool.memberIds, size: pool.size, maxSize: pool.maxSize }, items: compact, hasMore: events.hasMore };
  };
  const server = createMcpServer(store, widgetPath, runtime, {
    poolMember,
    ...(overviewPeers ? { overviewSource: () => ({ owner: overviewPeers.owner(), ownerEpoch: overviewPeers.ownerEpoch(), pool: overviewPeers.pool(), workers: overviewPeers.list(), collaborators: collaboratorState!.list() }) } : {}),
    ...(overviewAdmissions ? { overviewAdmissions } : {}),
    ...(peerState ? { sharedUpdates, mayAct, peers: peerState, workerId, ci: new PipelineEvents(store, peerState) } : {}),
    ...(collaboratorState && collaboratorId && role ? { collaborator: true, collaboratorId, collaborators: collaboratorState, sharedUpdates: role.sharedUpdates, mayAct: role.mayAct, workerId: collaboratorId } : {}),
  });
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await runtime?.close(); await server.close(); } finally { overviewPeers?.close(); collaboratorState?.close(); peerState?.close(); store.close(); }
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
  const runtime = new EventRuntime(store, { databasePath, serverEntry: fileURLToPath(import.meta.url), backend: resolveHarness(), keepAlive: true, autoPool: true });
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
    // Daemon stdout carries no MCP protocol; report readiness only after the
    // stop handlers exist so supervisors and tests can wait for a clean stop.
    else process.stdout.write('Swarmboard event runtime ready\n');
  } catch (error) {
    console.error('Unable to start Swarmboard desktop MCP:', error);
    process.exitCode = 1;
  }
}
