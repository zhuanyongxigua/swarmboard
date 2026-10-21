// Vendor-isolated turn driver for per-session checks (anti-corruption layer).
//
// The core publishes a directed SESSION_TASK_CHECK and records delivery state; this
// module decides, for one pending check, whether the original session may be asked to
// work — and it never guesses. It owns no timer, starts no process and knows nothing
// about identities, credentials or ledgers: the trusted host injects three ports.
//
// Safety rules (each is covered by a synthetic test):
//  1. a busy session is left alone (the check stays pending; the next scan retries);
//  2. before submitting, the session must still be the one the check was addressed to;
//  3. a durable intent is written BEFORE submitting, so a crash cannot lose the attempt;
//  4. an inconclusive submission keeps the intent and is never replayed blindly;
//  5. an authoritative completion whose receipt failed only retries the receipt;
//  6. the idempotency key is (memberId, sessionRef, dueAt).

export interface PendingCheck {
  memberId: string;
  sessionRef: string;
  dueAt: number;
  goalIds: readonly string[];
  adapterId?: string;
  registrationVersion?: number;
}

export type SubmitOutcome = { status: 'accepted' | 'unknown' | 'rejected'; detail?: string };

export interface PendingPort {
  list(): Promise<readonly PendingCheck[]>;
  confirm(check: PendingCheck): Promise<void>;
  release(check: PendingCheck, reason: 'stale-session' | 'rejected' | 'scope-empty'): Promise<void>;
}

export interface SessionPort {
  isCurrent(check: PendingCheck): Promise<boolean>;
  isBusy(check: PendingCheck): Promise<boolean>;
  submit(check: PendingCheck, text: string): Promise<SubmitOutcome>;
}

export type IntentState = 'submitting' | 'unknown' | 'acceptedUnacked';

export interface Intent {
  key: string;
  state: IntentState;
  check: PendingCheck;
  detail?: string;
}

export interface Journal {
  get(key: string): Promise<Intent | undefined>;
  put(intent: Intent): Promise<void>;
  del(key: string): Promise<void>;
}

export interface DriveOptions {
  /** Rendered instruction for one check. Kept injectable so the wording stays in the adapter. */
  text?: (check: PendingCheck) => string;
}

export interface DriveResult {
  submitted: string[];
  merged: string[];
  skipped: string[];
  rejected: string[];
  unknown: string[];
  receiptPending: string[];
  receiptsConfirmed: string[];
}

export const intentKey = (check: Pick<PendingCheck, 'memberId' | 'sessionRef' | 'dueAt'>) =>
  `${check.memberId}|${check.sessionRef}|${check.dueAt}`;

export const defaultCheckText = (check: PendingCheck) =>
  'Check your authorized goal list. If any goal is unclaimed, in progress or awaiting review, '
  + 'continue useful work with peers and then look again; blocked and finished goals need nothing.';

/** Drive exactly one pass over the pending checks. Callers own the single-flight guarantee. */
export async function driveOnce(
  ports: { pending: PendingPort; session: SessionPort; journal: Journal },
  options: DriveOptions = {},
): Promise<DriveResult> {
  const result: DriveResult = {
    submitted: [], merged: [], skipped: [], rejected: [], unknown: [],
    receiptPending: [], receiptsConfirmed: [],
  };
  const render = options.text ?? defaultCheckText;

  for (const check of await ports.pending.list()) {
    const key = intentKey(check);
    const intent = await ports.journal.get(key);

    // 5. An authoritative completion whose receipt failed only retries the receipt.
    if (intent?.state === 'acceptedUnacked') {
      try {
        await ports.pending.confirm(check);
        await ports.journal.del(key);
        result.receiptsConfirmed.push(key);
      } catch {
        result.receiptPending.push(key);
      }
      continue;
    }

    // 4. An inconclusive submission is never replayed; the caller reconciles it out of band.
    if (intent?.state === 'unknown') {
      result.unknown.push(key);
      continue;
    }

    // 3. A leftover 'submitting' intent means a crash mid-submit: keep it unknown, do not replay.
    if (intent?.state === 'submitting') {
      await ports.journal.put({ ...intent, state: 'unknown' });
      result.unknown.push(key);
      continue;
    }

    // 2. The session the check was addressed to must still be the current one.
    if (!(await ports.session.isCurrent(check))) {
      await ports.pending.release(check, 'stale-session');
      result.skipped.push(key);
      continue;
    }

    // 1. A busy session is left alone: the check stays pending for the next scan.
    if (await ports.session.isBusy(check)) {
      result.merged.push(key);
      continue;
    }

    // 3. Durable intent strictly before the side effect.
    await ports.journal.put({ key, state: 'submitting', check });

    let outcome: SubmitOutcome;
    try {
      outcome = await ports.session.submit(check, render(check));
    } catch (error) {
      outcome = { status: 'unknown', detail: String((error as Error)?.message ?? error) };
    }

    if (outcome.status === 'unknown') {
      await ports.journal.put({ key, state: 'unknown', check, detail: outcome.detail });
      result.unknown.push(key);
      continue;
    }
    if (outcome.status === 'rejected') {
      await ports.journal.del(key);
      await ports.pending.release(check, 'rejected');
      result.rejected.push(key);
      continue;
    }

    result.submitted.push(key);
    try {
      await ports.pending.confirm(check);
      await ports.journal.del(key);
    } catch (error) {
      await ports.journal.put({ key, state: 'acceptedUnacked', check, detail: String((error as Error)?.message ?? error) });
      result.receiptPending.push(key);
    }
  }

  return result;
}
