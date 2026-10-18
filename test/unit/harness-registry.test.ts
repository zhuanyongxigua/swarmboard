// Configuration seam: default compatibility, explicit selection, and loud
// failure for unknown backends (never a silent fallback to another backend).
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHarness, knownHarnesses } from '../../src/harness/registry.js';
import { codexBackend } from '../../src/codex-session.js';
import { echoBackend } from '../../src/harness/echo-backend.js';

const original = process.env.SWARMBOARD_HARNESS;
afterEach(() => {
  if (original === undefined) delete process.env.SWARMBOARD_HARNESS; else process.env.SWARMBOARD_HARNESS = original;
});

describe('harness backend registry', () => {
  it('defaults to the official Codex backend and resolves explicit ids', () => {
    expect(resolveHarness({})).toBe(codexBackend);
    expect(resolveHarness({ SWARMBOARD_HARNESS: ' codex ' })).toBe(codexBackend);
    expect(resolveHarness({ SWARMBOARD_HARNESS: 'echo' })).toBe(echoBackend);
    expect(knownHarnesses).toEqual(['codex', 'echo']);
  });
  it('fails loudly for an unknown backend instead of silently falling back', () => {
    for (const value of ['dsh', 'zcode']) {
      const env = value === '' ? {} : { SWARMBOARD_HARNESS: value };
      const error = (() => { try { resolveHarness(env); } catch (thrown) { return thrown as { code?: string; message: string }; } })();
      expect(error).toBeTruthy();
      expect(error!.code).toBe('UNKNOWN_HARNESS');
      expect(error!.message).toMatch(/Unknown harness backend/);
      expect(error!.message).toContain('codex, echo');
    }
  });
  it('reads the process environment when none is passed', () => {
    process.env.SWARMBOARD_HARNESS = 'echo';
    expect(resolveHarness()).toBe(echoBackend);
    process.env.SWARMBOARD_HARNESS = 'bogus';
    expect(() => resolveHarness()).toThrow(/Unknown harness backend/);
  });
});
