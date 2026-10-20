import { refreshBoard } from './settings-helpers.js';
// Exercise the actual cards against synthetic board snapshots. Persistence and
// API authorization are verified separately; these checks start no model.
import { test, expect, type Page } from '@playwright/test';
const updatedAt = '2026-10-18T12:00:00Z';
const progress = (percent: number, state: 'active' | 'waiting') => ({ percent, state, phase: 'Independent verification', verified: 'Synthetic verified result', remaining: 'Synthetic remaining check', updatedAt, reportedBy: 'demo-reporter' });
function fixture() {
  const task = (id: string, value: ReturnType<typeof progress> | null, status = 'in_progress') => ({ id, title: `Progress fixture ${id}`, description: 'Public synthetic example', acceptanceCriteria: 'Synthetic acceptance', status, assignee: null, participants: ['demo-reporter'], version: 3, updatedAt, progress: value });
  return { tasks: [task('active', progress(70, 'active')), task('waiting', progress(35, 'waiting')), task('unknown', null), task('review', progress(100, 'active'), 'in_review')], agents: [{ id: 'demo-reporter', name: 'Demo reporter', lastSeenAt: updatedAt }], resources: [], usages: [], entries: [], cursor: 0 };
}
async function preview(page: Page) {
  const board = fixture(), writes: unknown[] = [];
  const activity = { members: 1, running: 0, idle: 1, state: 'idle', executionMode: 'internal-only', watchdog: { state: 'watching', attempts: 0, nextWakeAt: null } };
  await page.route('**/api/board', route => route.fulfill({ json: board }));
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', workers: [], error: '', pool: { id: 'preview', size: 1, enabled: true, version: 1, state: 'active', error: '' }, activity } }));
  await page.route('**/api/overview', route => route.fulfill({ json: { status: 'missing', reason: 'NO_OVERVIEW', record: null,
    facts: { revision: 'synthetic', observedAt: updatedAt, available: true, items: [] } } }));
  await page.route('**/api/tasks/*', route => {
    const patch = route.request().postDataJSON(); writes.push(patch);
    const task = board.tasks.find(item => route.request().url().endsWith(`/${item.id}`))!;
    Object.assign(task, patch, { version: task.version + 1 }); return route.fulfill({ json: task });
  });
  return { board, activity, writes };
}
const card = (page: Page, id: string) => page.locator(`[data-card-id="${id}"]`);

test('shows reported progress only in progress and keeps execution independent', async ({ page }, testInfo) => {
  const { board, activity, writes } = await preview(page); await page.goto('/');
  await expect(card(page, 'active').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '70');
  await expect(card(page, 'waiting').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
  await expect(card(page, 'waiting')).toContainText('等待中');
  await expect(card(page, 'unknown')).toContainText('待评估');
  await expect(card(page, 'unknown').getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await expect(card(page, 'unknown')).not.toContainText('0%');
  await expect(card(page, 'review').getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '协作概览', exact: true })).toContainText('协作情况未知');
  expect(await page.evaluate(async () => (await (await fetch('/api/runtime')).json()).activity)).toMatchObject({ running: 0, idle: 1 });
  await page.screenshot({ path: testInfo.outputPath('progress-three-states.png') });
  activity.running = 1; activity.idle = 0; activity.state = 'running';
  await refreshBoard(page);
  expect(await page.evaluate(async () => (await (await fetch('/api/runtime')).json()).activity)).toMatchObject({ running: 1, idle: 0 });
  await expect(card(page, 'active').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '70');
  board.tasks[0]!.progress = null;
  await refreshBoard(page);
  await expect(card(page, 'active')).toContainText('待评估');
  await expect(card(page, 'active').getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  expect(writes).toHaveLength(0);
});

test('evidence supports hover, focus and Escape separately from opening the card', async ({ page }) => {
  await preview(page); await page.goto('/');
  const evidence = card(page, 'active').locator('.task-progress-trigger');
  await evidence.hover(); const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Synthetic verified result');
  await expect(tooltip).toContainText('Synthetic remaining check');
  await expect(tooltip).toContainText('demo-reporter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('heading', { name: 'Swarmboard', exact: true }).hover();
  await evidence.focus(); await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '查看任务 Progress fixture active', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('Progress fixture active');
});

test('preserves dragging, column alignment and narrow scrolling with the evidence control', async ({ page }) => {
  const { board, writes } = await preview(page);
  for (let i = 0; i < 10; i++) board.tasks.push({ ...board.tasks[0]!, id: `overflow-${i}`, title: `Progress fixture overflow ${i}` });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await expect(card(page, 'active')).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const list = page.locator('[data-status="in_progress"] .column-list');
  expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const columns = await page.locator('.column-list').evaluateAll(items => items.map(item => { const r = item.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
  expect(Math.max(...columns.map(item => item.top)) - Math.min(...columns.map(item => item.top))).toBeLessThan(1);
  expect(Math.max(...columns.map(item => item.bottom)) - Math.min(...columns.map(item => item.bottom))).toBeLessThan(1);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: '查看任务 Progress fixture active', exact: true }).dragTo(page.locator('[data-drop-status="pending"]'));
  await page.getByRole('dialog', { name: '选择待处理状态' }).getByRole('button', { name: '待验收', exact: true }).click();
  await expect(page.locator('[data-status="pending"] [data-task-id="active"]')).toBeVisible();
  expect(writes).toEqual([{ expectedVersion: 3, status: 'in_review' }]);
  await expect(card(page, 'active').getByRole('progressbar')).toHaveCount(0);
});

test('localizes progress and evidence while leaving user text unchanged', async ({ page }, testInfo) => {
  await preview(page); await page.goto('/?lang=en');
  await expect(card(page, 'active')).toContainText('70%');
  await expect(card(page, 'waiting')).toContainText('Waiting');
  await expect(card(page, 'unknown')).toContainText('Not estimated');
  await card(page, 'active').locator('.task-progress-trigger').focus();
  await expect(page.getByRole('tooltip')).toContainText('Synthetic verified result');
  await page.screenshot({ path: testInfo.outputPath('progress-english-evidence.png') });
  expect(await page.locator('body').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
});
