import { seedLegacyResource } from './legacy-fixtures.js';
import { openResources, refreshBoard, closeSettings } from './settings-helpers.js';
import { test, expect } from '@playwright/test';

test('preferences remain separate from empty resources, save, clear, and reload in both languages', async ({ page }) => {
  await page.route('**/api/board', route => route.fulfill({ json: { tasks: [], resources: [], agents: [], usages: [], entries: [], cursor: 0 } }));
  let current = { boardId: 'fixture', text: '', version: 0, source: null as string | null, updatedAt: null as string | null };
  const writes: unknown[] = [];
  await page.route('**/api/preferences', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: current });
    const input = route.request().postDataJSON(); writes.push(input);
    expect(input.expectedVersion).toBe(current.version);
    current = { ...current, text: input.text, source: input.source, version: current.version + 1, updatedAt: '2026-10-18T12:00:00Z' };
    return route.fulfill({ json: current });
  });
  await page.goto('/');
  await openResources(page);
  await expect(page.getByText('原资源记录', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '暂无资源', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '系统提示词', exact: true })).toBeVisible();
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('');
  await page.getByLabel('系统提示词内容', { exact: true }).fill('Synthetic preference for this fixture');
  await page.getByLabel('系统提示词 · 内容来源', { exact: true }).selectOption('main-chat-relay');
  await page.getByRole('button', { name: '保存系统提示词', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '系统提示词已保存。' })).toBeVisible();
  expect(writes).toEqual([{ text: 'Synthetic preference for this fixture', expectedVersion: 0, source: 'main-chat-relay' }]);
  await page.reload();
  await openResources(page);
  await expect(page.getByLabel('当前保存的系统提示词')).toContainText('主聊天转达');
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue(current.text);
  await page.getByRole('button', { name: '清空系统提示词', exact: true }).click();
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('当前保存的系统提示词')).toContainText('v2');
  expect(writes).toHaveLength(2);
  await page.goto('/?lang=en');
  await openResources(page);
  await expect(page.getByText('Original resource records', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'System prompt', exact: true })).toBeVisible();
  await expect(page.getByLabel('System prompt text', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Currently saved system prompt')).toContainText('No prompt set.');
  await expect(page.getByRole('button', { name: 'Clear system prompt', exact: true })).toBeDisabled();
});

test('conflicts retain the draft and require explicit adoption before retrying; failures do not report success', async ({ page }) => {
  let current = { boardId: 'fixture', text: 'Saved first value', version: 1, source: 'human-input', updatedAt: null };
  let attempts = 0;
  const versions: number[] = [];
  await page.route('**/api/preferences', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: current });
    attempts++; versions.push(route.request().postDataJSON().expectedVersion);
    if (attempts === 1) {
      current = { ...current, text: 'Concurrent saved value', version: 2 };
      return route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT', message: 'conflict' } } });
    }
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic write unavailable' } } });
  });
  await page.goto('/');
  await openResources(page);
  await page.getByLabel('系统提示词内容', { exact: true }).fill('My unsaved draft');
  await page.getByRole('button', { name: '保存系统提示词', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('草稿已保留');
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('My unsaved draft');
  await expect(page.getByLabel('当前保存的系统提示词')).toContainText('Concurrent saved value');
  await expect(page.getByRole('button', { name: '保存系统提示词', exact: true })).toBeDisabled();
  expect(attempts).toBe(1);
  await page.getByRole('button', { name: '按当前版本继续编辑', exact: true }).click();
  await page.getByRole('button', { name: '保存系统提示词', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic write unavailable');
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('My unsaved draft');
  await expect(page.getByText('系统提示词已保存。', { exact: true })).toHaveCount(0);
  expect(versions).toEqual([1, 2]);
  await page.locator('.preferences-panel').first().getByRole('button', { name: '放弃草稿并载入最新值', exact: true }).click();
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('Concurrent saved value');
});

test('a delayed save locks editing and duplicate submission while preserving plain-text rendering', async ({ page }) => {
  const current = { boardId: 'fixture', text: '', version: 0, source: null, updatedAt: null };
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  await page.route('**/api/preferences', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: current });
    writes++; const input = route.request().postDataJSON();
    await barrier;
    return route.fulfill({ json: { ...current, ...input, version: 1 } });
  });
  await page.goto('/');
  await openResources(page);
  const text = page.getByLabel('系统提示词内容', { exact: true });
  await text.fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: '保存系统提示词', exact: true }).click();
  await expect(text).toBeDisabled();
  await expect(page.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled();
  release();
  await expect(text).toBeEnabled();
  await expect(page.getByLabel('当前保存的系统提示词')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.getByLabel('当前保存的系统提示词').locator('img')).toHaveCount(0);
  expect(writes).toBe(1);
});

