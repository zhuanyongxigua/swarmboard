// AI chooses labels and fact references; the server owns values, identity and
// freshness. This read path never schedules model work or publishes wake events.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, parse, type Store } from './store.js';
import { processAlive } from './worker-store.js';
import { aggregateStatusFacts, modelFactKey, statusGroupKey, type StoredStatusFact } from './overview-status-facts.js';

const explanation = z.string().min(1).max(240).refine(value => !/[\p{N}\p{Cc}\p{Cf}]/u.test(value), 'Use verified fact references for numeric values; explanation cannot contain numbers or control characters');
export const overviewPartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: explanation }).strict(),
  z.object({ kind: z.literal('fact'), factId: z.string().min(1).max(100) }).strict(),
]);
export const overviewWriteSchema = z.object({
  expectedVersion: z.number().int().nonnegative(), factsRevision: z.string().regex(/^[a-f0-9]{64}$/),
  preferencesVersion: z.number().int().nonnegative(), userPromptVersion: z.number().int().nonnegative().default(0),
  ttlSeconds: z.number().int().min(1).max(900).default(300),
  parts: z.array(overviewPartSchema).max(30), agentId: z.string().min(1).max(128).optional(),
}).strict();
export type OverviewPart = z.infer<typeof overviewPartSchema>;
export interface OverviewRecord {
  boardId: string; version: number; authorId: string; updatedAt: string; expiresAt: string;
  preferencesVersion: number; factsRevision: string; parts: OverviewPart[];
  /** Legacy records predate the independent user prompt and imply revision zero. */
  userPromptVersion?: number;
  /** Server-verified referenced values at write time. Older records omit this
   *  field; readers must not reconstruct their historical values from live facts. */
  factSnapshot?: OverviewFact[];
}
export interface OverviewSource {
  owner?: unknown;
  ownerEpoch?: string | null;
  pool?: { id?: string; enabled?: boolean; version?: number } | null;
  workers?: { id: string; poolId?: string; backendId?: string; threadId?: string | null; enabled: boolean; status: string;
    turnId?: string | null; deliveryPhase?: string; retirement?: { state: string } }[];
  collaborators?: { id: string; harness: string; sessionRef: string; enabled: boolean; revokedAt: string | null }[];
  statusFacts?: StoredStatusFact[];
}
export interface OverviewFact { id: string; kind: 'count' | 'state' | 'model'; value: number | string | null; source: string; scope: string }
export interface OverviewFacts { revision: string; observedAt: string; available: boolean; items: OverviewFact[] }
export interface OverviewView { status: 'missing' | 'current' | 'stale' | 'unavailable'; reason: string | null; record: OverviewRecord | null; facts: OverviewFacts }

