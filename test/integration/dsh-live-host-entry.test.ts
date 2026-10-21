// Exercise the runnable host chain through real bound MCP and SQLite; SDK services remain synthetic.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { createMcpServer } from '../../src/mcp.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import { createNotificationDispatcher } from '../../src/notification-dispatch.js';
import { createDshHostLease } from '../../src/harness/dsh/host-lease.js';
import { createDshHostPlugin } from '../../src/harness/dsh/host-plugin.js';
import { type DshSdkPluginContext } from '../../src/harness/dsh/sdk-plugin.js';
import type { DshSdkEvent, DshSdkSessionAgent, DshSdkUserMessage } from '../../src/harness/dsh/sdk-session.js';

it('runs original-session work and a late delta through plugin, lease, MCP and exact receipts', async () => {
  const board = new Store(':memory:'); const collaborators = new CollaboratorStore(':memory:');
  const db = new DatabaseSync(':memory:');
  const goal = board.createTask({ title: 'Synthetic useful work' });
  const member = collaborators.configure({ expectedVersion: 0, name: 'Synthetic host', harness: 'synthetic',
    sessionRef: 'original-session', taskIds: [goal.id], enabled: true }, board).collaborator;
  board.registerAgent({ agentId: member.id, name: member.name });
  board.registerAgent({ agentId: 'synthetic-peer', name: 'Peer' });
  const server = createMcpServer(board, 'unused', undefined, { collaborator: true, collaborators,
    collaboratorId: member.id, workerId: member.id });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(left);
  const client = new Client({ name: 'synthetic-host-chain', version: '1' }); await client.connect(right);
  let close: (() => Promise<void>) | undefined;
  try {
    const adapterId = 'synthetic-channel';
    await client.callTool({ name: 'notification_register', arguments: { id: adapterId, version: 1, displayName: 'Synthetic',
      harness: 'synthetic', enabled: true, capabilities: ['durableDelivery', 'receipt', 'timedReminder'],
      members: [{ memberId: member.id, sessionRef: member.sessionRef, taskIds: [goal.id] }] } });
    const dispatcher = createNotificationDispatcher(board, collaborators);
    const publish = (body: string) => {
      const event = board.publishEntry({ agentId: 'synthetic-peer', kind: 'MESSAGE', recipientId: member.id,
        taskId: goal.id, summary: 'Continue useful work', detail: body }); dispatcher.dispatch(event); return event;
    };
    const first = publish('FIRST_BODY_MARKER');
    const events: DshSdkEvent[] = []; const messages: DshSdkUserMessage<string>[] = [];
    const agent: DshSdkSessionAgent<string> = { id: member.sessionRef, status: 'idle',
      session: { id: member.sessionRef, header: { cwd: '/synthetic/project' }, events }, inbox: { hasPending: false },
      send(message) { messages.push(structuredClone(message)); agent.status = 'running'; } };
    const listeners = new Map<string, (...args: never[]) => void>();
    const ctx = { agents: { get: () => agent, create: async () => { throw new Error('Must retain original'); },
      resume: async () => { throw new Error('Must retain original'); } }, sessions: { flush: async () => true },
      on(name: string, listener: (...args: never[]) => void) { listeners.set(name, listener); return () => listeners.delete(name); },
    } as DshSdkPluginContext<string, string, typeof agent>;
    let wake = () => {}; const errors: unknown[] = [];
    const lease = createDshHostLease({ db, adapterId, memberId: member.id, sessionRef: member.sessionRef });
    const entry = createDshHostPlugin({ adapterId, memberId: member.id, sessionRef: member.sessionRef,
      cwd: '/synthetic/project', mode: 'attach', db, sdkSessionId: id => id, messageId: id => id,
      createOptions: {}, resumeOptions: {}, lease,
      callTool: request => client.callTool(request),
      getCurrentBinding: () => ({ adapterId, memberId: member.id, sessionRef: member.sessionRef,
        registrationVersion: 1, taskIds: [goal.id], enabled: true }),
      isAuthorized: () => true, prepareInstructions: async () => {},
      subscribeWake: listener => { wake = listener; return () => { wake = () => {}; }; }, onError: error => errors.push(error) });
    close = entry.plugin.apply(ctx); await entry.ready();
    expect(messages).toHaveLength(1); expect(messages[0]!.content[0]!.text).toContain(first.detail);
    expect(new NotificationAdapterStore(board.db).unsettled()).toHaveLength(1);
    const late = publish('LATE_BODY_MARKER'); wake(); await entry.drain(); expect(messages).toHaveLength(1);
    const complete = (index: number) => {
      const turn = index + 1;
      events.push({ type: 'turn/start', seq: events.length + 1, data: { turn } });
      events.push({ type: 'user/message', seq: events.length + 1, data: messages[index] });
      const end = { type: 'turn/end', seq: events.length + 1, data: { turn, reason: { kind: 'completed' } } };
      events.push(end); agent.status = 'idle';
      listeners.get('session/event')?.(agent.session as never, end as never);
    };
    complete(0); await entry.drain();
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content[0]!.text).toContain(late.detail);
    expect(messages[1]!.content[0]!.text).not.toContain(first.detail);
    complete(1); await entry.drain();
    expect(messages).toHaveLength(2); expect(errors).toEqual([]);
    expect(new NotificationAdapterStore(board.db).unsettled()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM dsh_host_journal WHERE slot LIKE ?').get('notification:%')!.n).toBe(0);
    expect(lease.owns()).toBe(true); await close(); close = undefined; expect(lease.owns()).toBe(false);
  } finally { await close?.(); await client.close(); await server.close(); db.close(); collaborators.close(); board.close(); }
});
