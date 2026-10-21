// Verify the public driver against real durable notification receipts: queue
// acceptance is not completion, and a receipt retry cannot consume a late merge.
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { NotificationService } from '../../src/notification-service.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import { createNotificationDispatcher } from '../../src/notification-dispatch.js';
import { driveOnce, intentKey, type DeliveryBatch, type Intent, type SubmitOutcome } from '../../src/harness/dsh/notification-driver.js';
import { createDshJournals } from '../../src/harness/dsh/journal-store.js';
import { createDshSdkSessionPort, type DshSdkEvent, type DshSdkSessionAgent, type DshSdkUserMessage } from '../../src/harness/dsh/sdk-session.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
type Batch = DeliveryBatch & { adapterId: string };
function fixture() {
  const board = new Store(':memory:');
  const collaborators = new CollaboratorStore(':memory:');
  cleanup.push(() => board.close(), () => collaborators.close());
  const goal = board.createTask({ title: 'Synthetic driver work' });
  const member = collaborators.configure({ expectedVersion: 0, name: 'Synthetic driver', harness: 'synthetic',
    sessionRef: 'original-session', taskIds: [goal.id], enabled: true }, board).collaborator;
  board.registerAgent({ agentId: member.id, name: member.name });
  board.registerAgent({ agentId: 'runtime-driver-test', name: 'Synthetic runtime' });
  const service = new NotificationService(board, collaborators);
  service.register(member.id, { id: 'driver-channel', version: 1, displayName: 'Synthetic channel', harness: 'synthetic',
    enabled: true, capabilities: ['durableDelivery', 'receipt'],
    members: [{ memberId: member.id, sessionRef: member.sessionRef, taskIds: [goal.id] }] });
  const dispatcher = createNotificationDispatcher(board, collaborators);
  const entry = board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: member.id,
    summary: 'SESSION_TASK_CHECK: synthetic work', detail: JSON.stringify({ kind: 'SESSION_TASK_CHECK', memberId: member.id,
      sessionRef: member.sessionRef, adapterId: 'driver-channel', registrationVersion: 1, dueAt: 300000, goalIds: [goal.id] }) });
  dispatcher.dispatch(entry);
  const records = new Map<string, Intent>();
  const journal = { get: async (key: string) => records.get(key), put: async (intent: Intent) => { records.set(intent.key, structuredClone(intent)); },
    del: async (key: string) => { records.delete(key); } };
  const pending = {
    list: async (): Promise<Batch[]> => service.pending(member.id).items.map(item => ({ memberId: member.id,
      sessionRef: member.sessionRef, adapterId: item.adapterId,
      check: { memberId: member.id, sessionRef: member.sessionRef, adapterId: item.adapterId, registrationVersion: 1, dueAt: 300000, goalIds: [goal.id] },
      entries: item.entryIds.map(id => board.readEntries({ after: id - 1, limit: 1 }).items[0]!),
      delivery: { sequence: item.sequence, entryIds: [...item.entryIds] } })),
    confirm: async (batch: DeliveryBatch) => { service.receipt(batch.memberId, batch.delivery.sequence, true, batch.delivery.entryIds); },
    release: async (): Promise<void> => { throw new Error('Unexpected release'); },
  };
  let submits = 0;
  const ports = (submit: (batch: DeliveryBatch, text: string) => Promise<SubmitOutcome>) => ({ pending, journal, session: {
    isCurrent: async () => true, isBusy: async () => false, settlement: async () => ({ settled: false as const }),
    submit: async (batch: DeliveryBatch, text: string) => { submits++; return submit(batch, text); },
  } });
  return { board, member, collaborators, service, dispatcher, records, ports, get submits() { return submits; },
    unsettled: () => new NotificationAdapterStore(board.db).unsettled() };
}

function durableJournal() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-consumer-journal-'));
  const path = join(dir, 'host.sqlite');
  let db = new DatabaseSync(path);
  let journal = createDshJournals<DeliveryBatch>({ db, sessionId: 'original-session' }).notification;
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get journal() { return journal; },
    rows: () => db.prepare('SELECT slot,data FROM dsh_host_journal ORDER BY slot').all(),
    restart() {
      db.close();
      db = new DatabaseSync(path);
      journal = createDshJournals<DeliveryBatch>({ db, sessionId: 'original-session' }).notification;
    },
  };
}

function sdkSession(member: ReturnType<typeof fixture>['member'], durableFlush = true) {
  const events: DshSdkEvent[] = [];
  const messages: DshSdkUserMessage<string>[] = [];
  const agent: DshSdkSessionAgent<string> = {
    id: member.sessionRef, session: { id: member.sessionRef, header: { cwd: '/synthetic/project' }, events },
    status: 'idle', inbox: { hasPending: false },
    send: message => { messages.push(structuredClone(message)); },
  };
  const port = createDshSdkSessionPort({ adapterId: 'driver-channel', memberId: member.id,
    sessionRef: member.sessionRef, cwd: '/synthetic/project', getAgent: id => id === agent.id ? agent : undefined,
    messageId: value => value, isAuthorized: () => true, flush: async () => durableFlush });
  return { events, messages, port };
}

