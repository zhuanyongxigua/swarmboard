// Prepare or select an explicit official session without loading an AgentLoop.
// Durable local intent prevents an uncertain preparation from becoming a retry.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleNames = ['cordis', 'dsh-session', 'dsh-session-persistence-jsonl'] as const;
export type DshSessionModule = typeof moduleNames[number];
export interface DshSessionRequest {
  mode: 'create' | 'select';
  sessionRef: string;
  cwd: string;
  /** Existing dedicated per-seat directories, outside the repository. */
  persistenceRoot: string;
  stateDirectory: string;
  /** Trusted installed SDK tree; pins cover its public entry files, not its dependency closure. */
  sdk: { root: string; pins: Record<DshSessionModule, string> };
}
export interface DshPreparedSession {
  schema: 'swarmboard-dsh-session/v1';
  requestSha256: string;
  sessionRef: string;
  cwd: string;
  nativeRoot: string;
  nativePath: string;
  nativeSha256: string;
  created: boolean;
  /** Existing history is not claimed to contain zero model turns. */
  modelTurns: 0 | null;
  activated: false;
}
const ensure = (value: unknown, code: string): void => { if (!value) throw new Error(code); };
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const exists = (file: string) => {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};
function directory(file: string) {
  ensure(typeof file === 'string' && isAbsolute(file) && fs.lstatSync(file).isDirectory()
    && fs.realpathSync(file) === file, 'DSH_SESSION_CANONICAL_DIRECTORY_REQUIRED');
}
function within(root: string, file: string) {
  const delta = relative(root, file);
  return delta !== '' && !isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`);
}
function ordinary(file: string) {
  ensure(fs.lstatSync(file).isFile() && fs.lstatSync(file).nlink === 1 && fs.realpathSync(file) === file, 'DSH_SESSION_CANONICAL_FILE_REQUIRED');
}
function writeOnce(file: string, value: unknown) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const parent = fs.openSync(join(file, '..'), fs.constants.O_RDONLY);
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

/** Inspection validates local configuration/pins only; it imports no SDK and writes nothing. */
export function inspectDshSessionRequest(request: DshSessionRequest) {
  ensure(request && ['create', 'select'].includes(request.mode), 'DSH_SESSION_MODE_REQUIRED');
  ensure(Object.keys(request).every(key => ['mode', 'sessionRef', 'cwd', 'persistenceRoot', 'stateDirectory', 'sdk'].includes(key))
    && Object.keys(request.sdk).every(key => ['root', 'pins'].includes(key))
    && Object.keys(request.sdk.pins).every(key => moduleNames.includes(key as DshSessionModule)), 'DSH_SESSION_UNKNOWN_CONFIGURATION');
  ensure(typeof request.sessionRef === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(request.sessionRef),
    'DSH_SESSION_EXPLICIT_ID_REQUIRED');
  for (const path of [request.cwd, request.persistenceRoot, request.stateDirectory, request.sdk.root]) directory(path);
  const paths = [request.cwd, request.persistenceRoot, request.stateDirectory, request.sdk.root];
  ensure(paths.every((a, i) => paths.every((b, j) => i === j || (a !== b && !within(a, b) && !within(b, a)))),
    'DSH_SESSION_DISTINCT_DIRECTORIES_REQUIRED');
  const modules = Object.fromEntries(moduleNames.map(name => {
    const file = join(request.sdk.root, 'node_modules', '@deepseek-ai', name, 'lib/index.js');
    ordinary(file);
    ensure(/^[a-f0-9]{64}$/.test(request.sdk.pins[name]) && digest(fs.readFileSync(file)) === request.sdk.pins[name],
      'DSH_SESSION_SDK_PIN_MISMATCH');
    return [name, file];
  })) as Record<DshSessionModule, string>;
  return { modules, requestSha256: digest(JSON.stringify(request)) };
}

interface StoredSession { meta: { id: string; cwd: string }; events: { type: string; data: unknown }[] }
interface OfficialContext {
  plugin(plugin: unknown, options?: unknown): Promise<unknown>;
  get(name: string): unknown;
  sessions: {
    create(id: string, options: { meta: { cwd: string } }): { append(type: string, data: unknown): void };
    flush(session: unknown): Promise<boolean>;
  };
  sessionPersistence: {
    inspect(id: string): Promise<StoredSession>;
    locate(meta: StoredSession['meta']): { path: string };
  };
  fiber: { dispose(): Promise<void> };
}
interface OfficialModules {
  cordis: { Context: new () => OfficialContext };
  'dsh-session': { SessionStore: unknown; SessionId(value: string): string };
  'dsh-session-persistence-jsonl': { JsonlSessionPersistence: unknown };
}
async function loadOfficial(request: DshSessionRequest, modules: Record<DshSessionModule, string>) {
  const imported = await Promise.all(moduleNames.map(async name => {
    // Recheck after intent and immediately before each import. The installed tree remains host-trusted.
    ordinary(modules[name]);
    ensure(digest(fs.readFileSync(modules[name])) === request.sdk.pins[name], 'DSH_SESSION_SDK_PIN_MISMATCH');
    const url = pathToFileURL(modules[name]); url.searchParams.set('sha256', request.sdk.pins[name]);
    return [name, await import(url.href)];
  }));
  return Object.fromEntries(imported) as OfficialModules;
}
function verifyNative(receipt: DshPreparedSession, request: DshSessionRequest, requestSha256: string) {
  ensure(receipt.schema === 'swarmboard-dsh-session/v1' && receipt.requestSha256 === requestSha256
    && receipt.sessionRef === request.sessionRef && receipt.cwd === request.cwd
    && receipt.nativeRoot === request.persistenceRoot && receipt.created === (request.mode === 'create')
    && receipt.modelTurns === (request.mode === 'create' ? 0 : null) && receipt.activated === false,
  'DSH_SESSION_RECEIPT_CONFLICT');
  ensure(typeof receipt.nativePath === 'string' && within(request.persistenceRoot, receipt.nativePath),
    'DSH_SESSION_NATIVE_PATH_REQUIRED');
  ordinary(receipt.nativePath);
  ensure(digest(fs.readFileSync(receipt.nativePath)) === receipt.nativeSha256, 'DSH_SESSION_NATIVE_CHANGED');
}

/** Caller must already own the cohort/seat intent. This additional fixed local
 * attempt survives process loss; a missing receipt requires explicit reconciliation.
 * Confirmed repeated requests only read the original receipt and native bytes. */
export async function prepareDshSession(request: DshSessionRequest): Promise<DshPreparedSession> {
  const input: DshSessionRequest = JSON.parse(JSON.stringify(request));
  const { modules, requestSha256 } = inspectDshSessionRequest(input);
  const receiptPath = join(input.stateDirectory, 'session-prepared.json');
  const attemptPath = join(input.stateDirectory, 'session-attempt.json');
  if (exists(receiptPath)) {
    ordinary(receiptPath); ordinary(attemptPath);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as DshPreparedSession;
    verifyNative(receipt, input, requestSha256);
    ensure(JSON.parse(fs.readFileSync(attemptPath, 'utf8')).requestSha256 === requestSha256,
      'DSH_SESSION_ATTEMPT_CONFLICT');
    return receipt;
  }
  ensure(!exists(attemptPath), 'DSH_SESSION_RECONCILIATION_REQUIRED');
  if (input.mode === 'create') ensure(fs.readdirSync(input.persistenceRoot).length === 0, 'DSH_SESSION_FRESH_ROOT_REQUIRED');
  writeOnce(attemptPath, { schema: 'swarmboard-dsh-session-attempt/v1', requestSha256,
    mode: input.mode, sessionRef: input.sessionRef });
  const sdk = await loadOfficial(input, modules);
  const ctx = new sdk.cordis.Context();
  let receipt: DshPreparedSession;
  try {
    await ctx.plugin(sdk['dsh-session'].SessionStore);
    await ctx.plugin(sdk['dsh-session-persistence-jsonl'].JsonlSessionPersistence, { root: input.persistenceRoot });
    ensure(ctx.get('agents') === undefined && ctx.get('agentLoop') === undefined && ctx.get('llm') === undefined,
      'DSH_SESSION_AGENT_SERVICE_FORBIDDEN');
    const id = sdk['dsh-session'].SessionId(input.sessionRef);
    ensure(id === input.sessionRef, 'DSH_SESSION_ID_CONFLICT');
    if (input.mode === 'create') {
      const session = ctx.sessions.create(id, { meta: { cwd: input.cwd } });
      session.append('todo/write', { todos: [] });
      ensure(await ctx.sessions.flush(session) === true, 'DSH_SESSION_DURABILITY_REQUIRED');
    }
    // Selection never prepares/resumes/flushes an existing live session.
    const persisted = await ctx.sessionPersistence.inspect(id);
    ensure(persisted?.meta.id === input.sessionRef && persisted.meta.cwd === input.cwd, 'DSH_SESSION_IDENTITY_CONFLICT');
    if (input.mode === 'create') ensure(persisted.events.length === 1 && persisted.events[0].type === 'todo/write'
      && JSON.stringify(persisted.events[0].data) === '{"todos":[]}', 'DSH_SESSION_FRESH_EVENTS_REQUIRED');
    const nativePath = ctx.sessionPersistence.locate(persisted.meta).path;
    ensure(within(input.persistenceRoot, nativePath), 'DSH_SESSION_NATIVE_PATH_REQUIRED'); ordinary(nativePath);
    receipt = { schema: 'swarmboard-dsh-session/v1', requestSha256, sessionRef: input.sessionRef, cwd: input.cwd,
      nativeRoot: input.persistenceRoot, nativePath, nativeSha256: digest(fs.readFileSync(nativePath)),
      created: input.mode === 'create', modelTurns: input.mode === 'create' ? 0 : null, activated: false };
  } finally { await ctx.fiber.dispose(); }
  // Cleanup is part of preparation: only receipt bytes that still exist afterwards.
  verifyNative(receipt, input, requestSha256);
  writeOnce(receiptPath, receipt);
  return receipt;
}
