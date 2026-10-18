// A reusable contract every harness backend must satisfy. Backends run the
// same suite through their own fixture; adding a backend must not add vendor
// branches to the collaboration core or duplicate recovery logic here.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UncertainDelivery, type HarnessBackend, type SessionAdapter } from '../../src/harness/contract.js';
import type { Worker } from '../../src/worker-store.js';

export function contractWorker(overrides: Partial<Worker> = {}): Worker {
  return { id: 'contract-worker', name: 'Contract worker', workspacePath: process.cwd(), taskIds: [], threadId: null,
    backendId: undefined, enabled: true, version: 1, cursor: 0, status: 'idle', error: '',
    deliveryId: null, deliveryCursor: null, turnId: null, ...overrides };
}

export interface AdapterContractFixture {
  backend: HarnessBackend;
  worker: Worker;
  /** A fresh adapter instance sharing the fixture's durable state. */
  session(): SessionAdapter;
  /** Resolves with the rejection of a submission whose outcome stayed unknown. */
  interruptedDelivery(): Promise<unknown>;
  cleanup(): Promise<void> | void;
}

export function adapterContract(name: string, setup: () => AdapterContractFixture | Promise<AdapterContractFixture>) {
  describe(`${name}: shared session adapter contract`, () => {
    it('declares capabilities consistent with the adapter surface and a harness-specific session intro', async () => {
      const fixture = await setup();
      try {
        const session = fixture.backend.createSession({ databasePath: ':memory:', statePath: ':memory:', serverEntry: 'unused', worker: fixture.worker, onApproval: () => {} });
        if (fixture.backend.capabilities.inspection) expect(typeof session.inspect).toBe('function');
        else expect(session.inspect).toBeUndefined();
        const intro = fixture.backend.sessionIntro(fixture.worker);
        expect(intro).toContain(fixture.worker.id);
        expect(intro.length).toBeGreaterThan(0);
        await session.close();
      } finally { await fixture.cleanup(); }
    });
    it('opens a stable session identity and resumes it from a fresh adapter instance', async () => {
      const fixture = await setup();
      try {
        const first = fixture.session();
        const threadId = await first.open(fixture.worker);
        expect(threadId).toBeTruthy();
        const second = fixture.session();
        expect(await second.open({ ...fixture.worker, threadId })).toBe(threadId);
        await first.close(); await second.close();
      } finally { await fixture.cleanup(); }
    });
    it('acknowledges turn start, completes, and reports completion after an adapter restart', async () => {
      const fixture = await setup();
      try {
        const session = fixture.session();
        const threadId = await session.open(fixture.worker);
        let turnId = '';
        // The delivery marker is how a runtime re-finds a turn whose turnId
        // acknowledgement was lost; the protocol fixture recognizes this literal.
        await session.run(threadId, 'Swarmboard delivery delivery-needle. shared contract body', started => { turnId = started; });
        expect(turnId).toBeTruthy();
        expect(await session.inspect!(threadId, turnId, 'delivery-needle')).toBe('completed');
        const restarted = fixture.session();
        expect(await restarted.inspect!(threadId, null, 'delivery-needle')).toBe('completed');
        await session.close(); await restarted.close();
      } finally { await fixture.cleanup(); }
    });
    it('reports unknown instead of inventing a result for identities it never delivered', async () => {
      const fixture = await setup();
      try {
        const session = fixture.session();
        const threadId = await session.open(fixture.worker);
        expect(await session.inspect!(threadId, 'never-submitted-turn', 'never-delivered')).toBe('unknown');
        await session.close();
      } finally { await fixture.cleanup(); }
    });
    it('surfaces an interrupted submission as an uncertain delivery, never as success', async () => {
      const fixture = await setup();
      try {
        await expect(fixture.interruptedDelivery()).rejects.toBeInstanceOf(UncertainDelivery);
      } finally { await fixture.cleanup(); }
    });
  });
}

export function contractWorkspace(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
