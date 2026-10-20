import { refreshBoard } from './settings-helpers.js';
// Exercise variable AI presentation, factual provenance and local expiry without model calls.
import { expect, test } from '@playwright/test';
import type { OverviewSnapshot } from '../../web/CollaborationOverview.js';

const makeOverview = (): OverviewSnapshot => ({
  status: 'current', reason: null,
  record: { boardId: 'synthetic-board', version: 1, authorId: 'synthetic-peer', updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(), preferencesVersion: 0, factsRevision: 'synthetic-facts', factSnapshot: [
      { id: 'bound', kind: 'count', value: 3, scope: 'Bound native sessions', source: 'Synthetic runtime binding' },
      { id: 'model', kind: 'model', value: null, scope: 'Actual external model', source: 'No runtime model observation' },
    ],
    parts: [{ kind: 'text', text: 'We are comparing alternatives' }, { kind: 'fact', factId: 'bound' }, { kind: 'fact', factId: 'model' }] },
  facts: { available: true, revision: 'synthetic-facts', observedAt: new Date().toISOString(), items: [
    { id: 'bound', kind: 'count', value: 3, scope: 'Bound native sessions', source: 'Synthetic runtime binding' },
    { id: 'model', kind: 'model', value: null, scope: 'Actual external model', source: 'No runtime model observation' },
  ] },
});
test.beforeEach(async ({ page }) => {
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', workers: [], error: '',
    pool: { id: 'synthetic-pool', size: 3, maxSize: 5, minSize: 1, enabled: true, version: 1, state: 'idle', error: '', workspacePath: '/synthetic/project' } } }));
});

test('renders a compact AI-selected line without fixed metadata and preserves safe text', async ({ page }) => {
  let value = makeOverview();
  await page.route('**/api/overview', route => route.fulfill({ json: value }));
  await page.goto('/'); const overview = page.getByRole('region', { name: '协作概览', exact: true });
  await expect(overview).toContainText('We are comparing alternatives');
  await expect(overview.locator('strong')).toHaveText(['3', '未知']);
  await expect(overview).not.toContainText('Actual external model');
  await expect(overview).not.toContainText('仅内部协作');
  await expect(overview.locator('details, small')).toHaveCount(0);
  for (const text of ['AI 说明', '概览依据', '汇报来源', '更新时间', '有效至', '采用的系统提示词版本', 'Synthetic runtime binding', 'synthetic-peer', 'Bound native sessions']) await expect(overview).not.toContainText(text);
  const line = overview.locator('.overview-line');
  const box = await line.boundingBox(); expect(box!.height).toBeLessThan(40);
  value = makeOverview(); value.record!.version++;
  value.record!.parts = [{ kind: 'fact', factId: 'model' }, { kind: 'text', text: '<img src=x onerror="window.injected=true">Different presentation' }];
  await refreshBoard(page);
  await expect(overview).toContainText('Different presentation');
  await expect(overview).not.toContainText('We are comparing alternatives');
  await expect(overview.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => 'injected' in window)).toBe(false);
  await expect(overview).not.toContainText('Bound native sessions');
  await expect(page.getByRole('button', { name: '停止协作', exact: true })).toHaveCount(0);
});

test('keeps an expired overview honestly marked as previous without requesting a model or another summary', async ({ page }) => {
  const value = makeOverview(); value.record!.expiresAt = new Date(Date.now() + 2000).toISOString();
  let reads = 0;
  await page.route('**/api/overview', route => { reads++; return route.fulfill({ json: value }); });
  await page.clock.install(); await page.goto('/');
  const overview = page.getByRole('region', { name: '协作概览', exact: true });
  await expect(overview).toContainText('We are comparing alternatives');
  await page.clock.fastForward(2500);
  await expect(overview).toHaveAttribute('data-overview-state', 'expired');
  await expect(overview).not.toContainText('上次概览');
  await expect(overview).toContainText('We are comparing alternatives');
  await expect(overview.locator('strong')).toHaveText(['3', '未知']);
  await expect(overview).not.toContainText('正常工作回合');
  expect(reads).toBe(1);
});

