// Use the existing inert App Server fixture to verify the actual transport
// role and keep configuration snapshots separate from ordinary event input.
import { expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexSession } from '../../src/codex-session.js';
import { boardInstructions } from '../../src/board-instructions.js';
import type { Worker } from '../../src/worker-store.js';
it('injects the complete dual snapshot and a clear as developer history before ordinary event turns', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'dual-prompt-protocol-')), log = resolve(dir, 'requests.jsonl');
  vi.stubEnv('SWARMBOARD_TEST_PROTOCOL_LOG', log);
  const session = new CodexSession({ databasePath: ':memory:', serverEntry: 'unused', binary: resolve('test/fixtures/codex-session.mjs'), requestTimeoutMs: 3000 });
  try {
    const worker = { id: 'synthetic-worker', workspacePath: process.cwd(), threadId: null } as Worker;
    const system = { boardId: 'synthetic', text: 'System expectation', version: 1, source: 'human-input' as const, updatedAt: null };
    const user = { ...system, text: 'User expectation', version: 3 };
    const first = boardInstructions(system, user), cleared = boardInstructions(system, { ...user, text: '', version: 4 });
    const id = await session.open(worker, first); await session.run(id, 'Synthetic event one', () => {});
    await session.open({ ...worker, threadId: id }, cleared); await session.run(id, 'Synthetic event two', () => {});
    const requests = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(r => r.method === 'thread/inject_items').map(r => r.params.items)).toEqual([first, cleared].map(item => [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: item.text }] }]));
    expect(requests.filter(r => r.method === 'turn/start').map(r => r.params.input)).toEqual(['Synthetic event one', 'Synthetic event two'].map(text => [{ type: 'text', text }]));
    expect(requests.filter(r => r.method === 'thread/start' || r.method === 'thread/resume').every(r => !Object.hasOwn(r.params, 'baseInstructions') && !Object.hasOwn(r.params, 'developerInstructions'))).toBe(true);
  } finally { await session.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
});
