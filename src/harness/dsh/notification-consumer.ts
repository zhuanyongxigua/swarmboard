// Wake the resident official DSH web session when the board has an unsettled
// delivery for that channel member.
//
// This module is the last hop of the product's own five-minute reminder chain:
// the board already schedules a per-seat check, publishes a SESSION_TASK_CHECK
// entry and records a durable delivery. What remains is to deliver that batch
// into the SAME original session through the official local web API, without
// creating a session, replaying unknown deliveries or waking a stopped pool.
//
// Everything personal (member ids, session refs, ports, database paths, state
// path) is supplied by an external config. The module has no vendor-specific
// branch in the core runtime, no timer of its own beyond the delivery poll, and
// never confirms a receipt on the member's behalf.

import { mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { notificationPayload } from './notification-port.js';

export const STATE_SCHEMA = 1;
export const DEFAULT_POLL_MS = 10_000;

export type SeatState = 'sending' | 'accepted' | 'unknown' | 'settled';

export interface SeatConfig {
  /** The member's registered channel adapter id. */
  readonly adapterId: string;
  readonly memberId: string;
  /** The original session that must be continued, never replaced. */
  readonly sessionRef: string;
  /** Local port of the resident official DSH web server for that session. */
  readonly port: number;
  /** A manual continuation writer's own record; when unsettled the waker skips. */
  readonly manualWriterStatePath?: string;
}

export interface ConsumerConfig {
  readonly statePath: string;
  readonly intervalMs?: number;
  readonly seats: readonly SeatConfig[];
}

export interface UnsettledDelivery {
  readonly sequence: number;
  /** Server-side delivery state; `unknown` must never be replayed. */
  readonly state?: 'pending' | 'unknown';
  readonly entryIds: readonly number[];
  readonly adapterId?: string;
  readonly sessionRef?: string;
  readonly registrationVersion?: number;
}

export interface EntryView {
  readonly id: number;
  readonly detail?: string;
}

export type FormalBinding =
  | {
      readonly ok: true;
      readonly adapterId: string;
      readonly registrationVersion: number;
      /** Current member scope (registered generation). */
      readonly memberTaskIds: readonly string[];
      /** Current admission scope; undefined means "not restricted by pool tasks". */
      readonly admissionTaskIds: readonly string[] | undefined;
    }
  | { readonly ok: false; readonly reason: string };

export type MaybePromise<T> = T | Promise<T>;

export interface BoardPort {
  unsettled(seat: SeatConfig): MaybePromise<readonly UnsettledDelivery[]>;
  binding(seat: SeatConfig): MaybePromise<FormalBinding>;
  /** Mirrors the delivered NotificationService.currentIntent() predicate. */
  intentCurrent(seat: SeatConfig, delivery: UnsettledDelivery): MaybePromise<{ ok: boolean; reason?: string }>;
  entries(ids: readonly number[]): MaybePromise<readonly EntryView[]>;
}

/**
 * Official local DSH web transport. The adapter owns the vendor protocol; the
 * core runtime never learns about `session.list` or `session.prompt`.
 */
export interface OfficialWebTransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly clientTimeZone?: string;
}