export function overviewFacts(source?: OverviewSource, now = Date.now()): OverviewFacts {
  const workers = (source?.workers ?? []).filter(w => w.retirement?.state !== 'retired' && (!source?.pool?.id || w.poolId === source.pool.id));
  const groups = new Map<string, typeof workers>();
  for (const w of workers) {
    const key = JSON.stringify([w.backendId ?? 'codex', w.threadId || w.id]);
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  // Duplicate bindings count once; conflicting delivery checkpoints remain
  // uncertain rather than choosing a convenient active state.
  const unique = [...groups.values()].map(rows => {
    const first = rows[0]!;
    return rows.every(w => w.status === first.status && w.enabled === first.enabled && w.turnId === first.turnId && w.deliveryPhase === first.deliveryPhase)
      ? first : { ...first, status: 'uncertain', turnId: null };
  });
  const externals = new Map<string, NonNullable<OverviewSource['collaborators']>[number]>();
  for (const c of source?.collaborators ?? []) if (c.enabled && !c.revokedAt) externals.set(JSON.stringify([c.harness, c.sessionRef || c.id]), c);
  const owner = source?.owner as { pid?: unknown } | null | undefined;
  const ownerPid = typeof owner?.pid === 'number' ? owner.pid : null;
  const ownerAlive = ownerPid !== null && processAlive(ownerPid);
  const items: OverviewFact[] = [];
  const count = (id: string, value: number | null, scope: string, evidence: string) => items.push({ id, kind: 'count', value, source: evidence, scope });
  const native = 'Non-retired native registrations, including unopened bindings; duplicate backend/session bindings counted once';
  count('native.members', source?.workers ? unique.length : null, native, 'runtime.workers');
  count('native.running', ownerAlive ? unique.filter(w => w.status === 'running' && w.deliveryPhase === 'running' && w.turnId).length : null,
    'Recorded running delivery with a turn id and live runtime owner, including draining in-flight work; opening/submitting/uncertain excluded', 'runtime.owner + runtime.workers.delivery');
  for (const status of ['idle', 'error', 'uncertain'] as const) count(`native.${status === 'error' ? 'errors' : status}`,
    source?.workers ? unique.filter(w => w.status === status).length : null, 'Recorded native checkpoint state; does not prove model activity', 'runtime.workers.status');
  count('native.draining', source?.workers ? unique.filter(w => w.retirement?.state === 'draining').length : null, 'Draining bindings may still have in-flight work', 'runtime.workers.retirement');
  count('external.admitted', source?.collaborators ? externals.size : null, 'Enabled non-revoked admissions, deduplicated by harness/session; not active participants', 'runtime.collaborators.admission');
  count('external.sessions', source?.collaborators ? [...externals.values()].filter(c => c.sessionRef).length : null, 'Distinct admitted nonempty harness/session references; not proof of a live process', 'runtime.collaborators.sessionRef');
  // Registered seat facts are a separate evidence channel: members push verified
  // envelopes through the formal boundary, so these counts never fall back to
  // the admission store's silence. Without registrations the honest value for
  // activity stays unknown (null), not zero.
  const status = source?.statusFacts !== undefined ? aggregateStatusFacts(source.statusFacts, now) : null;
  count('external.running', status && status.registered > 0 ? status.executing : null,
    status ? 'Registered seats currently executing with execution evidence; unregistered external seats are not covered by this count' : 'Current external activity is not reported by the admission store',
    status ? 'overview_status_facts registrations' : 'unavailable');
  count('external.status.registered', status ? status.registered : null, 'Self-registered seat status envelopes across harness groups; registration is not proof of health', 'overview_status_facts registrations');
  const nativeTotal = source?.workers ? unique.length : null;
  const admittedTotal = source?.collaborators ? externals.size : null;
  count('organization.total', nativeTotal !== null && admittedTotal !== null ? nativeTotal + admittedTotal : null,
    'Non-retired native bindings plus admitted external collaborators, both deduplicated; membership evidence, not executing activity',
    nativeTotal !== null && admittedTotal !== null ? 'runtime.workers + runtime.collaborators.admission' : 'unavailable');
  // Admissions include historical seats. A separate fact counts only the
  // externally reported cohort, without changing the legacy admission total.
  const nativeIds = new Set(workers.map(w => w.id));
  const admissions = new Map((source?.collaborators ?? []).filter(c => c.enabled && !c.revokedAt && !nativeIds.has(c.id)).map(c => [c.id, c]));
  const reported = (source?.statusFacts ?? []).filter(row => admissions.has(row.memberId) && !nativeIds.has(row.memberId));
  const reportedBindings = new Set(reported.map(row => {
    const admitted = admissions.get(row.memberId)!;
    return JSON.stringify([admitted.harness, admitted.sessionRef || admitted.id]);
  }));
  const reportedSummary = aggregateStatusFacts(reported, now);
  const reportsCertain = Object.values(reportedSummary.groups).every(g => g.unknown === 0 && g.stale === 0);
  const hasCoverage = source?.collaborators !== undefined
    && (admissions.size === 0 || (source.statusFacts !== undefined && reported.length > 0));
  count('organization.observed-members', nativeTotal !== null && hasCoverage && reportsCertain ? nativeTotal + reportedBindings.size : null,
    'Non-retired native bindings plus current fact-classified external reports with active admissions; deduplicated by identity and harness/session. Unreported admissions excluded; this is the observed cohort, not a complete census or proof of health. Any unknown or stale report makes this total unknown',
    'runtime.workers + overview_status_facts + runtime.collaborators.admission');
  for (const group of ['native', 'external']) items.push({ id: `${group}.model`, kind: 'model', value: null, source: 'unavailable', scope: 'Harness labels and admission metadata are not actual model evidence' });
  if (status) {
    const groups = Object.entries(status.groups).sort(([a], [b]) => (a < b ? -1 : 1));
    let truncated = false;
    for (const [harness, g] of groups.slice(0, 12)) {
      const key = `external.harness.${statusGroupKey(harness)}`;
      count(`${key}.members`, g.membersTotal, 'Registered seats in this harness group; other seats may exist unregistered', 'overview_status_facts');
      count(`${key}.executing`, g.executing, 'Current fact-classified executing registrations with execution evidence', 'overview_status_facts');
      count(`${key}.turn-settled`, g.turnSettled, 'Registrations with a settled ledger only; not proof of member health', 'overview_status_facts');
      count(`${key}.failed`, g.failed, 'Registrations whose current-turn terminal is a failure bound to the submitted sequence', 'overview_status_facts');
      count(`${key}.unknown`, g.unknown, 'Registrations whose execution is unconfirmed or fields inconsistent; never counted as executing', 'overview_status_facts');
      count(`${key}.stale`, g.stale, 'Registrations past their expiry, retained as last-recorded values; not current activity', 'overview_status_facts');
      count(`${key}.models-unknown`, g.modelsUnknown, 'Current fact-classified registrations without a model identity; never fabricated', 'overview_status_facts');
      const models = g.models.sort((a, b) => (a.modelId < b.modelId ? -1 : 1)).slice(0, 8);
      truncated = truncated || g.models.length > 8;
      for (const m of models) {
        const modelKey = modelFactKey(m.modelId);
        items.push({ id: `${key}.model.${modelKey}`, kind: 'model', value: m.count, source: 'overview_status_facts', scope: `Registered seats reporting this model; currently executing: ${m.executing}` });
        // Verified model identities may contain digits (GLM-5.3, GPT-6.1), which
        // explanation text may not carry: this identity fact is the one legal way
        // to display the name, keeping the numeric-text restriction intact.
        items.push({ id: `${key}.model-name.${modelKey}`, kind: 'model', value: m.modelId, source: 'overview_status_facts', scope: 'Verified model identity from current registrations; reference this fact to display the name' });
      }
    }
    if (groups.length > 12) truncated = true;
    if (truncated) items.push({ id: 'external.status.limits', kind: 'state', value: 'truncated', source: 'overview_status_facts', scope: 'Only the first harness groups and models are listed; unlisted registrations still count in external.running' });
  }
  // Observed time and collaborator cursor/updatedAt are deliberately absent
  // from the fingerprint: reading shared events is not new activity evidence.
  const identity = { ownerPid, ownerAlive, ownerEpoch: source?.ownerEpoch ?? null, pool: source?.pool ?? null,
    workers: workers.map(w => [w.id, w.backendId ?? 'codex', w.threadId, w.enabled, w.status, w.turnId, w.deliveryPhase, w.retirement?.state]).sort(),
    collaborators: (source?.collaborators ?? []).map(c => [c.id, c.harness, c.sessionRef, c.enabled, c.revokedAt]).sort(), items,
    statusFacts: status ? status.fingerprint : null };
  return { revision: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), observedAt: new Date(now).toISOString(), available: source !== undefined, items };
}

