// Keep the last wake at the Promise handoff: it must not fall between the
// pump's empty-queue decision and clearing its in-flight promise.
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createDshSdkPlugin } from '../../src/harness/dsh/sdk-plugin.js';
import type { DriveResult } from '../../src/harness/dsh/notification-driver.js';
import type { DshSdkSessionAgent } from '../../src/harness/dsh/sdk-session.js';

it.each([false, true])('handles the cleanup wake without dropping success or retrying failure (failed=%s)', async failed => {
  const db = new DatabaseSync(':memory:');
  const agent: DshSdkSessionAgent<string> = { id: 'original', status: 'idle',
    session: { id: 'original', header: { cwd: '/synthetic' }, events: [] }, inbox: { hasPending: false }, send() {} };
  const empty: DriveResult = { submitted: [], merged: [], skipped: [], rejected: [], unknown: [],
    receiptsConfirmed: [], receiptPending: [], awaitingCompletion: [] };
  let wake = () => {};
  let passes = 0;
  let owner = false;
  const errors: unknown[] = [];
  const boundary = createDshSdkPlugin({ memberId: 'synthetic-member', sessionRef: 'original', cwd: '/synthetic', mode: 'attach', db,
    sdkSessionId: value => value, messageId: value => value, createOptions: {}, resumeOptions: {},
    lease: { acquire: () => { owner = true; return true; }, owns: () => owner, release: () => { owner = false; } },
    pending: { list: async () => [], confirm: async () => {}, release: async () => {}, isCurrent: async () => true },
    isAuthorized: () => true, prepareInstructions: async () => {},
    subscribeWake: listener => { wake = listener; return () => {}; }, onError: error => { errors.push(error); },
    createRunner: () => ({ pass: () => {
      passes++;
      const done = passes === 2 && failed ? Promise.reject(new Error('Synthetic pass failed')) : Promise.resolve(empty);
      // The completion observer queues a notification behind the awaiting pump
      // continuation, so it arrives after that continuation sees an empty queue.
      if (passes === 2) void done.then(() => queueMicrotask(wake), () => queueMicrotask(wake));
      return done;
    }, stop: async () => { owner = false; } }),
  });
  const close = boundary.plugin.apply({ agents: { get: () => agent,
    create: async () => { throw new Error('Unexpected create'); }, resume: async () => { throw new Error('Unexpected resume'); } },
    sessions: { flush: async () => true }, on: () => () => {} });
  try {
    await boundary.ready();
    expect(passes).toBe(1);
    wake();
    await boundary.drain();
    await Promise.resolve();
    await boundary.drain();
    expect(passes).toBe(failed ? 2 : 3);
    expect(errors).toHaveLength(failed ? 1 : 0);
  } finally { await close(); db.close(); }
});
