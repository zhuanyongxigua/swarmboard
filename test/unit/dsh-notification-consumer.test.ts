import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runPass,
  WakerState,
  acquireWriterLock,
  promptTextFor,
  type BoardPort,
  type SeatConfig,
  type TransportPort,
  type UnsettledDelivery,
  type WakerStateShape,
  createOfficialWebTransport,
  startNotificationConsumer,
  createMcpBoardPort,
} from '../../src/harness/dsh/notification-consumer.js';

const seat: SeatConfig = { adapterId: 'synthetic-adapter', memberId: 'member-1', sessionRef: 'session-1', port: 1 };
const now = () => '2026-01-01T00:00:00Z';
const tempDirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-consumer-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boardFor(options: {
  rows?: readonly UnsettledDelivery[];
  binding?: () => ReturnType<BoardPort['binding']>;
  scope?: () => { ok: boolean; reason?: string };
  entries?: readonly { id: number; detail?: string }[];
} = {}): BoardPort {
  return {
    unsettled: () => options.rows ?? [],
    binding: () => options.binding ? options.binding() : { ok: true, adapterId: 'synthetic-adapter', registrationVersion: 1, memberTaskIds: ['goal-1'], admissionTaskIds: ['goal-1'] },
    intentCurrent: () => options.scope ? options.scope() : { ok: true },
    entries: () => options.entries ?? [],
  };
}
function transportFor(state: { prompts: unknown[]; describe?: () => Promise<{ found: boolean; running: boolean; asOfSeq: number | null }>; failPrompt?: boolean }): TransportPort {
  return {
    async describe() { return state.describe ? state.describe() : { found: true, running: false, asOfSeq: 40 }; },
    async prompt(_seat, input) {
      if (state.failPrompt) throw new Error('REJECTED');
      state.prompts.push(input);
      return { accepted: true, rpcId: input.rpcId };
    },
  };
}
const emptyState = (): WakerStateShape => ({ schema: 1, seats: {} });