export function createOfficialWebTransport(options: OfficialWebTransportOptions = {}): TransportPort {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clientTimeZone = options.clientTimeZone ?? 'UTC';
  const rpc = async (seat: SeatConfig, method: string, payload: Record<string, unknown>, rpcId: string): Promise<unknown> => {
    const origin = `http://127.0.0.1:${seat.port}`;
    const body = { type: 'client-request', rpcId, method, payload };
    const response = await fetchImpl(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { result?: { ok?: boolean; value?: unknown; error?: { code?: string } } };
    const result = json?.result;
    if (!result?.ok) throw new Error(`official-web-api:${result?.error?.code ?? 'rejected'}`);
    return result.value;
  };
  return {
    async describe(seat) {
      const value = (await rpc(seat, 'session.list', {}, randomUUID())) as { items?: Array<Record<string, unknown>> } | undefined;
      const items = Array.isArray(value?.items) ? value.items : [];
      const match = items.find((row) => row?.sessionId === seat.sessionRef);
      if (!match) return { found: false, running: false, asOfSeq: null };
      const projections = match.projections as { asOfSeq?: unknown } | undefined;
      const asOfSeq = projections?.asOfSeq;
      return {
        found: true,
        running: match.running === true,
        asOfSeq: Number.isSafeInteger(asOfSeq) ? (asOfSeq as number) : null,
      };
    },
    async prompt(seat, input) {
      const value = (await rpc(seat, 'session.prompt', {
        sessionId: seat.sessionRef,
        mode: 'queue',
        content: [{ type: 'text', text: input.text }],
        clientTimeZone,
      }, input.rpcId)) as { accepted?: unknown } | undefined;
      return { accepted: value?.accepted === true, rpcId: input.rpcId };
    },
  };
}

export interface SessionView {
  readonly found: boolean;
  readonly running: boolean;
  readonly asOfSeq: number | null;
}

export interface TransportPort {
  describe(seat: SeatConfig): Promise<SessionView>;
  prompt(seat: SeatConfig, input: { readonly sequence: number; readonly text: string; readonly rpcId: string }): Promise<{ accepted: boolean; rpcId: string }>;
}

export interface SeatRecord {
  readonly sequence: number;
  readonly entryIds: readonly number[];
  readonly rpcId: string;
  readonly adapterId: string;
  readonly registrationVersion: number;
  readonly sessionRef: string;
  readonly asOfSeq: number | null;
  readonly nextSeq: number | null;
  readonly state: SeatState;
  readonly at?: string;
  readonly acceptedAt?: string;
  readonly settledAt?: string;
  readonly error?: string;
}

export interface PassAction {
  readonly seat?: string;
  readonly action: string;
  readonly sequence?: number;
  readonly rpcId?: string | null;
  readonly state?: string;
  readonly manual?: string;
  readonly adapterId?: string;
}

export interface PassError {
  readonly seat: string;
  readonly step: string;
  readonly error: string;
  readonly rpcId?: string;
}

export interface PassResult {
  readonly actions: readonly PassAction[];
  readonly errors: readonly PassError[];
}

export interface WakerStateShape {
  schema: number;
  seats: Record<string, SeatRecord | null>;
}

const seatKey = (seat: SeatConfig): string => `${seat.memberId}|${seat.sessionRef}`;

/** The prompt carries the product instruction that this delivery actually holds. */
export function promptTextFor({ sequence, entries }: { readonly sequence: number; readonly entries: readonly EntryView[] }): string {
  const check = entries
    .map((entry) => {
      try { return JSON.parse(entry.detail ?? 'null') as { kind?: string; instruction?: string } | null; } catch { return null; }
    })
    .find((detail) => detail?.kind === 'SESSION_TASK_CHECK' && typeof detail.instruction === 'string');
  const ids = entries.map((entry) => entry.id).filter((id) => Number.isSafeInteger(id));
  if (check) {
    return `Swarmboard five-minute check (delivery sequence ${sequence}${ids.length ? `, entries ${ids.join(', ')}` : ''}).\n\n${check.instruction}`;
  }
  return [
    'Swarmboard product notice: this session channel has one unsettled delivery.',
    `Delivery sequence ${sequence}${ids.length ? `, entries ${ids.join(', ')}` : ''}.`,
    'Read the referenced shared entries (context_read) and act on the authorized goals',
    'you can progress, then settle this batch with notification_receipt, echoing exactly',
    'the entryIds you actually processed. Do not merely acknowledge; do not replay unknown.',
  ].join('\n');
}

/** Process-wide single-flight guard so two passes cannot race the same session. */
let passInFlight = false;

/**
 * One waker pass. Durable intent (including rpcId and the pre-send watermark) is
 * written before the prompt; a failed prompt becomes unknown and is never retried.
 */
export async function runPass(input: {
  readonly seats: readonly SeatConfig[];
  readonly board: BoardPort;
  readonly transport: TransportPort;
  readonly state: WakerStateShape;
  readonly now: () => string;
  readonly persist?: () => void;
  readonly newRpcId?: () => string;
  readonly dryRun?: boolean;
  readonly promptText?: (input: { sequence: number; entries: readonly EntryView[] }) => string;
}): Promise<PassResult> {
  if (passInFlight) return { actions: [{ action: 'pass-in-flight' }], errors: [] };
  passInFlight = true;
  const actions: PassAction[] = [];
  const errors: PassError[] = [];
  const persist = input.persist ?? (() => {});
  const rpcIdOf = input.newRpcId ?? (() => randomUUID());
  const textFor = input.promptText ?? promptTextFor;
  try {
    for (const seat of input.seats) {
      const key = seatKey(seat);
      if (!Object.prototype.hasOwnProperty.call(input.state.seats, key)) input.state.seats[key] = null;
      const record = input.state.seats[key] ?? null;
      let rows: readonly UnsettledDelivery[];
      try { rows = await input.board.unsettled(seat); } catch (error) {
        errors.push({ seat: key, step: 'board', error: String((error as Error)?.message ?? error) });
        continue;
      }
      const unsettled = rows.filter((row) => Number.isSafeInteger(row?.sequence) && row.sequence >= 1);
      if (unsettled.length === 0) {
        if (record && record.state !== 'settled') {
          input.state.seats[key] = { ...record, state: 'settled', settledAt: input.now() };
          actions.push({ seat: key, action: 'settled', sequence: record.sequence });
        }
        continue;
      }
      const target = unsettled.reduce((a, b) => (a.sequence > b.sequence ? a : b));
      if (record && record.sequence === target.sequence && ['sending', 'accepted', 'unknown'].includes(record.state)) {
        actions.push({ seat: key, action: 'awaiting-member', sequence: target.sequence, state: record.state, rpcId: record.rpcId ?? null });
        continue;
      }
      // The service already marks a delivery unknown when its own attempt is
      // unreconciled. Preserve it and refuse to drive it: never re-prompt.
      if (target.state === 'unknown') {
        input.state.seats[key] = {
          sequence: target.sequence,
          entryIds: target.entryIds,
          rpcId: '',
          adapterId: seat.adapterId,
          registrationVersion: record?.registrationVersion ?? 0,
          sessionRef: seat.sessionRef,
          asOfSeq: record?.asOfSeq ?? null,
          nextSeq: record?.nextSeq ?? null,
          state: 'unknown',
          at: input.now(),
        };
        persist();
        actions.push({ seat: key, action: 'unknown-delivery', sequence: target.sequence, state: 'unknown' });
        continue;
      }
      // A port that throws (an async MCP facade rejecting, for example) must not
      // abort the other seats of this pass: one failing channel stays isolated
      // (acceptance: a channel failure never stops another channel).
      let binding: FormalBinding;
      try { binding = await input.board.binding(seat); } catch (error) {
        errors.push({ seat: key, step: 'binding', error: String((error as Error)?.message ?? error) });
        continue;
      }
      if (!binding.ok) {
        errors.push({ seat: key, step: 'binding', error: `stale-binding:${binding.reason}` });
        continue;
      }
      if (target.adapterId !== undefined && target.adapterId !== seat.adapterId) {
        errors.push({ seat: key, step: 'intent-scope', error: 'stale-intent:adapter-mismatch' });
        continue;
      }
      if (target.sessionRef !== undefined && target.sessionRef !== seat.sessionRef) {
        errors.push({ seat: key, step: 'intent-scope', error: 'stale-intent:session-mismatch' });
        continue;
      }
      if (target.registrationVersion !== undefined && target.registrationVersion !== binding.registrationVersion) {
        errors.push({ seat: key, step: 'intent-scope', error: `stale-intent:registration-version:${target.registrationVersion}!=${binding.registrationVersion}` });
        continue;
      }
      let scope: { ok: boolean; reason?: string };
      try { scope = await input.board.intentCurrent(seat, target); } catch (error) {
        errors.push({ seat: key, step: 'intent-scope', error: String((error as Error)?.message ?? error) });
        continue;
      }
      if (!scope.ok) {
        errors.push({ seat: key, step: 'intent-scope', error: `stale-scope:${scope.reason ?? 'unknown'}` });
        continue;
      }
      if (seat.manualWriterStatePath) {
        let manual: { state?: string } | null;
        try { manual = readManualWriterState(seat.manualWriterStatePath); } catch (error) {
          errors.push({ seat: key, step: 'manual-writer-state', error: String((error as Error)?.message ?? error) });
          continue;
        }
        if (manual && ['sending', 'accepted', 'unknown'].includes(manual.state ?? '')) {
          actions.push({ seat: key, action: 'manual-writer-active', sequence: target.sequence, manual: manual.state });
          continue;
        }
      }
      let session: SessionView;
      try { session = await input.transport.describe(seat); } catch (error) {
        errors.push({ seat: key, step: 'session.list', error: String((error as Error)?.message ?? error) });
        continue;
      }
      if (!session.found) {
        errors.push({ seat: key, step: 'session.list', error: 'original-session-not-found; no session will be created' });
        continue;
      }
      if (session.running) {
        actions.push({ seat: key, action: 'busy-skip', sequence: target.sequence });
        continue;
      }
      // The round trip crosses an async boundary: re-read authority and scope, then
      // the manual writer, before recording a new send.
      let hostAfter: FormalBinding;
      try { hostAfter = await input.board.binding(seat); } catch (error) {
        errors.push({ seat: key, step: 'host-authz', error: String((error as Error)?.message ?? error) });
        continue;
      }
      if (!hostAfter.ok) {
        errors.push({ seat: key, step: 'host-authz', error: `host-authz:changed-during-describe:${hostAfter.reason}` });
        continue;
      }
      // A generation bump invalidates the earlier binding snapshot even when the
      // adapter remains enabled (review FAIL 8882 item 1).
      if (hostAfter.adapterId !== binding.adapterId || hostAfter.registrationVersion !== binding.registrationVersion) {
        errors.push({ seat: key, step: 'host-authz', error: `host-authz:generation-changed:${binding.registrationVersion}->${hostAfter.registrationVersion}` });
        continue;
      }
      let scopeAfter: { ok: boolean; reason?: string };
      try { scopeAfter = await input.board.intentCurrent(seat, target); } catch (error) {
        errors.push({ seat: key, step: 'intent-scope', error: String((error as Error)?.message ?? error) });
        continue;
      }
      if (!scopeAfter.ok) {
        errors.push({ seat: key, step: 'intent-scope', error: `stale-scope:changed-during-describe:${scopeAfter.reason ?? 'unknown'}` });
        continue;
      }
      if (seat.manualWriterStatePath) {
        let after: { state?: string } | null;
        try { after = readManualWriterState(seat.manualWriterStatePath); } catch (error) {
          errors.push({ seat: key, step: 'manual-writer-state', error: String((error as Error)?.message ?? error) });
          continue;
        }
        if (after && ['sending', 'accepted', 'unknown'].includes(after.state ?? '')) {
          actions.push({ seat: key, action: 'manual-writer-active', sequence: target.sequence, manual: `${after.state}-changed-during-describe` });
          continue;
        }
      }
      if (input.dryRun) {
        actions.push({ seat: key, action: 'would-prompt', sequence: target.sequence, adapterId: binding.adapterId });
        continue;
      }
      let entries: readonly EntryView[] = [];
      try { entries = await input.board.entries(target.entryIds ?? []); } catch { entries = []; }
      const rpcId = rpcIdOf();
      const asOfSeq = Number.isSafeInteger(session.asOfSeq) ? session.asOfSeq : null;
      input.state.seats[key] = {
        sequence: target.sequence,
        entryIds: target.entryIds ?? [],
        rpcId,
        adapterId: binding.adapterId,
        registrationVersion: binding.registrationVersion,
        sessionRef: seat.sessionRef,
        asOfSeq,
        nextSeq: asOfSeq === null ? null : asOfSeq + 1,
        state: 'sending',
        at: input.now(),
      };
      persist();
      try {
        const outcome = await input.transport.prompt(seat, { sequence: target.sequence, text: textFor({ sequence: target.sequence, entries }), rpcId });
        input.state.seats[key] = { ...(input.state.seats[key] as SeatRecord), state: outcome.accepted ? 'accepted' : 'unknown', acceptedAt: input.now() };
        persist();
        actions.push({ seat: key, action: outcome.accepted ? 'prompted' : 'prompt-unknown', sequence: target.sequence, rpcId });
      } catch (error) {
        input.state.seats[key] = { ...(input.state.seats[key] as SeatRecord), state: 'unknown', error: String((error as Error)?.message ?? error) };
        persist();
        errors.push({ seat: key, step: 'session.prompt', error: String((error as Error)?.message ?? error), rpcId });
      }
    }
    return { actions, errors };
  } finally {
    passInFlight = false;
  }
}

function readManualWriterState(path: string): { state?: string } | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('MANUAL_WRITER_STATE_CORRUPT'); }
  return parsed && typeof parsed === 'object' ? (parsed as { state?: string }) : null;
}

