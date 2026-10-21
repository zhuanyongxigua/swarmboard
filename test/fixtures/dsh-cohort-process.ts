// Separate processes exercise the durable operator claim without a model or MCP server.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { runDshCohort } from '../../src/harness/dsh/cohort.js';

const [directory, mode] = process.argv.slice(2);
const result = await runDshCohort({ cohortKey: 'process-test', stateDirectory: directory, count: 1, configuration: {} }, {
  preflight: async () => undefined,
  execute: async stage => {
    appendFileSync(path.join(directory, 'effects.jsonl'), JSON.stringify({ stage }) + '\n');
    if (mode === 'receipt-loss') return { invalid: undefined } as never;
    if (stage === 'admit' && mode === 'hold') {
      process.send?.({ type: 'effect' });
      await new Promise<void>(resolve => process.once('message', () => resolve()));
    }
    return { confirmed: stage };
  },
});
process.send?.({ type: 'result', result });
process.disconnect?.();
