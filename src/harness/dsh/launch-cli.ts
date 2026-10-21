#!/usr/bin/env node
// Ship one operator entry instead of requiring hand-built per-seat startup scripts.
// Default status reads are local; only an explicit --run invokes the control plane.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDshCohortOperator } from './cohort-operator.js';
import { parseDshLaunchConfig } from './cohort-config.js';
import { readDshChildStatus } from './launch-child.js';
import type { DshCohortStatus, DshLaunchRecord } from './cohort.js';

export function summarizeDshCohort(status: DshCohortStatus, stateDirectory: string) {
  return { cohortKey: status.cohortKey, busy: status.busy, claimPresent: status.claimPresent,
    seats: status.seats.map(seat => {
      let child = { phase: 'not-started', startupReady: false };
      if (seat.receipts.stage) {
        try {
          const stage = seat.receipts.stage;
          const pins = stage.pins as DshLaunchRecord[];
          const configPin = pins.find(pin => pin.path === stage.configPath);
          if (configPin) child = readDshChildStatus({ stageDirectory: path.join(stateDirectory, seat.key),
            configSha256: String(configPin.sha256), sessionRef: seat.sessionRef });
        } catch { child = { phase: 'unknown', startupReady: false }; }
      }
      return { key: seat.key, memberId: seat.receipts.admit?.id ?? null, sessionRef: seat.sessionRef || null,
        operatorPhase: seat.phase, nextStep: ['failed', 'unknown'].includes(child.phase)
          ? 'Reconcile the retained child state, lifecycle and delivery journals; do not relaunch or clear ownership.' : seat.nextStep,
        sessionPrepared: !!seat.receipts.session, bound: !!seat.receipts.bind, registered: !!seat.receipts.register,
        spawnedPid: seat.receipts.launch?.pid ?? null, startupReady: child.startupReady,
        healthPhase: child.phase, notificationConsumption: 'unverified', usefulContribution: 'unverified' };
    }) };
}
export async function runDshLaunchCli(args: string[]): Promise<{ exitCode: number; output: unknown }> {
  if (args.length === 1 && args[0] === '--help') return { exitCode: 0,
    output: { usage: 'node server/harness/dsh/launch.mjs --config /absolute/private/cohort.json [--status|--run]',
      default: 'Local status only. --run performs explicitly configured startup once per durable stage.' } };
  const at = args.indexOf('--config');
  if (at < 0 || !args[at + 1] || args.filter(value => value === '--config').length !== 1
    || args.some((value, index) => index !== at + 1 && !['--config', '--status', '--run'].includes(value))
    || args.includes('--run') && args.includes('--status')) throw new Error('DSH_LAUNCH_USAGE');
  const file = args[at + 1];
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('DSH_LAUNCH_CONFIG_FILE_REQUIRED');
  const config = parseDshLaunchConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  const operator = createDshCohortOperator({ config, childEntry: fileURLToPath(new URL('./child.mjs', import.meta.url)) });
  try {
    const status = args.includes('--run') ? await operator.run() : operator.inspect();
    return { exitCode: status.seats.some(seat => ['preflight-blocked', 'reconcile-required'].includes(seat.phase)) ? 2 : 0,
      output: summarizeDshCohort(status, config.stateDirectory) };
  } finally { await operator.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await runDshLaunchCli(process.argv.slice(2)); console.log(JSON.stringify(result.output, null, 2)); process.exitCode = result.exitCode; }
  catch { console.error(JSON.stringify({ error: 'DSH_LAUNCH_REJECTED', nextStep: 'Check the documented trusted configuration and retained cohort state; do not delete or replay unknown operations.' })); process.exitCode = 1; }
}