/** Persisted consumer ledger; corrupt or unsupported files fail closed. */
export class WakerState {
  readonly file: string;
  state: WakerStateShape;

  constructor(file: string, seats: readonly SeatConfig[] = []) {
    this.file = file;
    this.state = { schema: STATE_SCHEMA, seats: {} };
    let text: string | null = null;
    try { text = readFileSync(file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error(`CONSUMER_STATE_UNREADABLE:${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}`, { cause: error });
    }
    if (text !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error('CONSUMER_STATE_CORRUPT'); }
      const shape = parsed as WakerStateShape | null;
      if (!shape || typeof shape !== 'object' || shape.schema !== STATE_SCHEMA || !shape.seats || typeof shape.seats !== 'object') {
        throw new Error('CONSUMER_STATE_SCHEMA_UNSUPPORTED');
      }
      this.state = { schema: STATE_SCHEMA, seats: shape.seats };
    }
    for (const seat of seats) {
      const key = seatKey(seat);
      if (!Object.prototype.hasOwnProperty.call(this.state.seats, key)) this.state.seats[key] = null;
    }
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, JSON.stringify(this.state, null, 2)); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
  }
}

export interface WriterLock { release(): void }

/**
 * Exclusive writer lock (O_EXCL). A stale lock is never broken automatically:
 * two writers must never both send, so an operator decides.
 */
