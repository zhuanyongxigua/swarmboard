// The official Codex App Server adapter runs the same shared contract as the
// reference backend, proving the contract is not shaped around one vendor.
import { resolve } from 'node:path';
import { CodexSession, codexBackend } from '../../src/codex-session.js';
import { adapterContract, contractWorker, contractWorkspace } from '../harness/adapter-contract.js';

const worker = contractWorker();
const context = { databasePath: ':memory:', statePath: ':memory:', serverEntry: 'unused', worker, onApproval: () => {} };
// Pin the model-free protocol fixture through the same production override
// (SWARMBOARD_CODEX) the backend itself uses; never touch a real desktop login.
process.env.SWARMBOARD_CODEX = resolve('test/fixtures/codex-session.mjs');

adapterContract('official Codex App Server', () => {
  const workspace = contractWorkspace('swarmboard-codex-contract-');
  return {
    backend: codexBackend,
    worker,
    session: () => codexBackend.createSession(context),
    interruptedDelivery: async () => {
      const session = new CodexSession({ databasePath: ':memory:', serverEntry: 'unused', binary: resolve('test/fixtures/codex-session.mjs'), requestTimeoutMs: 400, openTimeoutMs: 2500 });
      const threadId = await session.open(worker);
      return session.run(threadId, 'timeout', () => {}).finally(() => session.close());
    },
    cleanup: () => workspace.cleanup(),
  };
});
