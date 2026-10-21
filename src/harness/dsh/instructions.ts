// Vendor-isolated DSH instruction adapter (anti-corruption layer).
//
// Purpose: turn the board's *generic* dual-prompt snapshots into the durable
// user-role baseline that the official DSH instruction channel injects, and guard
// the write against foreign/stale baselines. Nothing here starts a session, chooses
// a model, or grants anything: the trusted composition entry supplies the snapshots,
// the protocol text (owned by the core) and the workspace paths.
//
// Dependency direction (v31 #11): core -> generic contract <- this adapter.
// The core must never import this module; only the composition entry wires it.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const INSTRUCTION_SCHEMA = 'personal-instructions/v1';
const OPEN = '<system-reminder>';
const CLOSE = '</system-reminder>';
const CLEARED_PREFERENCES = 'The personal collaborator preferences are currently cleared. No personal preference text is active; the vendor base system and the collaboration protocol above still apply.';

export interface Snapshot {
  version: number;
  text: string;
  source?: string | null;
  userPromptVersion?: number;
  userPromptText?: string;
  userPromptSource?: string | null;
}

export interface RenderInput {
  protocolVersion: string;
  protocolDigest: string;
  protocolText: string;
  preferencesVersion: number;
  preferencesText: string;
  preferencesSource?: string;
  cleared?: boolean;
  userPromptVersion?: number;
  userPromptText?: string;
  userPromptSource?: string;
  userPromptCleared?: boolean;
}

export interface Rendered {
  readonly content: string;
  readonly digest: string;
  readonly marker: string;
  readonly protocolVersion: string;
  readonly protocolDigest: string;
  readonly preferencesVersion: number;
  readonly cleared: boolean;
  readonly userPromptVersion: number;
  readonly userPromptCleared: boolean;
}

const digestOf = (value: string) => createHash('sha256').update(value).digest('hex');

export function renderInstructions(input: RenderInput): Rendered {
  const {
    protocolVersion, protocolDigest, protocolText,
    preferencesVersion, preferencesText, preferencesSource = 'main-chat-relay', cleared = false,
    userPromptVersion = 0, userPromptText = '', userPromptSource = 'unspecified', userPromptCleared = true,
  } = input;
  if (typeof protocolVersion !== 'string' || !protocolVersion.trim()) throw Error('protocolVersion required');
  if (!/^[a-f0-9]{64}$/.test(protocolDigest)) throw Error('protocolDigest must be a sha256');
  if (typeof protocolText !== 'string' || !protocolText.trim()) throw Error('protocolText required');
  if (!Number.isSafeInteger(preferencesVersion) || preferencesVersion < 1) throw Error('preferencesVersion must be a positive integer');
  if (cleared) { if (preferencesText) throw Error('A cleared preference snapshot must not carry text'); }
  else if (!preferencesText.trim()) throw Error('preferencesText required unless cleared');
  if (!Number.isSafeInteger(userPromptVersion) || userPromptVersion < 0) throw Error('userPromptVersion must be a non-negative integer');
  if (!userPromptCleared && !userPromptText.trim()) throw Error('Non-cleared user prompt requires text');
  const marker = `<!-- ${INSTRUCTION_SCHEMA} protocol=${protocolVersion} protocol-digest=${protocolDigest} preferences=${preferencesVersion} source=${preferencesSource} cleared=${cleared} user-prompt=${userPromptVersion} user-prompt-source=${userPromptSource} user-prompt-cleared=${userPromptCleared} -->`;
  const content = [
    marker, OPEN,
    'This complete personal-instruction baseline replaces all earlier personal-instruction baselines from this adapter.',
    `Collaboration protocol: version ${protocolVersion} (sha256 ${protocolDigest}).`,
    protocolText.trim(), '',
    `Personal preferences: version ${preferencesVersion} (source ${preferencesSource}${cleared ? ', cleared' : ''}).`,
    cleared ? CLEARED_PREFERENCES : preferencesText.trim(), '',
    `Personal user prompt: version ${userPromptVersion} (source ${userPromptSource}${userPromptCleared ? ', cleared' : ''}).`,
    userPromptCleared ? 'The personal user-prompt field is currently empty.' : userPromptText.trim(),
    CLOSE, '',
  ].join('\n');
  return Object.freeze({
    content, digest: digestOf(content), marker, protocolVersion, protocolDigest,
    preferencesVersion, cleared, userPromptVersion, userPromptCleared,
  });
}

export function planWrite(previousContent: string | null, rendered: Rendered) {
  const write = previousContent !== rendered.content;
  return Object.freeze({ write, changed: write, digest: rendered.digest, preferencesVersion: rendered.preferencesVersion });
}

export function assertFresh(prepared: Rendered, current: Snapshot & { protocolVersion?: string; protocolDigest?: string }) {
  if (!current) throw Error('Current preference snapshot required before submit');
  if (prepared.preferencesVersion !== current.version) {
    throw Error(`Preference version moved while preparing (prepared ${prepared.preferencesVersion}, current ${current.version})`);
  }
  const preparedUser = prepared.userPromptVersion ?? 0;
  const currentUser = current.userPromptVersion ?? 0;
  if (preparedUser !== currentUser) throw Error(`User prompt version moved while preparing (prepared ${preparedUser}, current ${currentUser})`);
  if (current.protocolVersion !== undefined && (prepared.protocolVersion !== current.protocolVersion || prepared.protocolDigest !== current.protocolDigest)) {
    throw Error('Collaboration protocol changed while preparing');
  }
  return true;
}