export function readOverview(store: Store, source?: OverviewSource, now = Date.now()): OverviewView {
  const { record, ...prompts } = store.readOverviewSnapshot(), facts = overviewFacts(source, now);
  let status: OverviewView['status'] = 'current', reason: string | null = null;
  if (!record?.parts.length) { status = 'missing'; reason = 'NO_OVERVIEW'; }
  else if (!facts.available) { status = 'unavailable'; reason = 'RUNTIME_UNAVAILABLE'; }
  else if (record.factsRevision !== facts.revision) { status = 'stale'; reason = 'FACTS_CHANGED'; }
  else if (record.preferencesVersion !== prompts.systemPrompt.version) { status = 'stale'; reason = 'PREFERENCES_CHANGED'; }
  else if ((record.userPromptVersion ?? 0) !== prompts.userPrompt.version) { status = 'stale'; reason = 'USER_PROMPT_CHANGED'; }
  else if (Date.parse(record.expiresAt) <= now) { status = 'stale'; reason = 'EXPIRED'; }
  return { status, reason, record, facts };
}

export function writeOverview(store: Store, input: unknown, authorId: string, source?: OverviewSource, now = Date.now()): OverviewView {
  const data = parse(overviewWriteSchema, input), facts = overviewFacts(source, now);
  if (!facts.available) throw new AppError('RUNTIME_UNAVAILABLE', 'Current runtime facts are unavailable', 409);
  if (data.factsRevision !== facts.revision) throw new AppError('OVERVIEW_FACTS_CHANGED', 'Runtime facts changed; read overview_read again', 409);
  for (const part of data.parts) if (part.kind === 'fact' && !facts.items.some(f => f.id === part.factId)) throw new AppError('INVALID_FACT', 'Choose a fact from overview_read', 400);
  const referenced = new Set(data.parts.flatMap(part => part.kind === 'fact' ? [part.factId] : []));
  store.saveOverviewRecord({ boardId: store.readPreferences().boardId, authorId, updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + data.ttlSeconds * 1000).toISOString(), preferencesVersion: data.preferencesVersion,
    userPromptVersion: data.userPromptVersion, factsRevision: facts.revision, parts: data.parts,
    factSnapshot: facts.items.filter(fact => referenced.has(fact.id)) }, data.expectedVersion);
  return readOverview(store, source, now);
}
