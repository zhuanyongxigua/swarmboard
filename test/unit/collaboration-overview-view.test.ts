// Verify that AI-selected presentation cannot turn stale or unknown facts into current values.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollaborationOverview, type OverviewSnapshot } from '../../web/CollaborationOverview.js';

const snapshot = (): OverviewSnapshot => ({
  status: 'current', reason: null,
  facts: { revision: 'facts-a', observedAt: new Date().toISOString(), available: true,
    items: [{ id: 'bound', kind: 'count', value: 3, scope: 'Synthetic bound sessions', source: 'Synthetic runtime' },
      { id: 'model', kind: 'model', value: null, scope: 'Synthetic actual model', source: 'No observation' }] },
  record: { boardId: 'synthetic', version: 1, authorId: 'peer-a', updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(), preferencesVersion: 0, factsRevision: 'facts-a',
    factSnapshot: [{ id: 'bound', kind: 'count', value: 3, scope: 'Synthetic bound sessions', source: 'Synthetic runtime' },
      { id: 'model', kind: 'model', value: null, scope: 'Synthetic actual model', source: 'No observation' }],
    parts: [{ kind: 'text', text: 'Start with the source' }, { kind: 'fact', factId: 'bound' }, { kind: 'fact', factId: 'model' }] },
});
const render = (value: OverviewSnapshot | null) => renderToStaticMarkup(createElement(CollaborationOverview, { snapshot: value }));

describe('collaboration overview', () => {
  it('retains AI ordering in a compact line while leaving provenance in the formal interface', () => {
    const value = snapshot(); const html = render(value);
    expect(html.indexOf('Start with the source')).toBeLessThan(html.indexOf('>3<'));
    for (const text of ['Synthetic bound sessions', 'Synthetic runtime', 'peer-a', '<details', '<small', 'AI 说明', '概览依据', '有效至']) expect(html).not.toContain(text);
    value.record!.parts = [{ kind: 'fact', factId: 'model' }, { kind: 'text', text: 'A different expression' }];
    expect(render(value)).not.toContain('Synthetic bound sessions');
    expect(render(value)).toContain('A different expression');
  });
  it('renders AI text as inert text without injecting a fixed label', () => {
    const value = snapshot(); value.record!.parts = [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }];
    const html = render(value);
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
    expect(html).not.toContain('AI 说明');
  });
  it('keeps unknown model evidence and missing references unknown, never zero', () => {
    const value = snapshot(); value.record!.parts = [{ kind: 'fact', factId: 'model' }, { kind: 'fact', factId: 'absent' }];
    const html = render(value); expect(html.match(/未知/g)).toHaveLength(2);
    expect(html).not.toMatch(/>0</);
  });
  for (const status of ['stale', 'unavailable'] as const) it(`marks the whole report as previous with its own values when ${status}`,  () => {
    const value = snapshot(); value.status = status; value.facts.items[0]!.value = 9;
    const html = render(value); expect(html).toContain('Start with the source');
    expect(html).toContain('上次概览'); expect(html).toContain('>3<'); expect(html).not.toContain('>9<');
    expect(html.includes('role="alert"')).toBe(status === 'unavailable');
  });
  it('marks expired claims as previous before the next transport read without hiding useful context', () => {
    const value = snapshot(); value.record!.expiresAt = new Date(Date.now() - 1).toISOString();
    expect(render(value)).toContain('Start with the source'); expect(render(value)).toContain('上次概览');
    expect(render(value)).toContain('>3<'); expect(render(value)).not.toContain('正常工作回合');
  });
  it('does not reconstruct missing legacy historical values from current facts', () => {
    const value = snapshot(); value.status = 'stale'; delete value.record!.factSnapshot;
    const html = render(value); expect(html).toContain('上次概览'); expect(html).toContain('Start with the source');
    expect(html.match(/未知/g)).toHaveLength(2); expect(html).not.toContain('>3<');
  });
  it('has no fallback organization template or personal sample when no overview exists', () => {
    const value = snapshot(); value.status = 'missing'; value.record = null; value.facts.available = false;
    const html = render(value); expect(html).toContain('协作情况未知');
    expect(html).not.toContain('Synthetic bound sessions'); expect(html).not.toContain('14');
    expect(html).not.toContain('role="alert"');
  });
});
