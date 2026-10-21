// Separate trusted launcher control from member/model MCP access. Connections
// open only on explicit calls; this module never retries a write or admits a seat.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface DshLauncherChannelsOptions {
  nodeCommand: string;
  server: { path: string; sha256: string };
  boardDatabasePath: string;
  runtimeDirectory: string;
}
export interface DshLauncherStdioConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface DshLauncherMcpConfig extends DshLauncherStdioConfig {
  transport: 'stdio';
  serverName: 'swarmboard_worker';
  failOnStartupError: true;
  reconnect: { enabled: false };
}
export interface DshLauncherToolClient {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
export interface DshLauncherMemberClient extends DshLauncherToolClient { mcpConfig: DshLauncherMcpConfig }
export interface DshLauncherChannels {
  openManagement(): Promise<DshLauncherToolClient>;
  openMember(memberId: string): Promise<DshLauncherMemberClient>;
  memberMcpConfig(memberId: string): DshLauncherMcpConfig;
  close(): Promise<void>;
}

const managementTools = new Set(['runtime_read', 'collaborator_configure', 'preferences_read', 'user_prompt_read', 'task_read']);
const memberTools = new Set(['preferences_read', 'user_prompt_read', 'task_read', 'context_read',
  'notification_binding_read', 'notification_pending', 'notification_receipt', 'notification_register']);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim() && !value.includes('\0');
const absolute = (value: unknown): value is string => text(value) && isAbsolute(value) && resolve(value) === value;
const fail = (code: string): never => { throw new Error(`DSH_LAUNCH_${code}`); };

/** Only the first text result is authoritative; later shared-update blocks are
 * reference data. Never expose arbitrary remote errors in launcher status. */
export function readDshLauncherToolResult(response: unknown): Record<string, unknown> {
  if (!record(response)) return fail('INVALID_TOOL_RESULT');
  let value = response.structuredContent;
  if (value === undefined && Array.isArray(response.content)) {
    const first = response.content.find(part => record(part) && part.type === 'text');
    if (record(first) && typeof first.text === 'string') {
      try { value = JSON.parse(first.text); } catch { return fail('INVALID_TOOL_RESULT'); }
    }
  }
  // runtime_read has a normal string-valued health field named error. Only
  // the service's structured error envelope (or MCP isError) rejects the RPC.
  if (response.isError === true || record(value) && record(value.error)) return fail('TOOL_REJECTED');
  return record(value) ? value : fail('INVALID_TOOL_RESULT');
}

export function createDshLauncherChannels(input: DshLauncherChannelsOptions): DshLauncherChannels {
  const options = structuredClone(input);
  if (!options || !absolute(options.nodeCommand) || !absolute(options.server?.path)
    || !/^[a-f0-9]{64}$/.test(options.server.sha256) || !absolute(options.boardDatabasePath)
    || !absolute(options.runtimeDirectory)) fail('INVALID_CHANNEL_CONFIG');
  const clients = new Set<DshLauncherToolClient>();
  const opening = new Set<Promise<DshLauncherToolClient>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const ensureOpen = () => { if (closed) fail('CHANNELS_CLOSED'); };
  const member = (memberId: string) => {
    if (!text(memberId) || memberId.length > 128) fail('INVALID_MEMBER');
    return memberId;
  };
  const config = (memberId?: string): DshLauncherStdioConfig => ({ command: options.nodeCommand,
    args: [options.server.path], cwd: options.runtimeDirectory, env: {
      HOME: options.runtimeDirectory, SWARMBOARD_DB_PATH: options.boardDatabasePath,
      SWARMBOARD_HARNESS: '', SWARMBOARD_WIDGET_PATH: '', SWARMBOARD_POOL_MEMBER: '0', SWARMBOARD_WORKER_ID: '',
      SWARMBOARD_COLLABORATOR_ID: memberId ?? '',
      // Management needs the official control surface, but must not start its
      // event runtime. Member RPCs must not construct another runtime at all.
      SWARMBOARD_MANAGEMENT_ONLY: memberId === undefined ? '1' : '0',
      SWARMBOARD_DISABLE_RUNTIME: memberId === undefined ? '0' : '1',
    } });
  const mcpConfig = (memberId: string): DshLauncherMcpConfig => ({ ...config(member(memberId)), transport: 'stdio',
    serverName: 'swarmboard_worker', failOnStartupError: true, reconnect: { enabled: false } });
  const verifyServer = async () => {
    const file = options.server.path;
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file
      || createHash('sha256').update(await readFile(file)).digest('hex') !== options.server.sha256) fail('SERVER_PIN_CHANGED');
  };
  const open = (memberId?: string): Promise<DshLauncherToolClient> => {
    ensureOpen();
    if (memberId !== undefined) member(memberId);
    const work = (async () => {
      await verifyServer(); ensureOpen();
      const transport = new StdioClientTransport({ ...config(memberId), stderr: 'pipe' });
      // Consume transport diagnostics without retaining arbitrary subprocess
      // text in the public result or leaking it to a model-facing channel.
      transport.stderr?.on('data', () => {});
      const client = new Client({ name: 'swarmboard-dsh-launcher', version: '1' });
      try { await client.connect(transport); ensureOpen(); }
      catch { await client.close().catch(() => {}); await transport.close().catch(() => {}); return fail('CONNECT_FAILED'); }
      let stopped = false, stop: Promise<void> | undefined;
      const active = new Set<Promise<unknown>>();
      const allowed = memberId === undefined ? managementTools : memberTools;
      const connection: DshLauncherToolClient = {
        callTool(request) {
          ensureOpen(); if (stopped) fail('CONNECTION_CLOSED');
          if (!record(request) || !allowed.has(request.name) || !record(request.arguments)) fail('TOOL_OUTSIDE_CHANNEL');
          const operation = client.callTool({ name: request.name, arguments: structuredClone(request.arguments) });
          active.add(operation);
          void operation.then(() => active.delete(operation), () => active.delete(operation));
          return operation;
        },
        async call(name, args = {}) { return readDshLauncherToolResult(await connection.callTool({ name, arguments: args })); },
        close() {
          stopped = true;
          stop ??= (async () => { await Promise.allSettled([...active]); await client.close(); clients.delete(connection); })();
          return stop;
        },
      };
      clients.add(connection);
      return memberId === undefined ? connection : Object.assign(connection, { mcpConfig: mcpConfig(memberId) });
    })();
    opening.add(work);
    void work.then(() => opening.delete(work), () => opening.delete(work));
    return work;
  };
  return {
    openManagement: () => open(),
    openMember: memberId => open(memberId) as Promise<DshLauncherMemberClient>,
    memberMcpConfig: memberId => { ensureOpen(); return mcpConfig(memberId); },
    close() {
      closed = true;
      closing ??= (async () => { await Promise.allSettled([...opening]); await Promise.all([...clients].map(client => client.close())); })();
      return closing;
    },
  };
}
