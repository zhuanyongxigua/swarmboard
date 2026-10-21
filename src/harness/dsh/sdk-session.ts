// Drive only an already bound official DSH agent, and tie completion to this
// delivery's identified user message rather than a global idle observation.
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { DshAgent } from './lifecycle.js';

export interface DshSdkBatch {
  adapterId?: string;
  memberId: string;
  sessionRef: string;
  delivery: { sequence: number; entryIds: readonly number[] };
  entries: readonly { id: number; kind: string; summary: string; detail?: string | null }[];
  check?: { memberId: string; sessionRef: string; dueAt: number; goalIds: readonly string[];
    adapterId?: string; registrationVersion?: number };
}
export interface DshSdkEvent { type: string; seq: number; data: unknown }
export interface DshSdkUserMessage<I extends string> {
  id: I;
  role: 'user';
  content: { type: 'text'; text: string }[];
  source: { kind: 'plugin'; plugin: 'swarmboard'; form: 'relay' };
}
export interface DshSdkSessionAgent<I extends string> extends DshAgent {
  session: DshAgent['session'] & { readonly events: readonly DshSdkEvent[] };
  inbox: { hasPending: boolean };
  send(message: DshSdkUserMessage<I>, target: 'next-turn', wakeup: true): void;
}
export interface DshSdkSessionOptions<I extends string, A extends DshSdkSessionAgent<I>> {
  adapterId?: string;
  memberId: string;
  sessionRef: string;
  cwd: string;
  getAgent(sessionRef: string): A | undefined;
  /** Official MessageId constructor: must preserve the exact supplied string. */
  messageId(value: string): I;
  /** Synchronous final check of current admission, scope and host lease token.
   * The host holds the lease through send/flush; this function must not renew,
   * acquire asynchronously or return an earlier authorization snapshot. */
  isAuthorized(batch: DshSdkBatch, agent: A): boolean;
  /** Call official SessionStore.flush(agent.session), preserving its carrier.
   * true means at least one durability listener completed; false is not durable. */
  flush(agent: A): Promise<boolean>;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function batchDigest(batch: DshSdkBatch): string | undefined {
  const ids = batch.delivery.entryIds;
  if (!Number.isSafeInteger(batch.delivery.sequence) || batch.delivery.sequence < 1 || !ids.length
    || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1)
    || batch.entries.length !== ids.length || new Set(batch.entries.map(e => e.id)).size !== ids.length
    || batch.entries.some(e => !ids.includes(e.id))) return;
  return hash(JSON.stringify([batch.adapterId ?? null, batch.memberId, batch.sessionRef,
    batch.delivery.sequence, ids, batch.entries.map(e => [e.id, e.kind, e.summary, e.detail ?? null]), batch.check ?? null]));
}

function messageDigest(value: unknown): string | undefined {
  const message = object(value); const source = object(message?.source);
  if (message?.role !== 'user' || source?.kind !== 'plugin' || source.plugin !== 'swarmboard'
    || source.form !== 'relay' || !Array.isArray(message.content) || message.content.length !== 1) return;
  const block = object(message.content[0]);
  return block?.type === 'text' && typeof block.text === 'string' ? hash(block.text) : undefined;
}

/** No connect/resume, timer, receipt, disposal, model choice or approval bypass.
 * A durable driver intent must precede submit. Inconclusive sends stay unknown;
 * reconstruction may inspect this same session's log, never submit them again. */
