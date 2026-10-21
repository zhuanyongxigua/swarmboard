import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DSH_COHORT_STAGES, inspectDshCohort, runDshCohort, type DshCohortRequest, type DshCohortPorts } from '../../src/harness/dsh/cohort.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(count = 2) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-cohort-')));
  roots.push(directory);
  const request: DshCohortRequest = { cohortKey: 'test-cohort', count, stateDirectory: directory, configuration: { sessionMode: 'create', model: { provider: 'synthetic', model: 'test' } } };
  const calls: string[] = [];
  const ports: DshCohortPorts = {
    preflight: async () => undefined,
    execute: async (stage, seat) => { calls.push(`${seat.key}:${stage}`); return { stage, sessionRef: seat.sessionRef }; },
  };
  return { request, calls, ports };
}

test('configurable seats resume confirmed stages without repeating any external effect', async () => {
  const { request, calls, ports } = fixture();
  expect(inspectDshCohort(request).seats).toHaveLength(2);
  expect(calls).toEqual([]);
  const first = await runDshCohort(request, ports);
  expect(first.seats.map(seat => seat.phase)).toEqual(['launched', 'launched']);
  expect(first.seats.every(seat => !seat.ready && !seat.consumed)).toBe(true);
  const previous = [...calls];
  const second = await runDshCohort(request, ports);
  expect(calls).toEqual(previous);
  expect(second.seats.map(seat => seat.sessionRef)).toEqual(first.seats.map(seat => seat.sessionRef));
  expect(calls).toHaveLength(2 * DSH_COHORT_STAGES.length);
  expect(() => inspectDshCohort({ ...request, count: 1 })).toThrow('DSH_COHORT_CONFIG_CONFLICT');
});

test('an unconfirmed side effect preserves intent, permits other seats, and is never replayed', async () => {
  const { request, calls, ports } = fixture();
  const execute = ports.execute;
  ports.execute = async (stage, seat) => {
    if (seat.key === 'seat-1' && stage === 'bind') {
      calls.push('uncertain-bind');
      throw new Error('private transport details must not be persisted');
    }
    return execute(stage, seat);
  };
  const result = await runDshCohort(request, ports);
  expect(result.seats.map(seat => seat.phase)).toEqual(['reconcile-required', 'launched']);
  expect(result.seats[0].nextStep).toContain('bind');
  const previous = [...calls];
  await runDshCohort(request, ports);
  expect(calls).toEqual(previous);
  expect(readFileSync(path.join(request.stateDirectory, 'cohort.json'), 'utf8')).not.toContain('private transport');
});

test('a missing receipt after a successful effect cannot become a new attempt', async () => {
  const { request, ports } = fixture(1);
  let effects = 0;
  ports.execute = async () => { effects++; return { invalid: undefined } as never; };
  expect((await runDshCohort(request, ports)).seats[0].phase).toBe('reconcile-required');
  expect(inspectDshCohort(request).seats[0].phase).toBe('reconcile-required');
  await runDshCohort(request, ports);
  expect(effects).toBe(1);
});

test('competing invocations have one durable winner before any external operation', async () => {
  const { request, ports, calls } = fixture(1);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = ports.execute;
  ports.execute = async (stage, seat) => { if (stage === 'admit') { enter(); await gate; } return execute(stage, seat); };
  const first = runDshCohort(request, ports);
  await entered;
  const second = await runDshCohort(request, ports);
  expect(second.busy).toBe(true);
  expect(calls).toHaveLength(0);
  release();
  await first;
  expect(calls).toHaveLength(DSH_COHORT_STAGES.length);
});

test('existing session selection preserves the exact ref and a retained crash claim is never stolen', async () => {
  const { request, calls, ports } = fixture(1);
  request.sessionRefs = ['session-00000000-0000-4000-8000-000000000001'];
  writeFileSync(path.join(request.stateDirectory, 'cohort-claim.json'), '{"token":"crashed-writer"}');
  expect((await runDshCohort(request, ports)).busy).toBe(true);
  expect(calls).toEqual([]);
  rmSync(path.join(request.stateDirectory, 'cohort-claim.json'));
  const result = await runDshCohort(request, ports);
  expect(result.seats[0].sessionRef).toBe(request.sessionRefs[0]);
  expect(result.claimPresent).toBe(false);
});

test('current authority failure blocks before intent and does not prevent another seat', async () => {
  const { request, calls, ports } = fixture();
  ports.preflight = async (_stage, seat) => { if (seat.key === 'seat-1') throw new Error('revoked'); };
  const result = await runDshCohort(request, ports);
  expect(result.seats.map(seat => seat.phase)).toEqual(['preflight-blocked', 'launched']);
  expect(calls.every(call => call.startsWith('seat-2:'))).toBe(true);
  expect(JSON.parse(readFileSync(path.join(request.stateDirectory, 'cohort.json'), 'utf8')).seats[0].attempts).toEqual([]);
});
