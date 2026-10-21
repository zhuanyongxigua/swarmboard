// Keep operator choices explicit and separate from task content and model tools.
// This schema carries no credential values and supplies no personal model policy.
import path from 'node:path';
import { z } from 'zod';
const text = z.string().min(1).max(4096).refine(value => value === value.trim() && !value.includes('\0'));
const absolute = text.refine(value => path.isAbsolute(value) && path.resolve(value) === value);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const selected = z.object({ sessionRef: text, cwd: absolute, persistenceRoot: absolute }).strict();
export const dshLaunchConfigSchema = z.object({
  schema: z.literal('swarmboard-dsh-launch/v1'),
  cohortKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  count: z.number().int().positive(),
  stateDirectory: absolute, workspaceRoot: absolute, runtimeRoot: absolute,
  poolId: text, taskIds: z.array(text).min(1).max(50).refine(ids => new Set(ids).size === ids.length),
  boardDatabasePath: absolute, nodeCommand: absolute,
  server: z.object({ path: absolute, sha256: sha }).strict(),
  sdk: z.object({ root: absolute, pins: z.object({ cordis: sha, 'dsh-session': sha,
    'dsh-session-persistence-jsonl': sha, 'dsh-agent': sha, 'dsh-llm': sha }).strict() }).strict(),
  cli: z.object({ path: absolute, sha256: sha, profile: text }).strict(),
  model: z.object({ provider: text, model: text, reasoningEffort: text }).strict(),
  /** Existing official provider row configuration; use credential environment names, never values. */
  providerConfiguration: z.object({ entryId: text, config: z.record(z.string(), z.json()) }).strict(),
  permissionPreset: text,
  sessions: z.discriminatedUnion('mode', [z.object({ mode: z.literal('create') }).strict(),
    z.object({ mode: z.literal('select'), seats: z.array(selected).min(1) }).strict()]),
}).strict().superRefine((value, ctx) => {
  if (value.sessions.mode === 'select' && (value.sessions.seats.length !== value.count
    || new Set(value.sessions.seats.map(seat => seat.sessionRef)).size !== value.count)) {
    ctx.addIssue({ code: 'custom', message: 'Select one distinct real session per seat.' });
  }
  const roots = [value.stateDirectory, value.workspaceRoot, value.runtimeRoot];
  if (roots.some((root, index) => roots.some((other, j) => index !== j && within(root, other)))) {
    ctx.addIssue({ code: 'custom', message: 'State, workspace and runtime roots must be disjoint.' });
  }
});
export type DshLaunchConfig = z.infer<typeof dshLaunchConfigSchema>;
export function parseDshLaunchConfig(value: unknown): DshLaunchConfig { return dshLaunchConfigSchema.parse(value); }
function within(root: string, file: string) {
  const delta = path.relative(root, file);
  return delta === '' || (!path.isAbsolute(delta) && delta !== '..' && !delta.startsWith('..' + path.sep));
}
/** Runtime snapshots are evidence for this immediate operation only, never a stored grant. */
export function assertDshLaunchAuthority(config: DshLaunchConfig, value: Record<string, unknown>): void {
  const pool = value.pool as { id?: string; enabled?: boolean; taskIds?: string[]; state?: string } | undefined;
  const grants = value.executionGrants as Array<{ taskId: string; poolId: string; enabled: boolean; monitoring: boolean;
    externalHarnesses: string[]; version: number; executionWorkspace: string }> | undefined;
  if (pool?.id !== config.poolId || pool.enabled !== true || !Array.isArray(pool.taskIds)
    || ['stopping', 'stopped', 'completed', 'error'].includes(pool.state ?? '')
    || config.taskIds.some(id => pool.taskIds!.length > 0 && !pool.taskIds!.includes(id)) || !Array.isArray(grants)) {
    throw new Error('DSH_LAUNCH_AUTHORITY_REQUIRED');
  }
  const admitted = config.taskIds.map(taskId => grants.find(grant => grant.taskId === taskId && grant.poolId === config.poolId
    && grant.enabled && grant.monitoring && grant.externalHarnesses.includes('dsh') && Number.isSafeInteger(grant.version) && grant.version > 0));
  if (admitted.some(grant => !grant)) throw new Error('DSH_LAUNCH_AUTHORITY_REQUIRED');
  const targets = [config.stateDirectory, config.workspaceRoot, config.runtimeRoot,
    ...(config.sessions.mode === 'select' ? config.sessions.seats.flatMap(seat => [seat.cwd, seat.persistenceRoot]) : [])];
  if (targets.some(target => !admitted.some(grant => grant && within(grant.executionWorkspace, target)))) {
    throw new Error('DSH_LAUNCH_WORKSPACE_OUTSIDE_GRANT');
  }
}