export function createDshSdkSessionPort<I extends string, A extends DshSdkSessionAgent<I>>(
  input: DshSdkSessionOptions<I, A>,
) {
  const options = Object.freeze({ ...input });
  if (!options.memberId?.trim() || !options.sessionRef?.trim() || !isAbsolute(options.cwd)) throw new Error('DSH_INVALID_CONFIG');
  const binding = options.getAgent(options.sessionRef);
  if (!binding) throw new Error('DSH_SESSION_MISSING');
  const current = (batch: DshSdkBatch): boolean => batch.memberId === options.memberId
    && batch.sessionRef === options.sessionRef && batch.adapterId === options.adapterId
    && options.getAgent(options.sessionRef) === binding && binding.id === options.sessionRef
    && binding.session.id === options.sessionRef && binding.session.header.cwd === options.cwd
    && options.isAuthorized(batch, binding) === true;

  return Object.freeze({
    isCurrent: async (batch: DshSdkBatch) => current(batch),
    isBusy: async (batch: DshSdkBatch) => !current(batch) || binding.status !== 'idle' || binding.inbox.hasPending,
    async submit(batch: DshSdkBatch, text: string): Promise<{
      status: 'enqueued' | 'unknown' | 'rejected'; detail?: string;
    }> {
      const digest = batchDigest(batch);
      if (!digest || typeof text !== 'string' || !text.trim() || !current(batch)) return { status: 'rejected' };
      const rawId = `swarmboard-${digest}`;
      const messageId = options.messageId(rawId);
      if (messageId !== rawId) return { status: 'rejected' };
      const inputDigest = hash(text);
      const detail = JSON.stringify({ version: 1, messageId, batchDigest: digest, inputDigest });
      const existing = binding.session.events.filter(e =>
        (e.type === 'user/message' && object(e.data)?.id === messageId)
        || (e.type === 'agent/inbox/spliced' && Array.isArray(object(e.data)?.inserted)
          && (object(e.data)!.inserted as unknown[]).some(m => object(m)?.id === messageId)));
      // Existing evidence never licenses a second send. A changed input for the
      // same snapshot is a conflict requiring host reconciliation, not a replay.
      for (const event of existing) {
        const messages = event.type === 'user/message' ? [event.data] : object(event.data)!.inserted as unknown[];
        if (messages.some(m => object(m)?.id === messageId && messageDigest(m) !== inputDigest)) return { status: 'unknown' };
      }
      const message: DshSdkUserMessage<I> = { id: messageId, role: 'user', content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'swarmboard', form: 'relay' } };
      // No await between this live lease/binding check and the irreversible SDK
      // call. next-turn queues safely if another activity started meanwhile.
      if (!current(batch)) return { status: 'rejected' };
      try {
        if (!existing.length) binding.send(message, 'next-turn', true);
        if (await options.flush(binding) !== true) return { status: 'unknown', detail };
        return { status: 'enqueued', detail };
      } catch {
        return { status: 'unknown', detail };
      }
    },
    async settlement(batch: DshSdkBatch, token: string): Promise<{ settled: boolean }> {
      const digest = batchDigest(batch);
      let receipt: Record<string, unknown> | undefined;
      try { receipt = object(JSON.parse(token)); } catch { return { settled: false }; }
      if (!digest || receipt?.version !== 1 || receipt.batchDigest !== digest
        || receipt.messageId !== `swarmboard-${digest}` || typeof receipt.inputDigest !== 'string'
        || !current(batch)) return { settled: false };
      const completed = () => {
        let active: number | undefined; let owned: number | undefined; let seen = false; let ended = false; let previous = -1;
        for (const event of binding.session.events) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= previous) return false;
          previous = event.seq; const data = object(event.data);
          if (event.type === 'turn/start') {
            if (active !== undefined || !Number.isSafeInteger(data?.turn)) return false;
            active = data!.turn as number;
          } else if (event.type === 'user/message' && data?.id === receipt!.messageId) {
            if (seen || active === undefined || messageDigest(data) !== receipt!.inputDigest) return false;
            seen = true; owned = active;
          } else if (event.type === 'turn/end') {
            if (active !== data?.turn) return false;
            if (seen && active === owned) ended = object(data?.reason)?.kind === 'completed';
            active = undefined;
          }
        }
        return seen && ended;
      };
      if (!completed()) return { settled: false };
      try { if (await options.flush(binding) !== true) return { settled: false }; } catch { return { settled: false }; }
      return { settled: current(batch) && completed() };
    },
  });
}