export function assertNotStale(incomingVersion: number, loadedVersion?: number | null) {
  if (!Number.isSafeInteger(incomingVersion)) throw Error('Incoming preference version required');
  if (Number.isSafeInteger(loadedVersion ?? NaN) && incomingVersion < (loadedVersion as number)) {
    throw Error(`Refusing stale preference snapshot (incoming ${incomingVersion} < loaded ${loadedVersion})`);
  }
  return true;
}

const ownedMarker = (text: string) =>
  text.match(new RegExp(`^<!-- ${INSTRUCTION_SCHEMA} protocol=self-org/v1 protocol-digest=([a-f0-9]{64}) preferences=(\\d+) source=\\S+ cleared=(?:true|false)(?: user-prompt=(\\d+) user-prompt-source=\\S+ user-prompt-cleared=(?:true|false))? -->`));

export interface BoundaryOptions {
  directory: string;
  workspace: string;
  sessionCwd: string;
  protocolText: string;
  protocolDigest: string;
  readPreferences: () => Promise<{ version: number; text: string; source?: string | null }>;
  readUserPrompt: () => Promise<{ version: number; text: string; source?: string | null }>;
  ensureOpen: () => void;
}

export function createDshInstructionBoundary(options: BoundaryOptions) {
  const { directory, workspace, sessionCwd, protocolText, protocolDigest, readPreferences, readUserPrompt, ensureOpen } = options;
  if (!protocolText.trim()) throw Error('protocolText required from the caller');
  if (!/^[a-f0-9]{64}$/.test(protocolDigest)) throw Error('protocolDigest required from the caller');
  if (digestOf(protocolText) !== protocolDigest) throw Error('protocolText does not match protocolDigest');
  for (const target of [directory, workspace, sessionCwd]) {
    if (!path.isAbsolute(target) || fs.realpathSync(target) !== target || !fs.statSync(target).isDirectory()) {
      throw Error('Canonical instruction directories required');
    }
  }
  if (sessionCwd !== workspace) throw Error('Instruction workspace differs from retained session cwd');
  const target = path.join(workspace, 'AGENTS.md');
  const ordinary = () => {
    let entry: fs.Stats | undefined;
    try { entry = fs.lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (fs.realpathSync(workspace) !== workspace || (entry && (!entry.isFile() || fs.realpathSync(target) !== target))) {
      throw Error('Instruction path must remain an ordinary workspace file');
    }
  };
  const current = async (): Promise<Snapshot> => {
    ensureOpen();
    const value = await readPreferences();
    let user;
    try { user = await readUserPrompt(); }
    catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND' || /unknown tool|not found/i.test(String((error as Error)?.message ?? ''))) {
        throw new Error('Current DSH generation does not expose user_prompt_read; dual-prompt unsupported', { cause: error });
      }
      throw error;
    }
    ensureOpen();
    if (!Number.isSafeInteger(value?.version) || (value.version as number) < 1 || typeof value.text !== 'string') throw Error('Formal preference snapshot required');
    if (!Number.isSafeInteger(user?.version) || (user.version as number) < 0 || typeof user.text !== 'string') throw Error('Formal user-prompt snapshot required');
    return {
      version: value.version, text: value.text, source: value.source ?? null,
      userPromptVersion: user.version, userPromptText: user.text, userPromptSource: user.source ?? null,
    };
  };
  return Object.freeze({
    target,
    async prepare() {
      const snapshot = await current();
      const rendered = renderInstructions({
        protocolVersion: 'self-org/v1', protocolDigest, protocolText,
        preferencesVersion: snapshot.version, preferencesText: snapshot.text, cleared: snapshot.text === '',
        preferencesSource: String(snapshot.source ?? 'unspecified').replace(/[^A-Za-z0-9_.:-]/g, '_'),
        userPromptVersion: snapshot.userPromptVersion ?? 0, userPromptText: snapshot.userPromptText ?? '',
        userPromptSource: String(snapshot.userPromptSource ?? 'unspecified').replace(/[^A-Za-z0-9_.:-]/g, '_'),
        userPromptCleared: (snapshot.userPromptText ?? '') === '',
      });
      ensureOpen(); ordinary();
      const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      if (previous !== null) {
        const marker = ownedMarker(previous);
        if (!marker || marker[1] !== protocolDigest || Number(marker[2]) > snapshot.version ||
            (marker[3] !== undefined && Number(marker[3]) > (snapshot.userPromptVersion ?? 0))) {
          throw Error('Foreign or newer instruction baseline; preserved');
        }
      }
      const plan = planWrite(previous, rendered);
      if (plan.write) {
        const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
        try { fs.writeFileSync(temporary, rendered.content, { mode: 0o600 }); fs.renameSync(temporary, target); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      return { rendered, snapshot, plan };
    },
    assertFresh,
    assertCurrent(prepared: { rendered: Rendered }, decision: { protocolVersion: string; protocolDigest: string }) {
      if (prepared.rendered.protocolVersion !== decision.protocolVersion || prepared.rendered.protocolDigest !== decision.protocolDigest) {
        throw Error('Collaboration protocol changed while preparing');
      }
      return true;
    },
  });
}
