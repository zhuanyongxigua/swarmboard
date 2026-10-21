// Synthetic, zero-model tests for the vendor-isolated DSH instruction adapter.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderInstructions, planWrite, assertFresh, assertNotStale, createDshInstructionBoundary,
} from '../../src/harness/dsh/instructions.js';

const PROTOCOL = 'Collaboration protocol body: goals are shared; blocked goals are waiting.';
const PROTOCOL_DIGEST = createHash('sha256').update(PROTOCOL).digest('hex');
const base = (over: Partial<Parameters<typeof renderInstructions>[0]> = {}) => renderInstructions({
  protocolVersion: 'self-org/v1', protocolDigest: PROTOCOL_DIGEST, protocolText: PROTOCOL,
  preferencesVersion: 1, preferencesText: 'PREFERENCES', ...over,
});

describe('renderInstructions', () => {
  it('renders an empty user prompt as a cleared v0 with an unspecified source', () => {
    const out = base();
    expect(out.content).toContain('user-prompt=0');
    expect(out.content).toContain('user-prompt-source=unspecified');
    expect(out.content).toContain('user-prompt-cleared=true');
    expect(out.content).not.toContain('user-prompt-source=main-chat-relay');
    expect(out.content).toContain('The personal user-prompt field is currently empty.');
  });

  it('renders an edited user prompt with its parts', () => {
    const out = base({ userPromptVersion: 1, userPromptText: '## resources\n- dev152', userPromptSource: 'main-chat-relay', userPromptCleared: false });
    expect(out.content).toContain('Personal user prompt: version 1 (source main-chat-relay).');
    expect(out.content).toContain('## resources');
    expect(out.content).toContain('user-prompt-cleared=false');
  });

  it('keeps the replacement sentence and the protocol digest line', () => {
    const out = base();
    expect(out.content).toContain('replaces all earlier personal-instruction baselines');
    expect(out.content).toContain(`sha256 ${PROTOCOL_DIGEST}`);
  });

  it('rejects a cleared preference snapshot that still carries text', () => {
    expect(() => base({ cleared: true, preferencesText: 'x' })).toThrow(/must not carry text/);
  });
});

describe('planWrite / freshness', () => {
  it('does not rewrite an unchanged baseline', () => {
    const out = base();
    expect(planWrite(out.content, out).write).toBe(false);
    expect(planWrite('older', out).write).toBe(true);
  });

  it('refuses a snapshot that moved while preparing', () => {
    const out = base({ userPromptVersion: 1, userPromptCleared: false, userPromptText: 'x' });
    expect(() => assertFresh(out, { version: 2, text: 'p' })).toThrow(/Preference version moved/);
    expect(() => assertFresh(out, { version: 1, text: 'p', userPromptVersion: 2 })).toThrow(/User prompt version moved/);
    expect(assertFresh(out, { version: 1, text: 'p', userPromptVersion: 1 })).toBe(true);
  });

  it('refuses a stale older snapshot', () => {
    expect(() => assertNotStale(2, 3)).toThrow(/stale/);
    expect(assertNotStale(3, 3)).toBe(true);
  });
});

describe('createDshInstructionBoundary', () => {
  const dirs = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dsh-inst-')));
    const runtime = path.join(root, 'runtime'); const ws = path.join(root, 'ws');
    fs.mkdirSync(runtime); fs.mkdirSync(ws);
    return { root, runtime, ws };
  };

  it('writes the baseline and accepts a legacy marker as v0', async () => {
    const { runtime, ws } = dirs();
    let prefs = { version: 3, text: 'PREFS', source: 'main-chat-relay' };
    let user = { version: 1, text: 'RES', source: 'main-chat-relay' };
    const boundary = createDshInstructionBoundary({
      directory: runtime, workspace: ws, sessionCwd: ws, protocolText: PROTOCOL, protocolDigest: PROTOCOL_DIGEST,
      readPreferences: async () => ({ ...prefs }), readUserPrompt: async () => ({ ...user }), ensureOpen: () => {},
    });
    const first = await boundary.prepare();
    expect(first.plan.write).toBe(true);
    const written = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
    expect(written).toContain('preferences=3');
    expect(written).toContain('user-prompt=1');
    const again = await boundary.prepare();
    expect(again.plan.write).toBe(false);
    user = { version: 2, text: 'RES2', source: 'main-chat-relay' };
    prefs = { version: 3, text: 'PREFS', source: 'main-chat-relay' };
    const moved = await boundary.prepare();
    expect(moved.plan.write).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8')).toContain('user-prompt=2');
  });

  it('preserves a foreign baseline instead of overwriting it', async () => {
    const { runtime, ws } = dirs();
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '<!-- someone else wrote this -->\n');
    const boundary = createDshInstructionBoundary({
      directory: runtime, workspace: ws, sessionCwd: ws, protocolText: PROTOCOL, protocolDigest: PROTOCOL_DIGEST,
      readPreferences: async () => ({ version: 1, text: 'P', source: null }),
      readUserPrompt: async () => ({ version: 0, text: '', source: null }), ensureOpen: () => {},
    });
    await expect(boundary.prepare()).rejects.toThrow(/Foreign or newer instruction baseline/);
    expect(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8')).toContain('someone else wrote this');
  });

  it('rejects explicitly when the harness has no user_prompt_read', async () => {
    const { runtime, ws } = dirs();
    const boundary = createDshInstructionBoundary({
      directory: runtime, workspace: ws, sessionCwd: ws, protocolText: PROTOCOL, protocolDigest: PROTOCOL_DIGEST,
      readPreferences: async () => ({ version: 1, text: 'P', source: null }),
      readUserPrompt: async () => { throw Error('unknown tool user_prompt_read'); }, ensureOpen: () => {},
    });
    await expect(boundary.prepare()).rejects.toThrow(/dual-prompt unsupported/);
  });

  it('refuses a protocol that does not match its digest', () => {
    const { runtime, ws } = dirs();
    expect(() => createDshInstructionBoundary({
      directory: runtime, workspace: ws, sessionCwd: ws, protocolText: PROTOCOL, protocolDigest: 'a'.repeat(64),
      readPreferences: async () => ({ version: 1, text: 'P', source: null }),
      readUserPrompt: async () => ({ version: 0, text: '', source: null }), ensureOpen: () => {},
    })).toThrow(/does not match/);
  });
});
