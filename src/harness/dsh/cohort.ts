// Persist operator startup intentions independently of model delivery journals,
// so another CLI invocation cannot recreate a seat after an uncertain result.
import { constants, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export type DshLaunchJson = null | boolean | number | string | DshLaunchJson[] | { [key: string]: DshLaunchJson };
export type DshLaunchRecord = { [key: string]: DshLaunchJson };
export const DSH_COHORT_STAGES = ['admit', 'session', 'bind', 'instructions', 'register', 'stage', 'launch'] as const;
export type DshCohortStage = typeof DSH_COHORT_STAGES[number];
export interface DshCohortRequest {
  cohortKey: string;
  count: number;
  /** Existing canonical private directory, outside the source checkout. */
  stateDirectory: string;
  /** Trusted declarative configuration only; credentials stay in the SDK environment. */
  configuration: DshLaunchRecord;
  /** Explicit existing session refs for selection; omitted refs are allocated once. */
  sessionRefs?: string[];
}
export interface DshCohortSeat {
  key: string;
  sessionRef: string;
  receipts: Partial<Record<DshCohortStage, DshLaunchRecord>>;
}
export interface DshCohortPorts {
  /** Recheck current authority before each intent. A failure here has no effect to reconcile. */
  preflight(stage: DshCohortStage, seat: DshCohortSeat): Promise<void>;
  /** Called once after the corresponding intent is durably committed. Never retried. */
  execute(stage: DshCohortStage, seat: DshCohortSeat): Promise<DshLaunchRecord>;
}
interface Attempt {
  stage: DshCohortStage;
  operationId: string;
  state: 'intent' | 'confirmed';
  receipt?: DshLaunchRecord;
}
interface SeatState { key: string; sessionRef: string; attempts: Attempt[] }
interface State {
  schema: 'swarmboard-dsh-cohort/v1';
  cohortKey: string;
  configurationSha256: string;
  seats: SeatState[];
}
export interface DshCohortStatus {
  cohortKey: string;
  busy: boolean;
  /** A retained claim may represent a crashed writer; age and PID are not recovery proof. */
  claimPresent: boolean;
  seats: Array<DshCohortSeat & {
    phase: 'planned' | 'preflight-blocked' | 'reconcile-required' | 'launched';
    nextStep: string;
    ready: false;
    consumed: false;
  }>;
}

function fail(code: string): never { throw new Error(code); }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return fail('DSH_COHORT_INVALID_JSON');
}
const copy = <T>(value: T): T => JSON.parse(canonical(value)) as T;
function requestSnapshot(request: DshCohortRequest): DshCohortRequest {
  const snapshot = copy(request);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(snapshot.cohortKey)
    || !Number.isSafeInteger(snapshot.count) || snapshot.count < 1
    || !snapshot.configuration || Array.isArray(snapshot.configuration)) fail('DSH_COHORT_INVALID_CONFIG');
  if (!path.isAbsolute(snapshot.stateDirectory) || realpathSync(snapshot.stateDirectory) !== snapshot.stateDirectory
    || !lstatSync(snapshot.stateDirectory).isDirectory()) fail('DSH_COHORT_CANONICAL_DIRECTORY_REQUIRED');
  if (snapshot.sessionRefs && (snapshot.sessionRefs.length !== snapshot.count || new Set(snapshot.sessionRefs).size !== snapshot.count
    || snapshot.sessionRefs.some(ref => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(ref)))) fail('DSH_COHORT_SESSION_REFS_REQUIRED');
  return snapshot;
}
function hash(request: DshCohortRequest): string {
  return createHash('sha256').update(canonical(request)).digest('hex');
}
function filename(request: DshCohortRequest): string { return path.join(request.stateDirectory, 'cohort.json'); }
function ordinary(file: string): boolean {
  try { if (!lstatSync(file).isFile() || realpathSync(file) !== file) fail('DSH_COHORT_UNSAFE_FILE'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function load(request: DshCohortRequest): State | null {
  const file = filename(request);
  if (!ordinary(file)) return null;
  const state = JSON.parse(readFileSync(file, 'utf8')) as State;
  if (state.schema !== 'swarmboard-dsh-cohort/v1' || state.cohortKey !== request.cohortKey
    || state.configurationSha256 !== hash(request) || state.seats?.length !== request.count) fail('DSH_COHORT_CONFIG_CONFLICT');
  const sessions = new Set<string>();
  for (const [index, seat] of state.seats.entries()) {
    if (seat.key !== `seat-${index + 1}` || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(seat.sessionRef)
      || sessions.has(seat.sessionRef) || !Array.isArray(seat.attempts) || seat.attempts.length > DSH_COHORT_STAGES.length) fail('DSH_COHORT_CORRUPT');
    sessions.add(seat.sessionRef);
    for (const [step, attempt] of seat.attempts.entries()) {
      if (attempt.stage !== DSH_COHORT_STAGES[step] || !attempt.operationId
        || !['intent', 'confirmed'].includes(attempt.state)
        || (attempt.state === 'confirmed' && (!attempt.receipt || Array.isArray(attempt.receipt)))
        || (attempt.state === 'intent' && (attempt.receipt !== undefined || step !== seat.attempts.length - 1))) fail('DSH_COHORT_CORRUPT');
    }
  }
  return state;
}
function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function save(request: DshCohortRequest, state: State): void {
  const bytes = canonical(state);
  const temporary = path.join(request.stateDirectory, `.cohort-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  // The claim excludes other writers. Atomic rename plus parent fsync commits
  // the new snapshot on local filesystems supporting these POSIX operations.
  if (existsSync(filename(request))) ordinary(filename(request));
  renameSync(temporary, filename(request));
  syncDirectory(request.stateDirectory);
}
function context(seat: SeatState): DshCohortSeat {
  const receipts: DshCohortSeat['receipts'] = {};
  for (const attempt of seat.attempts) if (attempt.state === 'confirmed') receipts[attempt.stage] = copy(attempt.receipt!);
  return { key: seat.key, sessionRef: seat.sessionRef, receipts };
}
function status(request: DshCohortRequest, state: State | null, busy: boolean, blocked = new Set<string>()): DshCohortStatus {
  return {
    cohortKey: request.cohortKey, busy,
    claimPresent: busy,
    seats: (state?.seats ?? Array.from({ length: request.count }, (_, index) => ({ key: `seat-${index + 1}`, sessionRef: '', attempts: [] }))).map(seat => {
      const pending = seat.attempts.find(attempt => attempt.state === 'intent');
      const complete = seat.attempts.length === DSH_COHORT_STAGES.length && !pending;
      return {
        ...context(seat), phase: pending ? 'reconcile-required' : complete ? 'launched' : blocked.has(seat.key) ? 'preflight-blocked' : 'planned',
        nextStep: pending ? `Reconcile ${pending.stage} operation ${pending.operationId} with authoritative evidence; do not replay.`
          : complete ? 'Read actual bootstrap readiness, completion receipts, and contribution evidence separately.'
            : blocked.has(seat.key) ? 'Restore current formal authority or correct configuration before continuing.' : `Continue ${DSH_COHORT_STAGES[seat.attempts.length]}.`,
        ready: false, consumed: false,
      };
    }),
  };
}
/** Local status only: this never imports an SDK, registers, or launches. */
export function inspectDshCohort(input: DshCohortRequest): DshCohortStatus {
  const request = requestSnapshot(input);
  const claim = path.join(request.stateDirectory, 'cohort-claim.json');
  return status(request, load(request), existsSync(claim));
}
export async function runDshCohort(input: DshCohortRequest, ports: DshCohortPorts): Promise<DshCohortStatus> {
  const request = requestSnapshot(input);
  const claim = path.join(request.stateDirectory, 'cohort-claim.json');
  let fd: number;
  try { fd = openSync(claim, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return status(request, load(request), true);
    throw error;
  }
  const token = randomUUID();
  try {
    writeFileSync(fd, JSON.stringify({ token, cohortKey: request.cohortKey }) + '\n');
    fsyncSync(fd); syncDirectory(request.stateDirectory);
    let state = load(request);
    if (!state) {
      state = { schema: 'swarmboard-dsh-cohort/v1', cohortKey: request.cohortKey, configurationSha256: hash(request),
        seats: Array.from({ length: request.count }, (_, index) => ({ key: `seat-${index + 1}`, sessionRef: request.sessionRefs?.[index] ?? `session-${randomUUID()}`, attempts: [] })) };
      save(request, state);
    }
    const blocked = new Set<string>();
    for (const seat of state.seats) {
      if (seat.attempts.some(attempt => attempt.state === 'intent')) continue;
      for (let step = seat.attempts.length; step < DSH_COHORT_STAGES.length; step++) {
        const stage = DSH_COHORT_STAGES[step];
        try { await ports.preflight(stage, context(seat)); }
        catch { blocked.add(seat.key); break; }
        const attempt: Attempt = { stage, operationId: randomUUID(), state: 'intent' };
        seat.attempts.push(attempt);
        save(request, state);
        let snapshot: DshLaunchRecord;
        try {
          snapshot = copy(await ports.execute(stage, context(seat)));
          if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object') fail('DSH_COHORT_INVALID_RECEIPT');
        }
        catch { break; } // Preserve the durable intent, even for an apparent transport failure.
        attempt.receipt = snapshot;
        attempt.state = 'confirmed';
        save(request, state);
      }
    }
    return status(request, state, false, blocked);
  } finally {
    closeSync(fd);
    // No crash-time or PID based reclamation. Only this live invocation removes
    // its own claim; unresolved operation intents remain in the snapshot.
    if (ordinary(claim) && JSON.parse(readFileSync(claim, 'utf8')).token === token) {
      unlinkSync(claim); syncDirectory(request.stateDirectory);
    }
  }
}