test('resource references open the original record read-only and preserve legacy fields', async ({ page, request }, testInfo) => {
  await page.route('**/api/preferences', route => route.fulfill({ json: { boardId: 'fixture', text: '', version: 0, source: null, updatedAt: null } }));
  const agent = await (await request.post('/api/agents', { data: { name: 'Resource fixture author' } })).json();
  const resource = seedLegacyResource({ name: 'Preference UI resource', kind: 'legacy-kind', capabilities: ['legacy-capability'], accessNotes: 'Coordinate before use' });
  await request.post('/api/entries', { data: { agentId: agent.id, kind: 'FACT', summary: 'Resource compatibility fixture', resourceId: resource.id } });
  await page.goto('/');
  await closeSettings(page); await page.getByRole('tab', { name: '共享面板', exact: true }).click();
  await page.getByRole('article').filter({ hasText: 'Resource compatibility fixture' })
    .getByRole('button', { name: '资源 · Preference UI resource', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看资源 Preference UI resource', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: '编辑资源 Preference UI resource', exact: true })).toHaveCount(0);
  const board = await (await request.get('/api/board')).json();
  expect(board.resources.find((item: { id: string }) => item.id === resource.id)).toMatchObject({
    id: resource.id, kind: 'legacy-kind', capabilities: ['legacy-capability'], description: ''
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '系统提示词', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('environment-mobile.png'), fullPage: true });
});

test('refresh keeps a dirty draft and displays a newer saved preference without silently rebasing', async ({ page, request }) => {
  let current = { boardId: 'fixture', text: 'Initial current', version: 1, source: 'human-input', updatedAt: null };
  await page.route('**/api/preferences', route => route.fulfill({ json: current }));
  await page.goto('/');
  await openResources(page);
  await page.getByLabel('系统提示词内容', { exact: true }).fill('Local draft to preserve');
  current = { ...current, text: 'Updated outside this form', version: 2 };
  const agent = await (await request.post('/api/agents', { data: { name: 'Refresh fixture author' } })).json();
  await request.post('/api/entries', { data: { agentId: agent.id, kind: 'FACT', summary: 'Synthetic board cursor advance' } });
  await refreshBoard(page);
  await expect(page.getByLabel('当前保存的系统提示词')).toContainText('Updated outside this form');
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('Local draft to preserve');
  await expect(page.getByRole('button', { name: '保存系统提示词', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '按当前版本继续编辑', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '保存系统提示词', exact: true })).toBeEnabled();
});

test('refresh during save retains the newer saved version after completion and another refresh', async ({ page }) => {
  let cursor = 0; let reads = 0; let writes = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let current = { boardId: 'synthetic-review', text: 'Initial value', version: 0, source: 'human-input', updatedAt: null };
  await page.route('**/api/board', route => route.fulfill({ json: { tasks: [], resources: [], agents: [], usages: [], entries: [], cursor } }));
  await page.route('**/api/preferences', async route => {
    if (route.request().method() === 'GET') { reads++; return route.fulfill({ json: current }); }
    writes++; const input = route.request().postDataJSON();
    const response = { ...current, text: input.text, version: 1 };
    await barrier;
    return route.fulfill({ json: response });
  });
  await page.goto('/');
  await openResources(page);
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('Initial value');
  await page.getByLabel('系统提示词内容', { exact: true }).fill('My saved version one');
  await page.getByRole('button', { name: '保存系统提示词', exact: true }).click();
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toBeDisabled();
  current = { ...current, text: 'Newer external version two', version: 2 }; cursor = 1;
  await refreshBoard(page);
  await expect.poll(() => reads).toBe(2);
  release();
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toBeEnabled();
  await refreshBoard(page);
  await expect(page.getByLabel('当前保存的系统提示词')).toContainText('Newer external version two');
  await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('My saved version one');
  await expect(page.getByRole('button', { name: '保存系统提示词', exact: true })).toBeDisabled();
  expect(writes).toBe(1);
});