test('preserves previous verified values on fact changes and reports unreadable state independently', async ({ page }) => {
  const value = makeOverview();
  await page.route('**/api/overview', route => route.fulfill({ json: value }));
  await page.goto('/'); const overview = page.getByRole('region', { name: '协作概览', exact: true });
  await expect(overview).toContainText('We are comparing alternatives');
  value.status = 'stale'; value.reason = 'facts-changed'; value.facts.revision = 'new-facts'; value.facts.items[0]!.value = 9;
  await refreshBoard(page);
  await expect(overview).toHaveAttribute('data-overview-state', 'stale');
  await expect(overview).not.toContainText('上次概览');
  await expect(overview).toContainText('We are comparing alternatives');
  await expect(overview.locator('strong')).toHaveText(['3', '未知']);
  await expect(overview).not.toContainText('9');
  await page.unroute('**/api/overview');
  await page.route('**/api/overview', route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic unavailable' } } }));
  await refreshBoard(page);
  await expect(page.getByRole('alert').filter({ hasText: '协作概览暂不可核实' })).toBeVisible();
  await expect(overview.locator('.overview-fact')).toHaveCount(0);
});

test('keeps a long custom overview and capacity controls accessible on an English narrow board', async ({ page }, testInfo) => {
  const value = makeOverview(); value.record!.parts.unshift({ kind: 'text', text: 'Synthetic discussion note '.repeat(12) });
  await page.route('**/api/overview', route => route.fulfill({ json: value }));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/?lang=en');
  const overview = page.getByRole('region', { name: 'Collaboration overview', exact: true });
  await expect(overview.locator('strong')).toHaveText(['3', 'Unknown']);
  await expect(page.getByRole('button', { name: 'Stop collaboration', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add member', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Reduce member', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Reduce member', exact: true })).toBeFocused();
  await expect(overview.locator('details, small')).toHaveCount(0);
  await expect(overview).not.toContainText('No runtime model observation');
  await expect(overview).not.toContainText('Bound native sessions');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('adaptive-overview-mobile.png'), fullPage: true });
});


test('does not invent historical values on a stale first load or reuse another board snapshot', async ({ page }) => {
  let value = makeOverview(); value.status = 'stale'; value.reason = 'FACTS_CHANGED'; value.facts.revision = 'unrelated-facts';
  value.facts.items[0]!.value = 9; delete value.record!.factSnapshot;
  await page.route('**/api/overview', route => route.fulfill({ json: value }));
  await page.goto('/'); const overview = page.getByRole('region', { name: '协作概览', exact: true });
  await expect(overview).toHaveAttribute('data-overview-state', 'stale');
  await expect(overview).not.toContainText('上次概览');
  await expect(overview).toContainText('We are comparing alternatives');
  await expect(overview.locator('strong')).toHaveText(['未知', '未知']);
  value = makeOverview(); await refreshBoard(page);
  await expect(overview.locator('strong')).toHaveText(['3', '未知']);
  value.record!.boardId = 'other-board'; delete value.record!.factSnapshot; value.status = 'stale'; value.facts.revision = 'other-facts';
  await refreshBoard(page);
  await expect(overview.locator('strong')).toHaveText(['未知', '未知']);
});

test('shows current AI wording after a new revision and keeps real runtime errors separate', async ({ page }) => {
  let value = makeOverview();
  await page.route('**/api/overview', route => route.fulfill({ json: value }));
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', workers: [], error: 'Synthetic runtime connection failed',
    pool: { id: 'synthetic-pool', size: 3, maxSize: 5, minSize: 1, enabled: true, version: 1, state: 'idle', error: '', workspacePath: '/synthetic/project' } } }));
  await page.goto('/'); const overview = page.getByRole('region', { name: '协作概览', exact: true });
  await expect(overview).toContainText('We are comparing alternatives');
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic runtime connection failed' })).toBeVisible();
  value.status = 'stale'; value.reason = 'PREFERENCES_CHANGED';
  await refreshBoard(page);
  await expect(overview).toHaveAttribute('data-overview-state', 'stale');
  await expect(overview).not.toContainText('上次概览');
  value = makeOverview(); value.record!.version++; value.record!.parts = [{ kind: 'text', text: 'Reviewing the next contribution' }, { kind: 'fact', factId: 'bound' }];
  await refreshBoard(page);
  await expect(overview).toContainText('Reviewing the next contribution');
  await expect(overview).toHaveAttribute('data-overview-state', 'current');
  await expect(overview).not.toContainText('上次概览');
  value.record = null; value.status = 'missing';
  await refreshBoard(page);
  await expect(overview).toContainText('协作情况未知');
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic runtime connection failed' })).toBeVisible();
});