describe('dsh notification consumer', () => {
  it('writes a durable intent (rpcId + watermark) before prompting once', async () => {
    const state = emptyState();
    const persisted: unknown[] = [];
    const transport = { prompts: [] as { rpcId: string; text: string }[] };
    const result = await runPass({
      seats: [seat],
      board: boardFor({ rows: [{ sequence: 3, entryIds: [10, 11] }] }),
      transport: transportFor(transport),
      state,
      now,
      newRpcId: () => 'rpc-fixed',
      persist: () => persisted.push(structuredClone(state.seats[`${seat.memberId}|${seat.sessionRef}`])),
    });
    expect(result.actions.map((action) => action.action)).toEqual(['prompted']);
    expect(transport.prompts).toHaveLength(1);
    const first = persisted[0] as { state: string; rpcId: string; asOfSeq: number; nextSeq: number };
    expect(first.state).toBe('sending');
    expect(first.rpcId).toBe('rpc-fixed');
    expect(first.asOfSeq).toBe(40);
    expect(first.nextSeq).toBe(41);
    const second = await runPass({ seats: [seat], board: boardFor({ rows: [{ sequence: 3, entryIds: [10] }] }), transport: transportFor(transport), state, now });
    expect(second.actions.map((action) => action.action)).toEqual(['awaiting-member']);
    expect(transport.prompts).toHaveLength(1);
  });

  it('carries the product check instruction in the prompt', async () => {
    const transport = { prompts: [] as { text: string }[] };
    await runPass({
      seats: [seat],
      board: boardFor({
        rows: [{ sequence: 6, entryIds: [42] }],
        entries: [{ id: 42, detail: JSON.stringify({ kind: 'SESSION_TASK_CHECK', instruction: 'INTERNAL_ONLY. Review the authorized task list.' }) }],
      }),
      transport: transportFor(transport),
      state: emptyState(),
      now,
    });
    expect(transport.prompts[0]?.text).toContain('five-minute check');
    expect(transport.prompts[0]?.text).toContain('Review the authorized task list');
    expect(promptTextFor({ sequence: 1, entries: [] })).toContain('product notice');
  });

  it('is single-flight and refuses a concurrent pass', async () => {
    const transport = { prompts: [] as unknown[] };
    const board = boardFor({ rows: [{ sequence: 1, entryIds: [1] }] });
    const [a, b] = await Promise.all([
      runPass({ seats: [seat], board, transport: transportFor(transport), state: emptyState(), now }),
      runPass({ seats: [seat], board, transport: transportFor(transport), state: emptyState(), now }),
    ]);
    expect(transport.prompts).toHaveLength(1);
    expect([...a.actions, ...b.actions].map((action) => action.action)).toContain('pass-in-flight');
  });

  it('skips busy sessions, stale bindings and out-of-scope check batches', async () => {
    const busy = { prompts: [] as unknown[] };
    const busyResult = await runPass({ seats: [seat], board: boardFor({ rows: [{ sequence: 1, entryIds: [1] }] }), transport: transportFor({ ...busy, describe: async () => ({ found: true, running: true, asOfSeq: 40 }) }), state: emptyState(), now });
    expect(busyResult.actions.map((action) => action.action)).toEqual(['busy-skip']);
    expect(busy.prompts).toHaveLength(0);

    const stale = { prompts: [] as unknown[] };
    const staleResult = await runPass({
      seats: [seat],
      board: boardFor({ rows: [{ sequence: 1, entryIds: [1] }], binding: () => ({ ok: false, reason: 'pool-disabled' }) }),
      transport: transportFor(stale),
      state: emptyState(),
      now,
    });
    expect(stale.prompts).toHaveLength(0);
    expect(staleResult.errors[0]?.error).toBe('stale-binding:pool-disabled');

    const scope = { prompts: [] as unknown[] };
    const scopeResult = await runPass({
      seats: [seat],
      board: boardFor({ rows: [{ sequence: 1, entryIds: [1] }], scope: () => ({ ok: false, reason: 'no-current-goal' }) }),
      transport: transportFor(scope),
      state: emptyState(),
      now,
    });
    expect(scope.prompts).toHaveLength(0);
    expect(scopeResult.errors[0]?.error).toBe('stale-scope:no-current-goal');
  });

  it('refuses a stale intent tuple before sending', async () => {
    const transport = { prompts: [] as unknown[] };
    const result = await runPass({
      seats: [seat],
      board: boardFor({ rows: [{ sequence: 2, entryIds: [1], adapterId: 'synthetic-adapter', registrationVersion: 1 }], binding: () => ({ ok: true, adapterId: 'synthetic-adapter', registrationVersion: 2, memberTaskIds: [], admissionTaskIds: [] }) }),
      transport: transportFor(transport),
      state: emptyState(),
      now,
    });
    expect(transport.prompts).toHaveLength(0);
    expect(result.errors[0]?.error).toContain('stale-intent:registration-version');
  });

  it('leaves unknown state on prompt rejection and never replays it', async () => {
    const state = emptyState();
    const failing = { prompts: [] as unknown[], failPrompt: true };
    const rejected = await runPass({ seats: [seat], board: boardFor({ rows: [{ sequence: 2, entryIds: [5] }] }), transport: transportFor(failing), state, now, newRpcId: () => 'rpc-unknown' });
    expect(rejected.errors[0]?.step).toBe('session.prompt');
    expect((state.seats[`${seat.memberId}|${seat.sessionRef}`] as { state: string; rpcId: string }).state).toBe('unknown');
    const ok = { prompts: [] as unknown[] };
    const again = await runPass({ seats: [seat], board: boardFor({ rows: [{ sequence: 2, entryIds: [5] }] }), transport: transportFor(ok), state, now });
    expect(again.actions.map((action) => action.action)).toEqual(['awaiting-member']);
    expect(ok.prompts).toHaveLength(0);
  });

  it('fails closed on corrupt or unsupported state and takes an exclusive lock', () => {
    const dir = tempDir();
    const corrupt = join(dir, 'state.json');
    writeFileSync(corrupt, '{broken');
    expect(() => new WakerState(corrupt, [seat])).toThrow('CONSUMER_STATE_CORRUPT');
    const wrong = join(dir, 'schema.json');
    writeFileSync(wrong, JSON.stringify({ schema: 99, seats: {} }));
    expect(() => new WakerState(wrong, [seat])).toThrow('CONSUMER_STATE_SCHEMA_UNSUPPORTED');
    const lockPath = join(dir, 'state.json.lock');
    const lock = acquireWriterLock(lockPath);
    expect(() => acquireWriterLock(lockPath)).toThrow('CONSUMER_WRITER_LOCK_HELD');
    lock.release();
    const persisted = new WakerState(join(dir, 'ok.json'), [seat]);
    persisted.state.seats[`${seat.memberId}|${seat.sessionRef}`] = { sequence: 9, entryIds: [1], rpcId: 'r', adapterId: seat.adapterId, registrationVersion: 1, sessionRef: seat.sessionRef, asOfSeq: 1, nextSeq: 2, state: 'unknown' };
    persisted.save();
    expect(readFileSync(join(dir, 'ok.json'), 'utf8')).toContain('"state": "unknown"');
  });

  it('skips while a manual continuation writer is unsettled', async () => {
    const dir = tempDir();
    const manualPath = join(dir, 'manual.json');
    writeFileSync(manualPath, JSON.stringify({ state: 'accepted' }));
    const transport = { prompts: [] as unknown[] };
    const result = await runPass({
      seats: [{ ...seat, manualWriterStatePath: manualPath }],
      board: boardFor({ rows: [{ sequence: 1, entryIds: [1] }] }),
      transport: transportFor(transport),
      state: emptyState(),
      now,
    });
    expect(transport.prompts).toHaveLength(0);
    expect(result.actions[0]?.action).toBe('manual-writer-active');
  });
});

