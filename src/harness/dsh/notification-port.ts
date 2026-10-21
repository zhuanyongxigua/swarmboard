// Adapt the caller-bound public MCP tools to whole driver batches. The host
// supplies current authority; this module never opens a board database or timer.
import { isSessionTaskCheck, readSessionTaskCheck } from '../../notification-adapters.js';
import type { Entry } from '../../store.js';
import type { DeliveryBatch, PendingCheck, PendingPort } from './notification-driver.js';

export interface DshNotificationBinding {
  adapterId: string;
  memberId: string;
  sessionRef: string;
  registrationVersion: number;
  taskIds: readonly string[];
  enabled: boolean;
  boardWide?: boolean;
}

/** Already authenticated and bound to this member by the trusted host. */
export type DshNotificationToolCall = (request: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
export interface DshNotificationPortOptions {
  callTool: DshNotificationToolCall;
  /** Fresh host authority, not event text or a once-loaded model preference. */
  getCurrentBinding(): DshNotificationBinding | undefined | Promise<DshNotificationBinding | undefined>;
  pageSize?: number;
}
export interface DshNotificationBatch extends DeliveryBatch {
  /** Serializable provenance survives the driver journal and delta spreads. */
  notificationBinding: DshNotificationBinding;
}
export interface DshNotificationPort extends PendingPort {
  isCurrent(batch: DeliveryBatch): Promise<boolean>;
}

type RecordValue = Record<string, unknown>;
type PendingItem = { adapterId: string; memberId: string; sequence: number; entryIds: number[]; state: 'pending' | 'unknown' };
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
function fail(code: string): never { throw new Error(code); }
function ids(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 200
    && value.every(id => integer(id, 1)) && new Set(value).size === value.length;
}
function validBinding(value: unknown): value is DshNotificationBinding {
  return record(value) && nonEmpty(value.adapterId) && nonEmpty(value.memberId) && nonEmpty(value.sessionRef)
    && integer(value.registrationVersion, 1) && typeof value.enabled === 'boolean'
    && Array.isArray(value.taskIds) && value.taskIds.every(nonEmpty) && new Set(value.taskIds).size === value.taskIds.length
    && (value.boardWide === undefined || typeof value.boardWide === 'boolean');
}
function sameBinding(left: DshNotificationBinding, right: DshNotificationBinding): boolean {
  return left.enabled && right.enabled && left.adapterId === right.adapterId && left.memberId === right.memberId
    && left.sessionRef === right.sessionRef && left.registrationVersion === right.registrationVersion
    && !!left.boardWide === !!right.boardWide && left.taskIds.length === right.taskIds.length
    && left.taskIds.every(id => right.taskIds.includes(id));
}

function payload(response: unknown): RecordValue {
  if (!record(response)) return fail('INVALID_NOTIFICATION_RESPONSE');
  let value: unknown = response.structuredContent;
  if (value === undefined && Array.isArray(response.content)) {
    // Only the first RPC text is the result. Later peer-update attachments are reference data.
    const first = response.content.find(part => record(part) && part.type === 'text');
    if (record(first) && typeof first.text === 'string') {
      try { value = JSON.parse(first.text); } catch {
        // MCP converts thrown tool errors to plain text, including the public
        // service code. Keep that code without copying arbitrary response bodies.
        return fail(response.isError === true ? first.text.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0] ?? 'NOTIFICATION_TOOL_ERROR'
          : 'INVALID_NOTIFICATION_RESPONSE');
      }
    }
  }
  if (response.isError === true || record(value) && value.error !== undefined) {
    const error = record(value) && record(value.error) ? value.error : undefined;
    return fail(nonEmpty(error?.code) ? error.code : nonEmpty(error?.message) ? error.message : 'NOTIFICATION_TOOL_ERROR');
  }
  return record(value) ? value : fail('INVALID_NOTIFICATION_RESPONSE');
}