export function acquireWriterLock(lockPath: string): WriterLock {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error('CONSUMER_WRITER_LOCK_HELD', { cause: error });
    throw error;
  }
  return { release: () => { try { unlinkSync(lockPath); } catch { /* already gone */ } } };
}

/**
 * Run the consumer loop with an exclusive writer lock. The first pass runs
 * immediately; `once` is for controlled field acceptance.
 */
export async function startNotificationConsumer(options: {
  readonly config: ConsumerConfig;
  readonly board: BoardPort;
  readonly transport: TransportPort;
  readonly now?: () => string;
  readonly once?: boolean;
}): Promise<{ stop(): void | Promise<void>; first: PassResult }> {
  const now = options.now ?? (() => new Date().toISOString());
  // Lock before loading the ledger: a second writer must never start from a stale
  // in-memory snapshot taken before the lock (review FAIL 8704 / 8882).
  mkdirSync(dirname(options.config.statePath), { recursive: true });
  const lock = acquireWriterLock(`${options.config.statePath}.lock`);
  let state: WakerState;
  try {
    state = new WakerState(options.config.statePath, options.config.seats);
  } catch (error) {
    lock.release();
    throw error;
  }
  let inFlight: Promise<PassResult> | null = null;
  // A tick that overlaps an active pass must reuse that pass instead of claiming
  // (and later clearing) its ownership: otherwise stop() waits on a short
  // "pass-in-flight" result, releases the lock early, and the real pass keeps
  // sending afterwards (review FAIL 8908).
  const pass = (dryRun = false): Promise<PassResult> => {
    const active = inFlight;
    if (active) return active;
    const run = (async () => {
      const result = await runPass({
        seats: options.config.seats,
        board: options.board,
        transport: options.transport,
        state: state.state,
        now,
        persist: () => state.save(),
        dryRun,
      });
      state.save();
      return result;
    })();
    inFlight = run;
    const clear = () => { if (inFlight === run) inFlight = null; };
    run.then(clear, clear);
    return run;
  };
  let first: PassResult;
  try {
    first = await pass(false);
  } catch (error) {
    await Promise.resolve(inFlight).catch(() => {});
    lock.release();
    throw error;
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  if (!options.once) {
    timer = setInterval(() => { void pass(false).catch(() => { /* surfaced by the next pass */ }); }, options.config.intervalMs ?? DEFAULT_POLL_MS);
  }
  return {
    first,
    stop() {
      if (timer) clearInterval(timer);
      const pending: Promise<PassResult> | null = inFlight;
      if (!pending) { lock.release(); return; }
      // Hand the lock over only after the in-flight pass has finished writing.
      return Promise.resolve(pending).catch(() => {}).then(() => { lock.release(); });
    },
  };
}

export interface McpCallTool {
  (request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

export interface McpBoardPortOptions {
  readonly callTool: McpCallTool;
  readonly pageSize?: number;
}

const MAX_PENDING_PAGES = 20;

/**
 * Board port backed by the caller-bound MCP notification tools. Standard RPC
 * envelopes are decoded through the same helper the existing DSH delivery port
 * uses, so `structuredContent`, a text-only result and `isError` all behave the
 * same way here. `notification_pending` applies the service's `currentIntent()`
 * filter only at read time, which is not a promise about the moment after a slow
 * `describe`: `intentCurrent` therefore polls again instead of returning a
 * constant, and an `unknown` delivery is surfaced as unknown, never as pending.
 */
export function createMcpBoardPort(options: McpBoardPortOptions): BoardPort {
  const pageSize = options.pageSize ?? 50;
  // A host may hand back the raw MCP result (`content`/`structuredContent`/`isError`)
  // or an already-unwrapped payload. Both go through the same decoder so error codes
  // and envelope rules cannot silently diverge.
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const value = await options.callTool({ name, arguments: args });
    const raw = value as Record<string, unknown> | null | undefined;
    const envelope = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      && (Array.isArray(raw.content) || raw.structuredContent !== undefined || raw.isError !== undefined);
    return notificationPayload(envelope ? raw : { structuredContent: raw });
  };
  const pending = async (seat: SeatConfig): Promise<readonly { sequence: number; entryIds: number[]; state: 'pending' | 'unknown' }[]> => {
    const out: { sequence: number; entryIds: number[]; state: 'pending' | 'unknown' }[] = [];
    let after = 0;
    for (let page = 0; page < MAX_PENDING_PAGES; page += 1) {
      const value = await call('notification_pending', { after, limit: pageSize });
      if (!Array.isArray(value.items) || typeof value.hasMore !== 'boolean') throw new Error('INVALID_NOTIFICATION_RESPONSE');
      const start = after;
      for (const raw of value.items) {
        const item = raw as { adapterId?: unknown; memberId?: unknown; sequence?: unknown; entryIds?: unknown; state?: unknown };
        if (item.adapterId !== seat.adapterId || item.memberId !== seat.memberId) throw new Error('AMBIGUOUS_NOTIFICATION_BINDING');
        if (!Number.isSafeInteger(item.sequence) || (item.sequence as number) <= after) throw new Error('INVALID_NOTIFICATION_RESPONSE');
        const entryIds = Array.isArray(item.entryIds) && item.entryIds.length > 0 && item.entryIds.length <= 200
          ? item.entryIds.filter((id): id is number => Number.isSafeInteger(id) && (id as number) >= 1)
          : [];
        if (entryIds.length !== (item.entryIds as unknown[]).length) throw new Error('INVALID_NOTIFICATION_RESPONSE');
        const state = item.state === 'pending' ? 'pending' as const : item.state === 'unknown' ? 'unknown' as const : undefined;
        if (!state) throw new Error('INVALID_NOTIFICATION_RESPONSE');
        after = item.sequence as number;
        out.push({ sequence: item.sequence as number, entryIds, state });
      }
      if (!value.hasMore) return out;
      // A growing channel may return an empty page with hasMore set; the cursor
      // still has to advance for the loop to stay bounded and honest.
      if (after === start) throw new Error('INVALID_NOTIFICATION_RESPONSE:cursor-stalled');
    }
    throw new Error('PENDING_PAGINATION_LIMIT');
  };
  return {
    async unsettled(seat) {
      return (await pending(seat)).map(({ sequence, entryIds, state }) => ({ sequence, entryIds, state }));
    },
    async binding(seat) {
      const value = await call('notification_binding_read', { adapterId: seat.adapterId });
      const binding = value.binding as { adapterId?: unknown; memberId?: unknown; sessionRef?: unknown; registrationVersion?: unknown; enabled?: unknown; taskIds?: unknown } | null | undefined;
      if (!binding) return { ok: false, reason: 'binding-missing' };
      if (binding.enabled !== true) return { ok: false, reason: 'adapter-disabled' };
      if (binding.memberId !== undefined && binding.memberId !== seat.memberId) return { ok: false, reason: 'member-mismatch' };
      if (binding.sessionRef !== seat.sessionRef) return { ok: false, reason: 'session-mismatch' };
      if (!Number.isSafeInteger(binding.registrationVersion) || (binding.registrationVersion as number) < 1) return { ok: false, reason: 'generation-missing' };
      const taskIds = Array.isArray(binding.taskIds) ? binding.taskIds.filter((id): id is string => typeof id === 'string') : [];
      return {
        ok: true,
        adapterId: String(binding.adapterId ?? seat.adapterId),
        registrationVersion: binding.registrationVersion as number,
        memberTaskIds: taskIds,
        admissionTaskIds: taskIds,
      };
    },
    async intentCurrent(seat, delivery) {
      try {
        const row = (await pending(seat)).find((item) => item.sequence === delivery.sequence);
        if (!row) return { ok: false, reason: 'not-visible' };
        if (row.state === 'unknown') return { ok: false, reason: 'delivery-unknown' };
        if (!delivery.entryIds.every((id) => row.entryIds.includes(id))) return { ok: false, reason: 'entry-set-changed' };
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: `pending-unreadable:${String((error as Error)?.message ?? error)}` };
      }
    },
    async entries(ids) {
      const out: EntryView[] = [];
      for (const id of ids) {
        const value = await call('context_read', { after: id - 1, limit: 1 });
        const items = Array.isArray(value.items) ? value.items : [];
        const item = items[0] as { id?: unknown; detail?: unknown; detailTruncated?: unknown } | undefined;
        // An exact seek also catches filtered or missing ids instead of silently
        // taking the next visible row; a truncated detail is incomplete content.
        if (item?.id !== id || item.detailTruncated === true) continue;
        const detail = typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail ?? null);
        out.push({ id, detail });
      }
      return out;
    },
  };
}
