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
    parts: [{ kind: 'text', text: 'Start with the source' }, { kind: 'fact', factId: 'bound' }, { kind: 'fact', factId: 'model' }] },
});
const render = (value: OverviewSnapshot | null) => renderToStaticMarkup(createElement(CollaborationOverview, { snapshot: value }));

describe('collaboration overview', () => {
  it('retains AI ordering and makes factual scope and provenance accessible', () => {
    const value = snapshot(); const html = render(value);
    expect(html.indexOf('Start with the source')).toBeLessThan(html.indexOf('Synthetic bound sessions'));
    expect(html).toContain('Synthetic runtime'); expect(html).toContain('peer-a');
    value.record!.parts = [{ kind: 'fact', factId: 'model' }, { kind: 'text', text: 'A different expression' }];
    expect(render(value)).not.toContain('Synthetic bound sessions');
    expect(render(value)).toContain('A different expression');
  });
  it('renders AI text as inert text, clearly separate from mechanically sourced facts', () => {
    const value = snapshot(); value.record!.parts = [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }];
    const html = render(value);
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
    expect(html).toContain('AI 说明');
  });
  it('keeps unknown model evidence and missing references unknown, never zero', () => {
    const value = snapshot(); value.record!.parts = [{ kind: 'fact', factId: 'model' }, { kind: 'fact', factId: 'absent' }];
    const html = render(value); expect(html).toContain('未知'); expect(html).toContain('引用已失效');
    expect(html).not.toContain('<strong>0</strong>');
  });
  for (const status of ['stale', 'unavailable'] as const) it(`does not display old claims when ${status}`, () => {
    const value = snapshot(); value.status = status;
    const html = render(value); expect(html).not.toContain('Start with the source');
    expect(html).not.toContain('Synthetic bound sessions');
  });
  it('hides expired claims locally even before the next transport read', () => {
    const value = snapshot(); value.record!.expiresAt = new Date(Date.now() - 1).toISOString();
    expect(render(value)).not.toContain('Start with the source'); expect(render(value)).toContain('概览已失效');
  });
  it('has no fallback organization template or personal sample when no overview exists', () => {
    const value = snapshot(); value.status = 'missing'; value.record = null;
    const html = render(value); expect(html).toContain('尚无有效协作概览');
    expect(html).not.toContain('Synthetic bound sessions'); expect(html).not.toContain('14');
  });
});
