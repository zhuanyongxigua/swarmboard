// Harness-agnostic member status facts, registered by external seats through
// the formal MCP boundary (members push verified records; core never scans
// personal paths or vendor logs). Aggregation keeps known numbers when other
// groups are unknown and never promotes unknown, expired or stale-evidence
// registrations into executing counts. Activity vocabulary follows the
// member-status-fact v2 contract: "turn-settled" proves only a settled ledger,
// not health, and "executing" requires execution evidence whose timestamps sit
// inside the claimed freshness window.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, parse, type Store } from './store.js';

const shortText = (max: number) => z.string().min(1).max(max).refine(value => !value.includes('\0'), 'No NUL characters');
// Registrations are identity-unique: one row per member, with the harness
// label as updatable metadata. Duplicate identities must never count twice.
const CLOCK_SKEW_MS = 60_000;
// Hard aggregation bound: executing evidence older than an hour never counts
// as current, even if some writer bypassed the registration window checks.
const EVIDENCE_HARD_BOUND_MS = 3_600_000;

export const statusFactInputSchema = z.object({
  harness: shortText(160),
  classification: z.enum(['fact', 'unknown']),
  activity: z.enum(['executing', 'turn-settled', 'failed']).optional(),
  modelId: z.string().min(1).max(160).nullable(),
  reasoningLevel: z.string().min(1).max(64).nullable().optional(),
  executionEvidence: z.object({ kind: shortText(64), at: z.string().datetime(), ref: shortText(160).optional() }).strict().optional(),
  evidence: z.object({ source: shortText(200), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().optional(),
  asOf: z.string().datetime(),
  ttlSeconds: z.number().int().min(1).max(900),
}).strict().superRefine((value, ctx) => {
  if (value.classification === 'unknown' && value.activity !== undefined)
    ctx.addIssue({ code: 'custom', message: 'Unknown classifications carry no activity' });
  if (value.activity !== undefined && value.classification !== 'fact')
    ctx.addIssue({ code: 'custom', message: 'Activity requires a fact classification' });
  if (value.activity === 'executing' && !value.executionEvidence)
    ctx.addIssue({ code: 'custom', message: 'Executing requires execution evidence' });
});

export interface StoredStatusFact {
  memberId: string; harness: string; classification: 'fact' | 'unknown';
  activity?: 'executing' | 'turn-settled' | 'failed';
  modelId: string | null; reasoningLevel?: string | null;
  executionEvidence?: { kind: string; at: string; ref?: string };
  evidence?: { source: string; sha256?: string };
  asOf: string; observedAt: string; expiresAt: string;
}

export interface StatusFactsGroup {
  membersTotal: number; executing: number; turnSettled: number; failed: number;
  unknown: number; stale: number; modelsUnknown: number;
  models: { modelId: string; count: number; executing: number }[];
}
export interface StatusFactsSummary {
  groups: Record<string, StatusFactsGroup>;
  registered: number; executing: number;
  /** Stable fingerprint over the stored rows; feeds the overview fact revision
   * so status changes mark existing overviews stale instead of showing numbers
   * that no longer hold. */
  fingerprint: string;
}

const ACTIVITIES = ['executing', 'turn-settled', 'failed'] as const;

export function aggregateStatusFacts(rows: StoredStatusFact[], now: number): StatusFactsSummary {
  // Harness labels are free-form data; group containers must never let a label
  // reach an object prototype. Internal bookkeeping uses a Map and the result
  // is built with own properties only.
  const groups = new Map<string, StatusFactsGroup & { models: { modelId: string; count: number; executing: number }[] }>();
  let executing = 0;
  for (const row of [...rows].sort((a, b) => (a.memberId < b.memberId ? -1 : 1))) {
    let group = groups.get(row.harness);
    if (group === undefined) {
      group = { membersTotal: 0, executing: 0, turnSettled: 0, failed: 0, unknown: 0, stale: 0, modelsUnknown: 0, models: [] };
      groups.set(row.harness, group);
    }
    group.membersTotal++;
    const expiresAt = Date.parse(row.expiresAt);
    const stale = Number.isFinite(expiresAt) && expiresAt <= now;
    if (row.classification !== 'fact' || stale) {
      if (stale) group.stale++; else group.unknown++;
      continue;
    }
    const evidenceAt = row.activity === 'executing' && row.executionEvidence ? Date.parse(row.executionEvidence.at) : null;
    const evidenceCurrent = row.activity === 'executing'
      ? evidenceAt !== null && Number.isFinite(evidenceAt) && evidenceAt <= now + CLOCK_SKEW_MS && now - evidenceAt <= EVIDENCE_HARD_BOUND_MS
      : true;
    const activity = evidenceCurrent && row.activity !== undefined && (ACTIVITIES as readonly string[]).includes(row.activity) ? row.activity : null;
    if (activity === null) { group.unknown++; continue; }
    if (activity === 'executing') { group.executing++; executing++; }
    else if (activity === 'turn-settled') group.turnSettled++;
    else group.failed++;
    if (typeof row.modelId === 'string' && row.modelId.length > 0) {
      const model = group.models.find(m => m.modelId === row.modelId) ?? { modelId: row.modelId, count: 0, executing: 0 };
      model.count++;
      if (activity === 'executing') model.executing++;
      if (!group.models.includes(model)) group.models.push(model);
    } else group.modelsUnknown++;
  }
  const canonical = rows.map(row => [row.memberId, row.harness, row.classification, row.activity ?? null, row.modelId, row.observedAt, row.expiresAt]).sort();
  return { groups: Object.fromEntries(groups) as Record<string, StatusFactsGroup>, registered: rows.length, executing,
    fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}

/** factId-safe group key: groups are data-driven, never a vendor list. */
export function statusGroupKey(harness: string): string {
  return harness.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group';
}

export function registerStatusFact(store: Store, input: unknown, memberId: string, now = Date.now()): StoredStatusFact {
  const data = parse(statusFactInputSchema, input);
  // The claimed fact time and any execution evidence must sit inside the
  // freshness window the member asks for: a TTL cannot resurrect an old fact,
  // future claims are rejected up to clock skew, and execution evidence cannot
  // predate the claimed fact time.
  const asOfAt = Date.parse(data.asOf);
  const windowStart = now - data.ttlSeconds * 1000 - CLOCK_SKEW_MS;
  if (!Number.isFinite(asOfAt) || asOfAt < windowStart || asOfAt > now + CLOCK_SKEW_MS)
    throw new AppError('STATUS_FACT_STALE_AS_OF', 'asOf must fall inside the requested freshness window', 400);
  if (data.executionEvidence !== undefined) {
    const evidenceAt = Date.parse(data.executionEvidence.at);
    if (!Number.isFinite(evidenceAt) || evidenceAt < windowStart || evidenceAt > now + CLOCK_SKEW_MS)
      throw new AppError('STATUS_FACT_EVIDENCE_OUT_OF_WINDOW', 'execution evidence must fall inside the requested freshness window', 400);
    if (evidenceAt < asOfAt)
      throw new AppError('STATUS_FACT_EVIDENCE_PREDATES_AS_OF', 'execution evidence cannot predate the claimed fact time', 400);
  }
  const stored: StoredStatusFact = { memberId, ...data,
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + data.ttlSeconds * 1000).toISOString() };
  delete (stored as { ttlSeconds?: number }).ttlSeconds;
  store.saveOverviewStatusFact(stored);
  return stored;
}
