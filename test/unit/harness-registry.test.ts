// Configuration seam: default compatibility, explicit selection, and loud
// failure for unknown backends (never a silent fallback to another backend).
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHarness, knownHarnesses, registerHarnessBackend, unregisterHarnessBackend } from '../../src/harness/registry.js';
import type { HarnessBackend } from '../../src/harness/contract.js';
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
    for (const value of ['dsh', 'zcode', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const env = value === '' ? {} : { SWARMBOARD_HARNESS: value };
      const error = (() => { try { resolveHarness(env); } catch (thrown) { return thrown as { code?: string; message: string }; } })();
      expect(error, value).toBeTruthy();
      expect(error!.code, value).toBe('UNKNOWN_HARNESS');
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


const synthetic: HarnessBackend = { ...echoBackend, id: 'synthetic-adapter', displayName: 'Synthetic adapter' };

describe('generic adapter registration seam', () => {
  afterEach(() => {
    for (const id of ['synthetic-adapter', 'synthetic-replacement']) {
      try { unregisterHarnessBackend(id); } catch { /* already absent */ }
    }
  });

  it('registers an arbitrary-named adapter without editing core and resolves it explicitly', () => {
    expect(registerHarnessBackend(synthetic)).toBe(synthetic);
    expect(knownHarnesses).toContain('synthetic-adapter');
    expect(resolveHarness({ SWARMBOARD_HARNESS: 'synthetic-adapter' })).toBe(synthetic);
    expect(resolveHarness({})).toBe(codexBackend);
    expect(() => registerHarnessBackend(synthetic)).toThrow(/already registered/);

    const replacement: HarnessBackend = { ...synthetic, displayName: 'Synthetic replacement' };
    expect(registerHarnessBackend(replacement, { replace: true })).toBe(replacement);
    expect(resolveHarness({ SWARMBOARD_HARNESS: 'synthetic-adapter' })).toBe(replacement);

    unregisterHarnessBackend('synthetic-adapter');
    expect(knownHarnesses).not.toContain('synthetic-adapter');
    expect(() => resolveHarness({ SWARMBOARD_HARNESS: 'synthetic-adapter' })).toThrow(/Unknown harness backend/);
  });

  it('keeps built-ins non-removable and rejects malformed or incomplete adapters', () => {
    expect(() => unregisterHarnessBackend('codex')).toThrow(/built in/);
    expect(() => unregisterHarnessBackend('not-registered')).toThrow(/not registered/);
    for (const id of ['', ' bad', 'bad id', '-bad', 'a'.repeat(65)]) {
      expect(() => registerHarnessBackend({ ...synthetic, id } as HarnessBackend), JSON.stringify(id)).toThrow(/Harness backend id/);
    }
    expect(() => registerHarnessBackend({ id: 'incomplete' } as HarnessBackend)).toThrow(/displayName|capabilities|createSession/);
    const missing = (patch: Partial<HarnessBackend>) => registerHarnessBackend({ ...synthetic, ...patch } as HarnessBackend);
    expect(() => missing({ displayName: '' })).toThrow(/displayName/);
    expect(() => missing({ capabilities: undefined as never })).toThrow(/capabilities/);
    expect(() => missing({ capabilities: { ...synthetic.capabilities, inspection: 'yes' as never } })).toThrow(/capabilities/);
    expect(() => missing({ capabilities: { ...synthetic.capabilities, approvalSignals: 1 as never } })).toThrow(/capabilities/);
    expect(() => missing({ capabilities: { ...synthetic.capabilities, sessionInstructions: 'yes' as never } })).toThrow(/capabilities/);
    expect(() => missing({ deterministic: 'yes' as never })).toThrow(/deterministic/);
    expect(knownHarnesses).toEqual(['codex', 'echo']);
  });
});