describe('official web transport port', () => {
  it('drives session.list/session.prompt through the official local API shape', async () => {
    const calls: { url: string; body: string }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      const isList = String(url).endsWith('/api/session.list');
      return new Response(JSON.stringify({
        result: isList
          ? { ok: true, value: { items: [{ sessionId: seat.sessionRef, running: false, projections: { asOfSeq: 40 } }] } }
          : { ok: true, value: { accepted: true } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const transport = createOfficialWebTransport({ fetchImpl: fakeFetch });
    const view = await transport.describe(seat);
    expect(view).toEqual({ found: true, running: false, asOfSeq: 40 });
    const outcome = await transport.prompt(seat, { sequence: 1, text: 'hello', rpcId: 'rpc-x' });
    expect(outcome).toEqual({ accepted: true, rpcId: 'rpc-x' });
    expect(calls[0]?.url).toBe('http://127.0.0.1:1/api/session.list');
    const promptBody = JSON.parse(calls[1]?.body ?? '{}') as { method: string; rpcId: string; payload: { sessionId: string; mode: string; content: Array<{ text: string }> } };
    expect(promptBody.method).toBe('session.prompt');
    expect(promptBody.rpcId).toBe('rpc-x');
    expect(promptBody.payload.sessionId).toBe(seat.sessionRef);
    expect(promptBody.payload.mode).toBe('queue');
    expect(promptBody.payload.content[0]?.text).toBe('hello');
  });

  it('reports a missing original session and surfaces API rejection', async () => {
    const emptyFetch: typeof fetch = async () => new Response(JSON.stringify({ result: { ok: true, value: { items: [] } } }), { status: 200 });
    expect(await createOfficialWebTransport({ fetchImpl: emptyFetch }).describe(seat)).toEqual({ found: false, running: false, asOfSeq: null });
    const rejectFetch: typeof fetch = async () => new Response(JSON.stringify({ result: { ok: false, error: { code: 'rejected' } } }), { status: 200 });
    await expect(createOfficialWebTransport({ fetchImpl: rejectFetch }).describe(seat)).rejects.toThrow('official-web-api:rejected');
  });
});

describe('generation and startup boundaries', () => {
  it('refuses to send when the registration generation changes during describe', async () => {
    let calls = 0;
    const prompts: unknown[] = [];
    const board: BoardPort = {
      unsettled: () => [{ sequence: 1, entryIds: [7] }],
      binding: () => {
        calls += 1;
        return calls === 1
          ? { ok: true, adapterId: 'synthetic-adapter', registrationVersion: 1, memberTaskIds: ['goal-1'], admissionTaskIds: ['goal-1'] }
          : { ok: true, adapterId: 'synthetic-adapter', registrationVersion: 2, memberTaskIds: ['goal-1'], admissionTaskIds: ['goal-1'] };
      },
      intentCurrent: () => ({ ok: true }),
      entries: () => [],
    };
    const result = await runPass({
      seats: [seat], board, transport: transportFor({ prompts }), state: emptyState(), now,
    });
    expect(prompts).toHaveLength(0);
    expect(result.errors[0]?.error).toBe('host-authz:generation-changed:1->2');
  });

  it('creates a fresh nested state directory, locks before loading, and releases on first-pass failure', async () => {
    const dir = tempDir();
    const statePath = join(dir, 'nested', 'deeper', 'state.json');
    const failing: BoardPort = {
      unsettled: () => [{ sequence: 1, entryIds: [1] }],
      binding: () => ({ ok: true, adapterId: 'synthetic-adapter', registrationVersion: 1, memberTaskIds: [], admissionTaskIds: [] }),
      intentCurrent: () => ({ ok: true }),
      entries: () => [],
    };
    await expect(startNotificationConsumer({
      config: { boardDatabasePath: 'b', runtimeDatabasePath: 'r', statePath, seats: [seat] },
      board: failing,
      transport: transportFor({ prompts: [] }),
      now: () => { throw new Error('NOW_BOOM'); },
    })).rejects.toThrow('NOW_BOOM');
    const lock = acquireWriterLock(`${statePath}.lock`);
    lock.release();

    const ok: BoardPort = { unsettled: () => [], binding: () => ({ ok: true, adapterId: 'synthetic-adapter', registrationVersion: 1, memberTaskIds: [], admissionTaskIds: [] }), intentCurrent: () => ({ ok: true }), entries: () => [] };
    const consumer = await startNotificationConsumer({ config: { boardDatabasePath: 'b', runtimeDatabasePath: 'r', statePath, seats: [seat] }, board: ok, transport: transportFor({ prompts: [] }), once: true });
    await consumer.stop();
    expect(readFileSync(statePath, 'utf8')).toContain('"schema": 1');
  });

  it('builds a board port over the bound MCP notification tools', async () => {
    const toolCalls: string[] = [];
    const board = createMcpBoardPort({
      callTool: async ({ name }) => {
        toolCalls.push(name);
        if (name === 'notification_pending') return { items: [{ sequence: 4, entryIds: [21, 22] }] };
        if (name === 'notification_binding_read') return { binding: { adapterId: 'synthetic-adapter', sessionRef: seat.sessionRef, registrationVersion: 1, enabled: true, taskIds: ['goal-1'] } };
        if (name === 'context_read') return { items: [{ id: 21, detail: JSON.stringify({ kind: 'SESSION_TASK_CHECK', instruction: 'Check the authorized goals.' }) }] };
        return {};
      },
    });
    const prompts: { text: string }[] = [];
    const result = await runPass({ seats: [seat], board, transport: transportFor({ prompts }), state: emptyState(), now });
    expect(result.actions[0]?.action).toBe('prompted');
    expect(prompts[0]?.text).toContain('Check the authorized goals.');
    expect(toolCalls).toContain('notification_pending');
    expect(toolCalls).toContain('notification_binding_read');

    const missing = createMcpBoardPort({ callTool: async () => ({ binding: null }) });
    expect((await missing.binding(seat)).ok).toBe(false);
  });
});
