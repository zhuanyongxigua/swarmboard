import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshLifecycle, type DshAgent, type DshLifecycleIntent } from '../../src/harness/dsh/lifecycle.js';

function fixture() {
  const agents = new Map<string, DshAgent>();
  let intent: DshLifecycleIntent | null = null;
  const agent = (id = 'synthetic-session', cwd = '/synthetic/workspace'): DshAgent => ({
    id, session: { id, header: { cwd } }, status: 'idle',
  });
  const registry = {
    get: vi.fn((id: string) => agents.get(id)),
    create: vi.fn(async (options: { sessionId: string; meta: { cwd: string } }) => {
      const a = agent(options.sessionId, options.meta.cwd); agents.set(a.id, a); return a;
    }),
    resume: vi.fn(async (options: { resumeSessionId: string }) => {
      const a = agent(options.resumeSessionId); agents.set(a.id, a); return a;
    }),
  };
  const journal = {
    read: () => intent,
    write: vi.fn((next: DshLifecycleIntent | null) => { intent = next; }),
  };
  const make = () => new DshLifecycle({ sessionId: 'synthetic-session', cwd: '/synthetic/workspace', registry, journal });
  return { agents, agent, registry, journal, make };
}

describe('DSH lifecycle boundary', () => {
  it('attaches the exact existing session without creating or resuming it', async () => {
    const f = fixture(); const a = f.agent(); f.agents.set(a.id, a);
    expect(await f.make().connect('attach')).toBe(a);
    expect(f.registry.create).not.toHaveBeenCalled(); expect(f.registry.resume).not.toHaveBeenCalled();
  });

  it('does not turn a missing attach into a new session', async () => {
    const f = fixture();
    await expect(f.make().connect('attach')).rejects.toThrow('DSH_SESSION_MISSING');
    expect(f.registry.create).not.toHaveBeenCalled(); expect(f.registry.resume).not.toHaveBeenCalled();
  });

  it('rejects mismatched session or cwd before exposing a binding', async () => {
    for (const a of [fixture().agent('other'), fixture().agent('synthetic-session', '/other')]) {
      const f = fixture(); f.agents.set('synthetic-session', a);
      await expect(f.make().connect('attach')).rejects.toThrow('DSH_SESSION_CONFLICT');
    }
  });

  it('starts only explicitly, records intent first, and retains the requested identity', async () => {
    const f = fixture(); const lifecycle = f.make();
    f.registry.create.mockImplementationOnce(async options => {
      expect(f.journal.read()).toEqual({ operation: 'start', sessionId: options.sessionId, cwd: options.meta.cwd });
      const a = f.agent(); f.agents.set(a.id, a); return a;
    });
    await lifecycle.connect('start');
    expect(f.registry.create).toHaveBeenCalledWith({ sessionId: 'synthetic-session', meta: { cwd: '/synthetic/workspace' } });
    expect(f.journal.read()).toBeNull(); expect(lifecycle.status()).toBe('ready');
    await expect(lifecycle.connect('start')).rejects.toThrow('DSH_SESSION_EXISTS');
    expect(f.registry.create).toHaveBeenCalledTimes(1);
  });

  it('resumes the persisted id and reuses an already live agent without another resume', async () => {
    const f = fixture(); const lifecycle = f.make(); const a = await lifecycle.connect('resume');
    expect(f.registry.resume).toHaveBeenCalledWith({ resumeSessionId: 'synthetic-session' });
    expect(await lifecycle.connect('resume')).toBe(a); expect(f.registry.resume).toHaveBeenCalledTimes(1);
  });

  it('blocks another boundary while the same registry session is opening', async () => {
    const f = fixture(); let release!: (a: DshAgent) => void;
    f.registry.resume.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.make().connect('resume');
    await expect(f.make().connect('attach')).rejects.toThrow('DSH_OPERATION_PENDING');
    const a = f.agent(); f.agents.set(a.id, a); release(a); await first;
  });

  it('preserves uncertain mutation across reconstruction and only reconciles by reading the original session', async () => {
    const f = fixture();
    f.registry.resume.mockRejectedValueOnce(new Error('disconnected'));
    await expect(f.make().connect('resume')).rejects.toThrow('disconnected');
    const recovered = f.make(); expect(recovered.status()).toBe('unknown');
    await expect(recovered.connect('resume')).rejects.toThrow('DSH_RECONCILIATION_REQUIRED');
    await expect(recovered.connect('attach')).rejects.toThrow('DSH_SESSION_MISSING');
    expect(f.journal.read()).not.toBeNull();
    const a = f.agent(); f.agents.set(a.id, a);
    expect(await recovered.connect('attach')).toBe(a); expect(f.journal.read()).toBeNull();
    expect(f.registry.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps the no-replay fence after the host journal database is closed and reopened', async () => {
    const f = fixture(); const dir = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-'));
    let db = new DatabaseSync(join(dir, 'journal.sqlite'));
    try {
      db.exec('CREATE TABLE lifecycle (id INTEGER PRIMARY KEY, intent TEXT)');
      const journal = {
        read: () => {
          const row = db.prepare('SELECT intent FROM lifecycle WHERE id=1').get();
          return row?.intent ? JSON.parse(String(row.intent)) as DshLifecycleIntent : null;
        },
        write: (intent: DshLifecycleIntent | null) => {
          db.prepare('INSERT INTO lifecycle VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent')
            .run(intent ? JSON.stringify(intent) : null);
        },
      };
      const make = () => new DshLifecycle({ sessionId: 'synthetic-session', cwd: '/synthetic/workspace', registry: f.registry, journal });
      f.registry.resume.mockRejectedValueOnce(new Error('connection lost'));
      await expect(make().connect('resume')).rejects.toThrow('connection lost');
      db.close(); db = new DatabaseSync(join(dir, 'journal.sqlite'));
      const reopened = make(); expect(reopened.status()).toBe('unknown');
      await expect(reopened.connect('resume')).rejects.toThrow('DSH_RECONCILIATION_REQUIRED');
      reopened.detach(); expect(journal.read()).not.toBeNull();
      expect(f.registry.resume).toHaveBeenCalledTimes(1);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps intent when the returned agent is not the currently registered exact session', async () => {
    const f = fixture(); f.registry.create.mockResolvedValueOnce(f.agent());
    await expect(f.make().connect('start')).rejects.toThrow('DSH_SESSION_CONFLICT');
    expect(f.journal.read()?.operation).toBe('start');
  });

  it('does not invoke the host when durable intent cannot be written', async () => {
    const f = fixture(); f.journal.write.mockImplementationOnce(() => { throw new Error('disk failure'); });
    await expect(f.make().connect('resume')).rejects.toThrow('disk failure');
    expect(f.registry.resume).not.toHaveBeenCalled();
  });

  it('pauses local admission without canceling the busy original session', async () => {
    const f = fixture(); const a = f.agent(); a.status = 'running'; f.agents.set(a.id, a);
    const lifecycle = f.make(); await lifecycle.connect('attach'); lifecycle.pause();
    await expect(lifecycle.connect('resume')).rejects.toThrow('DSH_PAUSED');
    expect(() => lifecycle.detach()).toThrow('DSH_BUSY');
    expect(f.agents.get(a.id)).toBe(a);
    a.status = 'idle'; lifecycle.detach(); expect(f.agents.get(a.id)).toBe(a);
    lifecycle.unpause(); expect(await lifecycle.connect('attach')).toBe(a);
  });

  it('revalidates the live binding rather than retaining a replaced agent', async () => {
    const f = fixture(); const a = f.agent(); f.agents.set(a.id, a);
    const lifecycle = f.make(); await lifecycle.connect('attach');
    f.agents.set(a.id, f.agent());
    expect(lifecycle.status()).toBe('disconnected');
  });

  it('lets an accepted connection settle when paused in flight without admitting another operation', async () => {
    const f = fixture(); const lifecycle = f.make(); let release!: (a: DshAgent) => void;
    f.registry.resume.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = lifecycle.connect('resume'); lifecycle.pause();
    const a = f.agent(); f.agents.set(a.id, a); release(a);
    expect(await pending).toBe(a); expect(lifecycle.status()).toBe('paused');
    expect(f.journal.read()).toBeNull();
    await expect(lifecycle.connect('attach')).rejects.toThrow('DSH_PAUSED');
  });

  it('reports a conflict when the same live object no longer has the validated metadata', async () => {
    const f = fixture(); const a = f.agent(); f.agents.set(a.id, a);
    const lifecycle = f.make(); await lifecycle.connect('attach');
    Object.defineProperty(a.session.header, 'cwd', { value: '/different-workspace' });
    expect(() => lifecycle.status()).toThrow('DSH_SESSION_CONFLICT');
  });

  it('rejects malformed trusted configuration and a journal for another session', () => {
    const f = fixture();
    expect(() => new DshLifecycle({ sessionId: '', cwd: 'relative', registry: f.registry, journal: f.journal })).toThrow('DSH_INVALID_CONFIG');
    f.journal.write({ operation: 'resume', sessionId: 'other', cwd: '/synthetic/workspace' });
    expect(() => f.make()).toThrow('DSH_JOURNAL_CONFLICT');
  });
});