export function createDshNotificationPort(options: DshNotificationPortOptions): DshNotificationPort {
  const pageSize = options.pageSize ?? 50;
  if (!integer(pageSize, 1) || pageSize > 200) fail('INVALID_NOTIFICATION_PAGE_SIZE');
  const call = async (name: string, args: Record<string, unknown>) => payload(await options.callTool({ name, arguments: args }));
  const binding = async () => {
    const current = await options.getCurrentBinding();
    if (!validBinding(current) || !current.enabled) return fail('STALE_NOTIFICATION_BINDING');
    return { ...current, taskIds: [...current.taskIds] };
  };
  const pending = async (bound: DshNotificationBinding): Promise<PendingItem[]> => {
    const all: PendingItem[] = [];
    let after = 0;
    for (;;) {
      const page = await call('notification_pending', { after, limit: pageSize });
      if (!Array.isArray(page.items) || page.items.length > pageSize || !integer(page.cursor, after)
        || typeof page.hasMore !== 'boolean') fail('INVALID_NOTIFICATION_RESPONSE');
      for (const item of page.items as unknown[]) {
        if (!record(item) || !nonEmpty(item.adapterId) || !nonEmpty(item.memberId) || !integer(item.sequence, after + 1)
          || !ids(item.entryIds) || !['pending', 'unknown'].includes(String(item.state))) fail('INVALID_NOTIFICATION_RESPONSE');
        if (item.adapterId !== bound.adapterId || item.memberId !== bound.memberId) fail('AMBIGUOUS_NOTIFICATION_BINDING');
        if (item.sequence <= (all.at(-1)?.sequence ?? after)) fail('INVALID_NOTIFICATION_RESPONSE');
        if (item.state === 'unknown') fail('UNKNOWN_DELIVERY: preserve the service record and reconcile before driving');
        all.push(item as PendingItem);
      }
      const last = all.at(-1)?.sequence ?? after;
      if (page.cursor < last || page.hasMore && (page.items.length === 0 || page.cursor !== last || page.cursor <= after))
        fail('INVALID_NOTIFICATION_RESPONSE');
      if (!page.hasMore) return all;
      after = page.cursor;
    }
  };
  const readEntry = async (id: number, bound: DshNotificationBinding): Promise<Entry> => {
    // context_read is full text, unlike compact board snapshots. An exact seek
    // also catches filtered/missing ids instead of silently taking the next visible row.
    const page = await call('context_read', { after: id - 1, limit: 1 });
    const entry = Array.isArray(page.items) && page.items.length === 1 ? page.items[0] : undefined;
    if (!record(entry) || entry.id !== id || !nonEmpty(entry.kind) || !nonEmpty(entry.agentId)
      || typeof entry.summary !== 'string' || typeof entry.detail !== 'string'
      || entry.detailTruncated === true) return fail('INCOMPLETE_CONTEXT');
    if (entry.recipientId !== undefined && entry.recipientId !== bound.memberId
      || entry.taskId !== undefined && !bound.taskIds.includes(String(entry.taskId))) return fail('STALE_NOTIFICATION_BINDING');
    return entry as unknown as Entry;
  };
  const checkEntries = (entries: readonly Entry[], bound: DshNotificationBinding): PendingCheck | undefined => {
    let first: PendingCheck | undefined;
    for (const entry of entries) {
      if (!isSessionTaskCheck(entry)) continue;
      const check = readSessionTaskCheck(entry);
      if (!check || check.memberId !== bound.memberId || check.sessionRef !== bound.sessionRef
        || check.adapterId !== bound.adapterId || check.registrationVersion !== bound.registrationVersion
        || !check.goalIds.some(id => bound.taskIds.includes(id))) fail('STALE_NOTIFICATION_BINDING');
      first ??= check;
    }
    return first;
  };
  const boundBatch = async (batch: DeliveryBatch): Promise<DshNotificationBinding> => {
    const current = await binding();
    const prior = (batch as Partial<DshNotificationBatch>).notificationBinding;
    if (!validBinding(prior) || !sameBinding(prior, current) || batch.adapterId !== current.adapterId
      || batch.memberId !== current.memberId || batch.sessionRef !== current.sessionRef) fail('STALE_NOTIFICATION_BINDING');
    if (!integer(batch.delivery.sequence, 1) || !ids(batch.delivery.entryIds) || batch.entries.length !== batch.delivery.entryIds.length
      || batch.entries.some((entry, index) => entry.id !== batch.delivery.entryIds[index])) fail('INVALID_NOTIFICATION_BATCH');
    return current;
  };
  return {
    async list(): Promise<DshNotificationBatch[]> {
      const bound = await binding();
      const result: DshNotificationBatch[] = [];
      for (const item of await pending(bound)) {
        const entries: Entry[] = [];
        for (const id of item.entryIds) entries.push(await readEntry(id, bound));
        const check = checkEntries(entries, bound);
        result.push({ adapterId: bound.adapterId, memberId: bound.memberId, sessionRef: bound.sessionRef,
          notificationBinding: bound, delivery: { sequence: item.sequence, entryIds: [...item.entryIds] }, entries, ...(check ? { check } : {}) });
      }
      if (!sameBinding(bound, await binding())) fail('STALE_NOTIFICATION_BINDING');
      return result;
    },
    async isCurrent(batch) {
      try {
        const bound = await boundBatch(batch);
        const item = (await pending(bound)).find(item => item.sequence === batch.delivery.sequence);
        if (!item || !batch.delivery.entryIds.every(id => item.entryIds.includes(id))) return false;
        const entries: Entry[] = [];
        for (const id of batch.delivery.entryIds) entries.push(await readEntry(id, bound));
        checkEntries(entries, bound);
        return sameBinding(bound, await binding());
      } catch { return false; }
    },
    async confirm(batch) {
      await boundBatch(batch);
      const receipt = await call('notification_receipt', { sequence: batch.delivery.sequence, consumed: true, entryIds: [...batch.delivery.entryIds] });
      if (receipt.sequence !== batch.delivery.sequence || receipt.consumed !== true || !ids(receipt.entryIds)
        || receipt.entryIds.length !== batch.delivery.entryIds.length || !receipt.entryIds.every(id => batch.delivery.entryIds.includes(id)))
        fail('INVALID_NOTIFICATION_RECEIPT');
    },
    async release() {
      // Local deferral is not a negative receipt (which would freeze the service
      // as unknown), and never an operator abandonment or evidence deletion.
    },
  };
}

export { payload as notificationPayload };
