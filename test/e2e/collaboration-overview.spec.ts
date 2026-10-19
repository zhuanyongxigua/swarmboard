// Exercise variable AI presentation, factual provenance and local expiry without model calls.
import { expect, test } from '@playwright/test';
import type { OverviewSnapshot } from '../../web/CollaborationOverview.js';

const makeOverview = (): OverviewSnapshot => ({
  status: 'current', reason: null,
  record: { boardId: 'synthetic-board', version: 1, authorId: 'synthetic-peer', updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(), preferencesVersion: 0, factsRevision: 'synthetic-facts',
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

test('renders two AI-selected expressions, factual scopes and safe text with keyboard evidence', async ({ page }) => {
  let value = makeOverview();
  await page.route('**/api/overview', route => route.fulfill({ json: value }));
  await page.goto('/'); const overview = page.getByRole('region', { name: '协作概览', exact: true });
  await expect(overview).toContainText('We are comparing alternatives');
  await expect(overview).toContainText('Bound native sessions 3');
  await expect(overview).toContainText('Actual external model 未知');
  await expect(overview).not.toContainText('仅内部协作');
  await overview.getByText('概览依据', { exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(overview).toContainText('Synthetic runtime binding');
  await expect(overview).toContainText('synthetic-peer');
  value = makeOverview(); value.record!.version++;
  value.record!.parts = [{ kind: 'fact', factId: 'model' }, { kind: 'text', text: '<img src=x onerror="window.injected=true">Different presentation' }];
  await page.getByRole('button', { name: '刷新面板', exact: true }).click();
  await expect(overview).toContainText('Different presentation');
  await expect(overview).not.toContainText('We are comparing alternatives');
  await expect(overview.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => 'injected' in window)).toBe(false);
  await expect(overview).not.toContainText('Bound native sessions');
  await expect(page.getByRole('button', { name: '停止协作', exact: true })).toHaveCount(0);
});

test('hides an expired overview locally without requesting a model or another summary', async ({ page }) => {
  const value = makeOverview(); value.record!.expiresAt = new Date(Date.now() + 2000).toISOString();
  let reads = 0;
  await page.route('**/api/overview', route => { reads++; return route.fulfill({ json: value }); });
  await page.clock.install(); await page.goto('/');
  const overview = page.getByRole('region', { name: '协作概览', exact: true });
  await expect(overview).toContainText('We are comparing alternatives');
  await page.clock.fastForward(2500);
  await expect(overview).toContainText('概览已失效');
  await expect(overview).not.toContainText('We are comparing alternatives');
  await expect(overview.locator('.overview-fact')).toHaveCount(0);
  expect(reads).toBe(1);
});

test('replaces stale or unreadable summaries with honest unavailable state', async ({ page }) => {
  const value = makeOverview();
  await page.route('**/api/overview', route => route.fulfill({ json: value }));
  await page.goto('/'); const overview = page.getByRole('region', { name: '协作概览', exact: true });
  await expect(overview).toContainText('We are comparing alternatives');
  value.status = 'stale'; value.reason = 'facts-changed';
  await page.getByRole('button', { name: '刷新面板', exact: true }).click();
  await expect(overview).toContainText('概览已失效');
  await expect(overview).not.toContainText('We are comparing alternatives');
  await page.unroute('**/api/overview');
  await page.route('**/api/overview', route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic unavailable' } } }));
  await page.getByRole('button', { name: '刷新面板', exact: true }).click();
  await expect(overview).toContainText('协作概览暂不可核实');
  await expect(overview.locator('.overview-fact')).toHaveCount(0);
});

test('keeps a long custom overview and capacity controls accessible on an English narrow board', async ({ page }, testInfo) => {
  const value = makeOverview(); value.record!.parts.unshift({ kind: 'text', text: 'Synthetic discussion note '.repeat(12) });
  await page.route('**/api/overview', route => route.fulfill({ json: value }));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/?lang=en');
  const overview = page.getByRole('region', { name: 'Collaboration overview', exact: true });
  await expect(overview).toContainText('Actual external model Unknown');
  await expect(page.getByRole('button', { name: 'Stop collaboration', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add member', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Reduce member', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Reduce member', exact: true })).toBeFocused();
  await overview.getByText('Overview evidence', { exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(overview).toContainText('No runtime model observation');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('adaptive-overview-mobile.png'), fullPage: true });
});