describe('DSH driver and durable notification consumption', () => {
  it('does not confirm a delivery from an official queue-acceptance response alone', async () => {
    const f = fixture();
    await driveOnce(f.ports(async () => ({ status: 'enqueued' })));
    expect(f.submits).toBe(1);
    expect(f.unsettled()).toHaveLength(1);
    expect(f.records.size).toBe(1);
  });

  it('never widens a completed delivery snapshot when retrying a receipt after a busy merge', async () => {
    const f = fixture();
    const original = f.service.pending(f.member.id).items[0]!;
    const ports = f.ports(async () => {
      const late = f.board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: f.member.id,
        summary: 'A later ordinary update', detail: 'This entry was never processed by the original turn.' });
      f.dispatcher.dispatch(late);
      return { status: 'completed', turnId: 'original-turn' };
    });
    const first = await driveOnce(ports);
    expect(first.receiptPending).toHaveLength(1);
    expect(f.unsettled()).toHaveLength(1);
    expect(f.service.pending(f.member.id).items[0]!.entryIds.length).toBeGreaterThan(original.entryIds.length);
    await driveOnce(ports);
    expect(f.submits).toBe(1);
    // The first turn covered only the original snapshot. A fresh pending read
    // cannot authorize the receipt-only retry to settle the appended entry.
    expect(f.unsettled()).toHaveLength(1);
    expect(f.records.size).toBe(1);
  });

  it('processes two checks as one complete delivery and leaves a rejected batch unsettled', async () => {
    const f = fixture();
    let submitted: DeliveryBatch | undefined;
    const ports = f.ports(async batch => { submitted = structuredClone(batch); return { status: 'rejected' }; });
    const first = (await ports.pending.list())[0]!;
    const second = f.board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: f.member.id,
      summary: 'SESSION_TASK_CHECK: second check in the same batch', detail: JSON.stringify({ kind: 'SESSION_TASK_CHECK',
        memberId: f.member.id, sessionRef: f.member.sessionRef, adapterId: 'driver-channel', registrationVersion: 1,
        dueAt: 600000, goalIds: first.check!.goalIds }) });
    f.dispatcher.dispatch(second);
    const original = f.service.pending(f.member.id).items[0]!;
    expect(original.entryIds).toHaveLength(2);
    ports.pending.release = async () => {};
    await driveOnce(ports);
    expect(f.submits).toBe(1);
    expect(submitted?.entries.map(entry => entry.id)).toEqual(original.entryIds);
    expect(submitted?.delivery.entryIds).toEqual(original.entryIds);
    expect(f.unsettled()).toHaveLength(1);
  });

  it('includes every ordinary entry in the actual prompt before confirming the batch', async () => {
    const f = fixture();
    const late = f.board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: f.member.id,
      summary: 'Do not lose this peer update', detail: 'Unique ordinary payload in the consumed delivery.' });
    f.dispatcher.dispatch(late);
    let prompt = '';
    const ports = f.ports(async (_batch, text) => { prompt = text; return { status: 'completed', turnId: 'whole-batch-turn' }; });
    await driveOnce(ports);
    expect(prompt).toContain(late.summary);
    expect(prompt).toContain(late.detail);
    expect(f.submits).toBe(1);
    expect(f.unsettled()).toHaveLength(0);
  });

  it('keeps equal local sequence numbers independent across admitted sessions', async () => {
    const f = fixture();
    const otherGoal = f.board.createTask({ title: 'Second consumer scope' });
    const other = f.collaborators.configure({ expectedVersion: 0, name: 'Second consumer', harness: 'synthetic',
      sessionRef: 'second-session', taskIds: [otherGoal.id], enabled: true }, f.board).collaborator;
    f.board.registerAgent({ agentId: other.id, name: other.name });
    f.service.register(other.id, { id: 'other-channel', version: 1, displayName: 'Second channel', harness: 'synthetic',
      enabled: true, capabilities: ['durableDelivery', 'receipt'],
      members: [{ memberId: other.id, sessionRef: other.sessionRef, taskIds: [otherGoal.id] }] });
    const otherEntry = f.board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: other.id,
      summary: 'Work for the second consumer', detail: 'Independent second delivery.' });
    f.dispatcher.dispatch(otherEntry);
    const item = f.service.pending(other.id).items[0]!;
    const ports = f.ports(async batch => batch.memberId === f.member.id
      ? { status: 'unknown' } : { status: 'completed', turnId: 'second-session-turn' });
    const firstList = await ports.pending.list();
    expect(firstList[0]!.delivery.sequence).toBe(item.sequence);
    ports.pending.list = async () => [...firstList, { adapterId: item.adapterId, memberId: other.id,
      sessionRef: other.sessionRef, delivery: { sequence: item.sequence, entryIds: [...item.entryIds] }, entries: [otherEntry] }];
    await driveOnce(ports);
    expect(f.submits).toBe(2);
    expect(f.service.pending(other.id).items).toHaveLength(0);
    expect(f.service.pending(f.member.id).items).toHaveLength(1);
  });

  it('preserves an unknown consumer attempt across a real host journal reopen without resubmitting', async () => {
    const f = fixture(); const durable = durableJournal();
    const ports = { ...f.ports(async () => ({ status: 'unknown' })), journal: durable.journal };
    const batch = (await ports.pending.list())[0]!;
    await driveOnce(ports);
    const before = durable.rows();
    expect((await durable.journal.get(intentKey(batch)))?.state).toBe('unknown');
    durable.restart();
    await driveOnce({ ...ports, journal: durable.journal });
    expect(f.submits).toBe(1);
    expect(durable.rows()).toEqual(before);
    expect(f.service.pending(f.member.id).items).toHaveLength(1);
  });

  it('retries only the exact receipt after reopening a completed consumer journal', async () => {
    const f = fixture(); const durable = durableJournal();
    const ports = { ...f.ports(async () => ({ status: 'completed', turnId: 'durable-turn' })), journal: durable.journal };
    const batch = (await ports.pending.list())[0]!;
    const confirm = ports.pending.confirm;
    const echoes: number[][] = [];
    let attempts = 0;
    ports.pending.confirm = async current => {
      echoes.push([...current.delivery.entryIds]);
      if (++attempts === 1) throw new Error('Synthetic transport failure before receipt');
      await confirm(current);
    };
    await driveOnce(ports);
    expect((await durable.journal.get(intentKey(batch)))?.state).toBe('completedUnacked');
    durable.restart();
    await driveOnce({ ...ports, journal: durable.journal });
    expect(f.submits).toBe(1);
    expect(echoes).toEqual([batch.delivery.entryIds, batch.delivery.entryIds]);
    expect(f.service.pending(f.member.id).items).toHaveLength(0);
    expect(await durable.journal.get(intentKey(batch))).toBeUndefined();
  });

  it('retains the submitted snapshot after a host reopen when the delivery grew', async () => {
    const f = fixture(); const durable = durableJournal();
    const ports = { ...f.ports(async () => {
      f.dispatcher.dispatch(f.board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: f.member.id,
        summary: 'Late ordinary update after the consumer started', detail: 'Not part of the completed turn.' }));
      return { status: 'completed', turnId: 'original-snapshot-turn' };
    }), journal: durable.journal };
    const batch = (await ports.pending.list())[0]!;
    await driveOnce(ports);
    expect((await durable.journal.get(intentKey(batch)))?.batch.delivery.entryIds).toEqual(batch.delivery.entryIds);
    durable.restart();
    const second = await driveOnce({ ...ports, journal: durable.journal });
    expect(second.receiptPending).toHaveLength(1);
    expect(f.submits).toBe(1);
    expect((await durable.journal.get(intentKey(batch)))?.batch.delivery.entryIds).toEqual(batch.delivery.entryIds);
    expect(f.service.pending(f.member.id).items[0]!.entryIds).toHaveLength(2);
  });


  it('carries the SDK completion token through the driver and confirms only its own terminal turn', async () => {
    const f = fixture(); const durable = durableJournal(); const sdk = sdkSession(f.member);
    const ports = { pending: f.ports(async () => ({ status: 'rejected' })).pending,
      journal: durable.journal, session: sdk.port };
    await driveOnce(ports);
    expect(sdk.messages).toHaveLength(1);
    expect(f.service.pending(f.member.id).items).toHaveLength(1);
    sdk.events.push({ type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } });
    const unrelated = await driveOnce(ports);
    expect(unrelated.awaitingCompletion).toHaveLength(1);
    expect(f.service.pending(f.member.id).items).toHaveLength(1);
    sdk.events.push({ type: 'turn/start', seq: 3, data: { turn: 2 } },
      { type: 'user/message', seq: 4, data: sdk.messages[0] },
      { type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'completed' } } });
    const completed = await driveOnce(ports);
    expect(completed.receiptsConfirmed).toHaveLength(1);
    expect(f.service.pending(f.member.id).items).toHaveLength(0);
    expect(sdk.messages).toHaveLength(1);
    expect(durable.rows()).toHaveLength(0);
  });

  it('keeps a non-durable SDK enqueue unknown across consumer reopen and never sends it twice', async () => {
    const f = fixture(); const durable = durableJournal(); const sdk = sdkSession(f.member, false);
    const ports = { pending: f.ports(async () => ({ status: 'rejected' })).pending,
      journal: durable.journal, session: sdk.port };
    const first = await driveOnce(ports);
    expect(first.unknown).toHaveLength(1);
    const before = durable.rows();
    expect(before).toHaveLength(1);
    durable.restart();
    await driveOnce({ ...ports, journal: durable.journal });
    expect(sdk.messages).toHaveLength(1);
    expect(durable.rows()).toEqual(before);
    expect(f.service.pending(f.member.id).items).toHaveLength(1);
  });

});
